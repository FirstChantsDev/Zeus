import http from 'http';
import fs from 'fs';
import path from 'path';
import { Logger } from './Logger';
import { Condition, MAX_CONDITIONS } from '../conditions';
import { listRecords, readRecord, computeMetrics } from './MeetingRecord';

/**
 * CockpitServer is the owner's private window into the running agent.
 *
 * It lives INSIDE the bot process (no second service, no database) and
 * does two jobs:
 *
 *   1. Keeps the live meeting state in memory: the transcript so far and
 *      every nudge the agent has fired. (The conditions array itself is
 *      shared with the Nudger, which mutates it.)
 *   2. Runs a tiny web server — GET / serves the cockpit page, and
 *      GET /state answers with the current state as JSON, which the page
 *      polls every ~1.5 seconds.
 *
 * Built on Node's built-in http module — no dependencies, per project
 * constraints.
 */

/** One cleaned caption line, plus whether it settled a condition */
export type TranscriptRecord = {
    speaker: string;
    text: string;
    ts: string;
    /** true if this line closed one of the owner's conditions */
    hit: boolean;
};

/** The owner's typed brief, exactly as submitted from the briefing screen */
export type Brief = {
    meetingName: string;
    /** 1-3 free-text condition labels, any wording */
    labels: string[];
    /** Optional extra guidance for the agent ("Maya holds the budget") */
    context: string;
    /** Phase 4: the meeting's scheduled length in minutes (default 30) */
    lengthMinutes: number;
    /** Phase 5: the owner's name, so the agent can flag when the room needs them ('' if not given) */
    ownerName: string;
};

/** A live board change made from the cockpit (edit an existing condition, or add one) */
export type ConditionChange =
    | { kind: 'edited', id: string, before: string, after: string, reopened: boolean }
    | { kind: 'added', id: string, label: string };

/** Phase 5: one moment the room named the owner in a way that needs them */
export type MentionRecord = {
    speaker: string;
    /** Their exact words, verbatim from the transcript */
    quote: string;
    at: string;
};

/** One nudge the agent posted to the meeting chat */
export type NudgeRecord = {
    text: string;
    /** The condition it pushes on — null for a pure owner directive */
    conditionId: string | null;
    at: string;
    /** true if the owner's private steer produced this message */
    steered: boolean;
};

export class CockpitServer {
    /** Keep at most this many transcript lines in memory */
    private static readonly MAX_TRANSCRIPT_LINES = 200;

    private readonly conditions: Condition[];
    private readonly port: number;
    private readonly logger: Logger;
    private readonly startedAt = new Date().toISOString();
    /** Phase 5: the Teams link the bot was launched with — the Join call button opens it */
    private readonly meetingUrl: string;
    /** Called with the owner's instruction the moment POST /command receives one */
    private readonly onCommand: (instruction: string) => void;
    /** Called ONCE with the owner's brief when POST /setup accepts it */
    private readonly onSetup: (brief: Brief) => void;
    /** Kill switch: called when the owner presses the cockpit's Kill bot button */
    private readonly onShutdown: () => void;
    /** Live condition editing: called after POST /conditions mutates the board,
     *  so the caller can audit-log the change and re-judge the transcript. */
    private readonly onConditionsChanged: (change: ConditionChange) => void;

    private meetingStatus: 'connecting' | 'lobby' | 'in-meeting' | 'unknown' = 'connecting';
    private briefed = false;
    private briefedAt: string | null = null;
    private meetingName: string | null = null;
    /** Phase 4: scheduled length from the brief, and when the bot got into the room */
    private scheduledMinutes = 30;
    private meetingJoinedAt: string | null = null;
    private readonly transcript: TranscriptRecord[] = [];
    private readonly nudges: NudgeRecord[] = [];
    /** Phase 5: moments the room said it needs the owner */
    private readonly mentions: MentionRecord[] = [];
    private ownerName = '';

    constructor(args: {
        botId: string,
        conditions: Condition[],
        port: number,
        meetingUrl: string,
        onCommand: (instruction: string) => void,
        onSetup: (brief: Brief) => void,
        onShutdown: () => void,
        onConditionsChanged?: (change: ConditionChange) => void,
    }) {
        this.conditions = args.conditions;
        this.port = args.port;
        this.meetingUrl = args.meetingUrl;
        this.onCommand = args.onCommand;
        this.onSetup = args.onSetup;
        this.onShutdown = args.onShutdown;
        this.onConditionsChanged = args.onConditionsChanged ?? (() => { /* nothing to notify */ });
        this.logger = new Logger({ source: 'cockpit-server', botId: args.botId });
    }

    /**
     * ================================================
     * State updates (called from gate.ts as the meeting runs)
     * ================================================
     */

    /** Records a finished caption line. Returns the record so the caller can flag it as a hit later. */
    public addTranscriptLine(line: { speaker: string, text: string, ts: string }): TranscriptRecord {
        const record: TranscriptRecord = { ...line, hit: false };
        this.transcript.push(record);
        if (this.transcript.length > CockpitServer.MAX_TRANSCRIPT_LINES) {
            this.transcript.shift();
        }
        return record;
    }

    /** Records a nudge the agent fired */
    public addNudge(nudge: { text: string, conditionId: string | null, steered?: boolean }) {
        this.nudges.push({
            text: nudge.text,
            conditionId: nudge.conditionId,
            steered: nudge.steered ?? false,
            at: new Date().toISOString(),
        });
    }

    /** The last few transcript lines — context for steer execution */
    public recentTranscript(count: number): TranscriptRecord[] {
        return this.transcript.slice(-count);
    }

    /** Phase 5: records that the room named the owner in a way that needs them */
    public addMention(mention: { speaker: string, quote: string }) {
        // The same remark can be re-reported if captions repeat — keep it once.
        const duplicate = this.mentions.some((m) => m.speaker === mention.speaker && m.quote === mention.quote);
        if (duplicate) {
            return;
        }
        this.mentions.push({ ...mention, at: new Date().toISOString() });
    }

    /** Lets the cockpit header show where the agent is (lobby / in meeting) */
    public setMeetingStatus(status: 'connecting' | 'lobby' | 'in-meeting' | 'unknown') {
        // Phase 4: the meeting clock starts the first time the bot is in the room.
        if (status === 'in-meeting' && !this.meetingJoinedAt) {
            this.meetingJoinedAt = new Date().toISOString();
        }
        this.meetingStatus = status;
    }

    /**
     * Phase 4: where the meeting stands against its scheduled length —
     * fed into the agent's decision prompt so nudges get more urgent as
     * time runs out. remainingMinutes is null until the bot is in the
     * meeting, and goes negative once the meeting runs over.
     */
    public timeState(): { scheduledMinutes: number, remainingMinutes: number | null } {
        if (!this.meetingJoinedAt) {
            return { scheduledMinutes: this.scheduledMinutes, remainingMinutes: null };
        }
        const elapsedMinutes = (Date.now() - Date.parse(this.meetingJoinedAt)) / 60000;
        return { scheduledMinutes: this.scheduledMinutes, remainingMinutes: this.scheduledMinutes - elapsedMinutes };
    }

    /**
     * ================================================
     * The web server
     * ================================================
     */

    public start() {
        const server = http.createServer((req, res) => {
            const url = (req.url ?? '/').split('?')[0];
            if (url === '/' || url === '/index.html') {
                this._serveCockpitPage(res);
            } else if (url === '/state') {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify(this._buildState()));
            } else if (url === '/command' && req.method === 'POST') {
                this._handleCommand(req, res);
            } else if (url === '/setup' && req.method === 'POST') {
                this._handleSetup(req, res);
            } else if (url === '/conditions' && req.method === 'POST') {
                this._handleConditions(req, res);
            } else if (url === '/history') {
                const entries = listRecords();
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ entries, metrics: computeMetrics(entries) }));
            } else if (url.startsWith('/history/')) {
                const record = readRecord(url.slice('/history/'.length));
                res.writeHead(record ? 200 : 404, { 'content-type': 'application/json' });
                res.end(JSON.stringify(record ?? { ok: false, error: 'record not found' }));
            } else if (url === '/shutdown' && req.method === 'POST') {
                // The kill switch. Answer first so the page hears the "ok"
                // before the process (and this server with it) goes away.
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
                console.log('\nKILL >>> shutdown requested from the cockpit.');
                setTimeout(() => this.onShutdown(), 300);
            } else {
                res.writeHead(404, { 'content-type': 'text/plain' });
                res.end('Not found');
            }
        });

        server.on('error', (error) => {
            // A cockpit problem must never take the bot down mid-meeting.
            this.logger.error({ message: `Cockpit server error (is port ${this.port} already in use?)`, data: error });
        });

        server.listen(this.port, () => {
            console.log(`\n>>> COCKPIT: open http://localhost:${this.port} in your browser <<<\n`);
        });
    }

    /**
     * Receives the owner's brief from the briefing screen:
     * POST /setup with {"meetingName": "...", "conditions": ["...", ...], "context": "..."}
     * Accepts 1-3 free-text condition labels. Only the FIRST brief counts —
     * re-briefing mid-run is rejected so the board and feed never disagree.
     */
    private _handleSetup(req: http.IncomingMessage, res: http.ServerResponse) {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            const answer = (code: number, payload: object) => {
                res.writeHead(code, { 'content-type': 'application/json' });
                res.end(JSON.stringify(payload));
            };
            if (this.briefed) {
                answer(409, { ok: false, error: 'Agent is already briefed — restart the bot to brief it again.' });
                return;
            }
            try {
                const parsed = JSON.parse(body) as { meetingName?: unknown, conditions?: unknown, context?: unknown, lengthMinutes?: unknown, ownerName?: unknown };
                const labels = (Array.isArray(parsed.conditions) ? parsed.conditions : [])
                    .filter((label): label is string => typeof label === 'string')
                    .map((label) => label.trim())
                    .filter(Boolean);
                if (labels.length < 1 || labels.length > MAX_CONDITIONS) {
                    answer(400, { ok: false, error: `Give the agent 1 to ${MAX_CONDITIONS} conditions.` });
                    return;
                }
                const meetingName = (typeof parsed.meetingName === 'string' && parsed.meetingName.trim())
                    ? parsed.meetingName.trim()
                    : 'Untitled meeting';
                const context = typeof parsed.context === 'string' ? parsed.context.trim() : '';
                // Phase 4: scheduled length in minutes — default 30, clamped to something sane.
                const rawLength = Number(parsed.lengthMinutes);
                const lengthMinutes = Number.isFinite(rawLength) && rawLength > 0
                    ? Math.min(480, Math.max(1, Math.round(rawLength)))
                    : 30;

                // Phase 5: the owner's name — optional, '' when left blank.
                const ownerName = typeof parsed.ownerName === 'string' ? parsed.ownerName.trim() : '';

                this.briefed = true;
                this.briefedAt = new Date().toISOString();
                this.meetingName = meetingName;
                this.scheduledMinutes = lengthMinutes;
                this.ownerName = ownerName;
                this.onSetup({ meetingName, labels, context, lengthMinutes, ownerName }); // populates the shared conditions array
                answer(200, { ok: true });
            } catch {
                answer(400, { ok: false, error: 'body must be JSON' });
            }
        });
    }

    /** Receives the owner's private steer: POST /command with {"instruction": "..."} */
    private _handleCommand(req: http.IncomingMessage, res: http.ServerResponse) {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            if (!this.briefed) {
                res.writeHead(409, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Brief the agent first — it is not in the meeting yet.' }));
                return;
            }
            try {
                const parsed = JSON.parse(body) as { instruction?: unknown };
                const instruction = typeof parsed.instruction === 'string' ? parsed.instruction.trim() : '';
                if (!instruction) {
                    res.writeHead(400, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: 'instruction required' }));
                    return;
                }
                console.log(`STEER >>> ${instruction}`);
                this.onCommand(instruction); // acted on immediately; the feed shows the result
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
            } catch {
                res.writeHead(400, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'body must be JSON' }));
            }
        });
    }

    /**
     * Live condition editing (POST /conditions):
     *   {op:'edit', id, label} — rewords a condition. Editing a CLOSED one
     *   reopens it for re-evaluation with a fresh slate (note/why/evidence
     *   cleared, nudge count reset so it doesn't instantly flag NEEDS YOU).
     *   {op:'add', label}      — adds a condition, up to MAX_CONDITIONS.
     * The onConditionsChanged callback lets the bot audit-log the change
     * and immediately re-judge the whole transcript.
     */
    private _handleConditions(req: http.IncomingMessage, res: http.ServerResponse) {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            const answer = (code: number, payload: object) => {
                res.writeHead(code, { 'content-type': 'application/json' });
                res.end(JSON.stringify(payload));
            };
            if (!this.briefed) {
                answer(409, { ok: false, error: 'Brief the agent first.' });
                return;
            }
            try {
                const parsed = JSON.parse(body) as { op?: unknown, id?: unknown, label?: unknown };
                const label = typeof parsed.label === 'string' ? parsed.label.trim() : '';
                if (!label) {
                    answer(400, { ok: false, error: 'The condition needs some words.' });
                    return;
                }
                if (parsed.op === 'edit') {
                    const condition = this.conditions.find((c) => c.id === parsed.id);
                    if (!condition) {
                        answer(404, { ok: false, error: 'No such condition.' });
                        return;
                    }
                    const before = condition.label;
                    if (before === label) {
                        answer(200, { ok: true }); // nothing changed — no event, no re-judge
                        return;
                    }
                    const reopened = condition.status === 'closed';
                    condition.label = label;
                    if (reopened) {
                        condition.status = 'open';
                        condition.nudges = 0;
                        delete condition.note;
                        delete condition.why;
                        delete condition.evidence;
                    }
                    console.log(`CONDITION EDITED >>> ${condition.id}: "${before}" → "${label}"${reopened ? ' (reopened)' : ''}`);
                    this.onConditionsChanged({ kind: 'edited', id: condition.id, before, after: label, reopened });
                    answer(200, { ok: true });
                } else if (parsed.op === 'add') {
                    if (this.conditions.length >= MAX_CONDITIONS) {
                        answer(400, { ok: false, error: `The board is full — the agent tracks at most ${MAX_CONDITIONS} conditions.` });
                        return;
                    }
                    // Next free cN id (ids are never reused within a meeting).
                    const nextIndex = this.conditions.reduce((max, c) => {
                        const n = /^c(\d+)$/.exec(c.id);
                        return n ? Math.max(max, Number(n[1]) + 1) : max;
                    }, this.conditions.length);
                    const condition: Condition = { id: `c${nextIndex}`, label, status: 'open', nudges: 0 };
                    this.conditions.push(condition);
                    console.log(`CONDITION ADDED >>> ${condition.id}: "${label}"`);
                    this.onConditionsChanged({ kind: 'added', id: condition.id, label });
                    answer(200, { ok: true });
                } else {
                    answer(400, { ok: false, error: 'op must be "edit" or "add"' });
                }
            } catch {
                answer(400, { ok: false, error: 'body must be JSON' });
            }
        });
    }

    /** Reads the page from disk on every request, so page edits show up on refresh without restarting the bot */
    private _serveCockpitPage(res: http.ServerResponse) {
        // Like the rest of the project (output/logs, output/transcripts),
        // paths are relative to the repo root the bot is started from.
        // __dirname only exists when compiled the old (CommonJS) way; under
        // tsx the process cwd is the repo root, so fall back to that.
        const pagePath = typeof __dirname !== 'undefined'
            ? path.join(__dirname, '..', 'cockpit.html')
            : path.join(process.cwd(), 'apps', 'teams-bot', 'src', 'cockpit.html');
        fs.readFile(pagePath, (error, html) => {
            if (error) {
                this.logger.error({ message: 'Could not read cockpit.html', data: error });
                res.writeHead(500, { 'content-type': 'text/plain' });
                res.end('cockpit.html is missing');
                return;
            }
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(html);
        });
    }

    /** Work out each nudge's fate from current condition state:
     *    sent    — a pure owner directive, not tied to any condition
     *    landed  — the condition it pushed on is now closed
     *    ignored — still open AND the agent has since nudged it again
     *    waiting — still open, this is the latest nudge about it
     *  Chronological order (the feed reverses it; the record keeps it). */
    private _nudgesWithFates() {
        return this.nudges.map((nudge, index) => {
            const condition = nudge.conditionId === null
                ? undefined
                : this.conditions.find((c) => c.id === nudge.conditionId);
            let status: 'sent' | 'landed' | 'ignored' | 'waiting';
            if (nudge.conditionId === null) {
                status = 'sent';
            } else if (condition?.status === 'closed') {
                status = 'landed';
            } else if (this.nudges.some((other, otherIndex) => otherIndex > index && other.conditionId === nudge.conditionId)) {
                status = 'ignored';
            } else {
                status = 'waiting';
            }
            return {
                ...nudge,
                conditionLabel: condition?.label ?? 'your steer',
                status,
            };
        });
    }

    /** Everything the meeting's persisted record needs at end-of-meeting */
    public snapshotForRecord() {
        return {
            conditions: this.conditions.map((c) => ({ ...c })),
            nudges: this._nudgesWithFates(), // chronological, fates final
            mentions: [...this.mentions],
        };
    }

    /** Assembles the JSON snapshot the cockpit page polls */
    private _buildState() {
        const nudgesWithStatus = this._nudgesWithFates().reverse(); // newest first, ready for the feed

        return {
            startedAt: this.startedAt,
            meetingStatus: this.meetingStatus,
            // Until briefed the agent has no conditions and won't join —
            // the page keeps showing the briefing screen while this is false.
            briefed: this.briefed,
            briefedAt: this.briefedAt,
            meetingName: this.meetingName,
            // Phase 4: drives the header countdown. meetingJoinedAt is null
            // until the bot is actually in the room.
            scheduledMinutes: this.scheduledMinutes,
            meetingJoinedAt: this.meetingJoinedAt,
            conditions: this.conditions,
            nudges: nudgesWithStatus,
            transcript: this.transcript,
            // Phase 5: owner identity + moments the room said it needs them (newest first).
            ownerName: this.ownerName,
            mentions: [...this.mentions].reverse(),
            // Phase 5: lets the owner join the meeting as themselves.
            meetingUrl: this.meetingUrl,
            // Local bot only: tells the page to show the Kill bot button.
            // The hosted cockpit server never sets this — the cloud bot has
            // its own automatic wrap-up and the Railway Stop button.
            canShutdown: true,
        };
    }
}
