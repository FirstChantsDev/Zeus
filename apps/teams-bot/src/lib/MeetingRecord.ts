import fs from 'fs';
import path from 'path';

/**
 * MeetingRecord is the audit trail for one meeting - the project's first
 * durable state.
 *
 * Events are appended AS THEY HAPPEN (never reconstructed afterwards):
 * the brief, the join, every condition close (with its verbatim evidence),
 * every nudge, steer, mid-call condition edit/addition, owner mention,
 * and the end of the meeting. When the meeting ends the record - events
 * plus the final board, the nudge log with outcomes, the participants
 * seen, and the plain-English summary - is written to ONE JSON file per
 * meeting in the records directory.
 *
 * Scope honesty (documented in NOTES.md): this is a faithful, persisted,
 * readable history. It is NOT tamper-proof or cryptographically signed -
 * that is a deliberately parked, enterprise-grade later phase.
 *
 * The full transcript is deliberately NOT stored: the evidence quotes on
 * each condition carry the load-bearing words, and keeping whole
 * conversations on disk is a bigger privacy decision than this phase needs.
 */

/** One timestamped entry in the audit trail */
export type AuditEvent = {
    at: string;
    type:
        | 'meeting-briefed'
        | 'meeting-joined'
        | 'speaker-seen'
        | 'condition-closed'
        | 'condition-revised'
        | 'condition-reopened'
        | 'condition-edited'
        | 'condition-added'
        | 'nudge-sent'
        | 'steer-received'
        | 'owner-mentioned'
        | 'meeting-ended'
        // Phase 14: the owner's verdicts on drafted follow-up actions
        | 'action-approved'
        | 'action-dismissed'
        | 'action-edited'
        | 'action-toggled';
    /** Human-readable one-liner, so the history view needs no per-type logic */
    detail: string;
    /** Type-specific extras (before/after text, quotes, ...) */
    data?: Record<string, unknown>;
};

/** Phase 14: one drafted follow-up action, generated from the finished
 *  record and shown for the owner's approval. NOTHING is ever sent without
 *  an explicit approval tap (Milestone 2+); in Milestone 1 these are
 *  display-only drafts. */
export type MeetingAction = {
    id: string; // a1, a2, ... within the record
    type: 'email' | 'calendar' | 'share';
    /** One-line headline for the card */
    title: string;
    /** The full draft, written in the OWNER'S voice (email text, or the
     *  invite description for calendar actions) */
    body: string;
    /** The decision or open condition that caused this action, quoted */
    source: string;
    /** Suggested recipients - calendar attendees carry emails; names heard
     *  in the room may have none (owner fills them in when sending) */
    recipients: Array<{ name: string, email: string | null }>;
    /** calendar actions: suggested length of the follow-up */
    suggestedDurationMinutes?: number | null;
    /** calendar actions: whether the booked follow-up carries a pre-briefed
     *  agent (the Add Clarus toggle - default on; every flip is recorded) */
    addClarus?: boolean;
    /** The owner's verdict. Approving hands them the sendable content;
     *  nothing is ever sent without that explicit tap. */
    status: 'proposed' | 'approved' | 'dismissed';
};

/** One person on the calendar event's attendee list (Calendars.Read already
 *  returns these - no scope change) */
export type Attendee = { name: string, email: string | null };

/** The finished, persisted record of one meeting */
export type MeetingRecordFile = {
    /** Record-format version, for future readers */
    v: 1;
    id: string;
    meetingName: string;
    ownerName: string;
    briefedAt: string;
    endedAt: string;
    durationMinutes: number | null; // null if the bot never made it into the room
    scheduledMinutes: number;
    endReason: string;
    participants: string[];
    /** The final board: label, open/closed, note, why, evidence, nudges */
    conditions: Array<Record<string, unknown>>;
    /** Every message posted, with its fate (landed/ignored/waiting/sent) */
    nudges: Array<Record<string, unknown>>;
    /** Times the room said it needs the owner */
    mentions: Array<Record<string, unknown>>;
    /** Whether any condition was edited or added mid-call */
    editedMidCall: boolean;
    /** The one-call plain-English summary; null if it could not be generated */
    summary: string | null;
    /** Phase 14: the calendar event's attendees, when the meeting was picked
     *  from the calendar (empty for pasted links) */
    attendees?: Attendee[];
    /** Phase 14: drafted follow-up actions awaiting the owner (may be empty -
     *  an honest "nothing to do" beats filler). Missing on pre-Phase-14 records. */
    actions?: MeetingAction[];
    events: AuditEvent[];
};

/** Where record files live: <repo>/records, or ZEUS_RECORDS_DIR */
export const recordsDir = (): string =>
    process.env.ZEUS_RECORDS_DIR || path.join(process.cwd(), 'records');

export class MeetingRecord {
    public readonly events: AuditEvent[] = [];
    private readonly seenSpeakers = new Set<string>();
    private readonly id: string;
    private meetingName = 'Untitled meeting';
    private ownerName = '';
    private briefedAt = new Date().toISOString();
    private scheduledMinutes = 30;
    private joinedAt: string | null = null;
    /** Phase 14: the calendar event's attendee list (empty for pasted links) */
    private attendees: Attendee[] = [];

    constructor(id: string) {
        this.id = id;
    }

    /** Appends one event, timestamped now. */
    public log(type: AuditEvent['type'], detail: string, data?: Record<string, unknown>) {
        this.events.push({ at: new Date().toISOString(), type, detail, ...(data ? { data } : {}) });
    }

    public briefed(brief: { meetingName: string, ownerName: string, labels: string[], context: string, lengthMinutes: number, attendees?: Attendee[] }) {
        this.meetingName = brief.meetingName;
        this.ownerName = brief.ownerName;
        this.scheduledMinutes = brief.lengthMinutes;
        this.attendees = brief.attendees ?? [];
        this.briefedAt = new Date().toISOString();
        this.log('meeting-briefed', `Briefed: "${brief.meetingName}" (${brief.lengthMinutes} min) - ${brief.labels.join(' | ')}`, {
            labels: brief.labels,
            context: brief.context,
        });
    }

    /** Phase 14: late attendee enrichment (e.g. fetched by event id after the
     *  brief was accepted). Safe any time before the record is built. */
    public setAttendees(list: Attendee[]) {
        if (list.length) this.attendees = list;
    }

    public joined() {
        if (this.joinedAt) return; // breakout-room style re-entries are not a second join
        this.joinedAt = new Date().toISOString();
        this.log('meeting-joined', 'The agent was admitted to the meeting.');
    }

    /** Call for every transcript line: first appearance of a speaker is a participant event. */
    public sawSpeaker(speaker: string) {
        const name = speaker.trim();
        if (!name || this.seenSpeakers.has(name)) return;
        this.seenSpeakers.add(name);
        this.log('speaker-seen', `${name} spoke for the first time.`, { speaker: name });
    }

    /** Everything the end-of-meeting summary call needs */
    public summaryInput() {
        return {
            meetingName: this.meetingName,
            ownerName: this.ownerName,
            attendees: this.attendees,
            participants: [...this.seenSpeakers],
            durationMinutes: this.joinedAt
                ? Math.round((Date.now() - Date.parse(this.joinedAt)) / 60000)
                : null,
            events: this.events.map(({ at, type, detail }) => ({ at, type, detail })),
        };
    }

    /** True once any condition-edited / condition-added event exists */
    public get editedMidCall(): boolean {
        return this.events.some((e) => e.type === 'condition-edited' || e.type === 'condition-added');
    }

    /**
     * Assembles the final record (the cloud bot sends this to the hub,
     * which persists it; the local bot writes it itself via save()).
     */
    public build(args: {
        endReason: string,
        conditions: Array<Record<string, unknown>>,
        nudges: Array<Record<string, unknown>>,
        mentions: Array<Record<string, unknown>>,
        summary: string | null,
        actions?: MeetingAction[],
    }): MeetingRecordFile {
        const endedAt = new Date().toISOString();
        this.log('meeting-ended', `Meeting ended: ${args.endReason}.`, { reason: args.endReason });
        const record: MeetingRecordFile = {
            v: 1,
            id: this.id,
            meetingName: this.meetingName,
            ownerName: this.ownerName,
            briefedAt: this.briefedAt,
            endedAt,
            durationMinutes: this.joinedAt
                ? Math.round((Date.parse(endedAt) - Date.parse(this.joinedAt)) / 60000)
                : null,
            scheduledMinutes: this.scheduledMinutes,
            endReason: args.endReason,
            participants: [...this.seenSpeakers],
            conditions: args.conditions,
            nudges: args.nudges,
            mentions: args.mentions,
            editedMidCall: this.editedMidCall,
            summary: args.summary,
            attendees: this.attendees,
            actions: args.actions ?? [],
            events: this.events,
        };
        return record;
    }

    /**
     * Builds the final record and writes it to <dir>/<endedAt>-<id>.json.
     * Returns the full path written. Never throws - a persistence failure
     * must not take down a meeting that otherwise ended cleanly.
     */
    public save(args: Parameters<MeetingRecord['build']>[0] & { dir?: string }): string | null {
        const record = this.build(args);
        return writeRecordFile(record, args.dir);
    }
}

/** Writes one finished record to disk; shared by the local bot and the hub path. */
export const writeRecordFile = (record: MeetingRecordFile, dir?: string): string | null => {
    try {
        const base = dir ?? recordsDir();
        fs.mkdirSync(base, { recursive: true });
        const file = path.join(base, `${record.endedAt.replace(/[:.]/g, '-')}-${record.id}.json`);
        fs.writeFileSync(file, JSON.stringify(record, null, 2));
        console.log(`RECORD SAVED >>> ${file}`);
        return file;
    } catch (error) {
        console.error('RECORD SAVE FAILED >>>', error);
        return null;
    }
};

/**
 * ================================================
 * Reading history back (used by the /history endpoints)
 * ================================================
 */

/** One row in the history list */
export type HistoryEntry = {
    file: string; // the record's filename - the ID used by /history/<file>
    meetingName: string;
    ownerName: string;
    endedAt: string;
    durationMinutes: number | null;
    conditionsTotal: number;
    conditionsClosed: number;
    editedMidCall: boolean;
    hasSummary: boolean;
};

/** All records in the directory, newest first. Unreadable files are skipped. */
export const listRecords = (dir?: string): HistoryEntry[] => {
    const base = dir ?? recordsDir();
    let files: string[] = [];
    try {
        files = fs.readdirSync(base).filter((f) => f.endsWith('.json'));
    } catch {
        return []; // no records directory yet - no history
    }
    const entries: HistoryEntry[] = [];
    for (const file of files) {
        try {
            const record = JSON.parse(fs.readFileSync(path.join(base, file), 'utf8')) as MeetingRecordFile;
            entries.push({
                file,
                meetingName: record.meetingName ?? 'Untitled meeting',
                ownerName: record.ownerName ?? '',
                endedAt: record.endedAt ?? '',
                durationMinutes: record.durationMinutes ?? null,
                conditionsTotal: (record.conditions ?? []).length,
                conditionsClosed: (record.conditions ?? []).filter((c) => c.status === 'closed').length,
                editedMidCall: Boolean(record.editedMidCall),
                hasSummary: Boolean(record.summary),
            });
        } catch { /* a corrupt file must not break the whole history */ }
    }
    return entries.sort((a, b) => b.endedAt.localeCompare(a.endedAt));
};

/** One full record by filename; null if missing/unreadable. Filename is validated - no path tricks. */
export const readRecord = (file: string, dir?: string): MeetingRecordFile | null => {
    if (!/^[0-9A-Za-z\-]+\.json$/.test(file)) return null;
    try {
        return JSON.parse(fs.readFileSync(path.join(dir ?? recordsDir(), file), 'utf8')) as MeetingRecordFile;
    } catch {
        return null;
    }
};

/**
 * Phase 14 Milestone 2: applies one owner verdict (approve / dismiss /
 * edit / Add-Clarus toggle) to an action inside a saved record, appending
 * the matching audit event, and writes the file back in place.
 * The hub carries a plain-JS mirror of this - change BOTH.
 */
export const applyActionUpdate = (
    file: string,
    update: { actionId: string, op: string, body?: unknown, addClarus?: unknown },
    dir?: string,
): { ok: true, record: MeetingRecordFile } | { ok: false, status: number, error: string } => {
    const record = readRecord(file, dir);
    if (!record) return { ok: false, status: 404, error: 'record not found' };
    const action = (record.actions ?? []).find((a) => a.id === update.actionId);
    if (!action) return { ok: false, status: 404, error: 'action not found' };
    const stamp = (type: AuditEvent['type'], detail: string, data?: Record<string, unknown>) => {
        record.events.push({ at: new Date().toISOString(), type, detail, ...(data ? { data } : {}) });
    };
    if (update.op === 'edit') {
        if (action.status !== 'proposed') return { ok: false, status: 409, error: 'only a proposed action can be edited' };
        const body = typeof update.body === 'string' ? update.body.trim() : '';
        if (!body) return { ok: false, status: 400, error: 'the edited draft cannot be empty' };
        stamp('action-edited', `Action draft edited: [${action.type}] ${action.title}`, { actionId: action.id, before: action.body, after: body });
        action.body = body;
    } else if (update.op === 'approve') {
        if (action.status === 'dismissed') return { ok: false, status: 409, error: 'this action was dismissed' };
        if (action.status !== 'approved') {
            action.status = 'approved';
            stamp('action-approved', `Action approved: [${action.type}] ${action.title}`, {
                actionId: action.id, type: action.type,
                ...(action.type === 'calendar' ? { addClarus: action.addClarus !== false } : {}),
            });
        }
    } else if (update.op === 'dismiss') {
        if (action.status === 'approved') return { ok: false, status: 409, error: 'this action was already approved' };
        if (action.status !== 'dismissed') {
            action.status = 'dismissed';
            stamp('action-dismissed', `Action dismissed: [${action.type}] ${action.title}`, { actionId: action.id });
        }
    } else if (update.op === 'toggle-clarus') {
        if (action.type !== 'calendar') return { ok: false, status: 400, error: 'only calendar actions carry the Add Clarus toggle' };
        const on = Boolean(update.addClarus);
        action.addClarus = on;
        stamp('action-toggled', `Add Clarus turned ${on ? 'ON' : 'OFF'} for: ${action.title}`, { actionId: action.id, addClarus: on });
    } else {
        return { ok: false, status: 400, error: 'unknown op' };
    }
    try {
        fs.writeFileSync(path.join(dir ?? recordsDir(), file), JSON.stringify(record, null, 2));
    } catch {
        return { ok: false, status: 500, error: 'could not write the record' };
    }
    return { ok: true, record };
};

/** The small honest metrics strip across all past meetings */
export const computeMetrics = (entries: HistoryEntry[]) => {
    const total = entries.length;
    const allClosed = entries.filter((e) => e.conditionsTotal > 0 && e.conditionsClosed === e.conditionsTotal).length;
    return {
        totalMeetings: total,
        allConditionsClosed: allClosed,
        allConditionsClosedPct: total ? Math.round((allClosed / total) * 100) : 0,
        noDecisionMade: entries.filter((e) => e.conditionsClosed === 0).length,
        editedMidCall: entries.filter((e) => e.editedMidCall).length,
    };
};
