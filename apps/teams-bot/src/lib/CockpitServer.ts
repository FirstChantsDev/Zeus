import http from 'http';
import fs from 'fs';
import path from 'path';
import { Logger } from './Logger';
import { Condition } from '../conditions';

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
    /** Called with the owner's instruction the moment POST /command receives one */
    private readonly onCommand: (instruction: string) => void;

    private meetingStatus: 'connecting' | 'lobby' | 'in-meeting' | 'unknown' = 'connecting';
    private readonly transcript: TranscriptRecord[] = [];
    private readonly nudges: NudgeRecord[] = [];

    constructor(args: { botId: string, conditions: Condition[], port: number, onCommand: (instruction: string) => void }) {
        this.conditions = args.conditions;
        this.port = args.port;
        this.onCommand = args.onCommand;
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

    /** Lets the cockpit header show where the agent is (lobby / in meeting) */
    public setMeetingStatus(status: 'connecting' | 'lobby' | 'in-meeting' | 'unknown') {
        this.meetingStatus = status;
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

    /** Receives the owner's private steer: POST /command with {"instruction": "..."} */
    private _handleCommand(req: http.IncomingMessage, res: http.ServerResponse) {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
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

    /** Assembles the JSON snapshot the cockpit page polls */
    private _buildState() {
        // Work out each nudge's fate from current condition state:
        //   sent    — a pure owner directive, not tied to any condition
        //   landed  — the condition it pushed on is now closed
        //   ignored — still open AND the agent has since nudged it again
        //   waiting — still open, this is the latest nudge about it
        const nudgesWithStatus = this.nudges.map((nudge, index) => {
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
        }).reverse(); // newest first, ready for the feed

        return {
            startedAt: this.startedAt,
            meetingStatus: this.meetingStatus,
            conditions: this.conditions,
            nudges: nudgesWithStatus,
            transcript: this.transcript,
        };
    }
}
