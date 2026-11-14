/**
 * Typed front door to the decision ledger (Phase 18 M3).
 *
 * The implementation lives in ledger-core.js - plain CommonJS so the
 * dependency-free hosted hub loads the SAME file
 * (deploy/cockpit-server/ledger.js re-exports it). This wrapper only adds
 * types for the TypeScript side. Read ledger-core.js for how it works.
 */
/* eslint-disable @typescript-eslint/no-var-requires */
const core = require('./ledger-core.js') as LedgerCore;

export type LedgerStatus = 'decided' | 'needs-approval' | 'conditional' | 'not-agreed' | 'unclear' | 'superseded';

/** One piece of proof behind an entry. Later milestones add slack / github / outlook sources. */
export type LedgerProof = {
    source: 'meeting' | 'slack' | 'github' | 'outlook';
    /** 'decision' = the words that settled it; 'quote' = what was said on an
     *  entry that is NOT decided; 'reason' = the words that explained why */
    kind: 'decision' | 'quote' | 'reason';
    quote: string;
    who: string;
    when: string;
    /** The meeting record this came from (the History view opens it) */
    recordFile: string | null;
};

/** One DECISION in the company ledger (not one meeting). */
export type LedgerEntry = {
    id: string;
    project: string;
    /** Crisp one-line record, e.g. "Launch approved: 14 October" */
    statement: string;
    status: LedgerStatus;
    /** Who agreed it - always someone the evidence quotes */
    decider: string;
    date: string;
    /** Why, as stated in the room ('' when nobody said) */
    rationale: string;
    /** What is still outstanding, in plain words ('' when decided) */
    missing: string;
    proof: LedgerProof[];
    conditionLabel: string;
    sourceMeeting: { id: string, name: string };
    sourceRecord: string | null;
    supersedes: string | null;
    supersededBy: string | null;
    history: Array<{ at: string, event: string, detail: string }>;
    createdAt: string;
    updatedAt: string;
};

/** Two decisions in one project that do not agree - flagged for a PERSON to settle */
export type LedgerClash = {
    id: string;
    project: string;
    newerId: string;
    olderId: string;
    /** One plain sentence saying what differs */
    explanation: string;
    detectedAt: string;
    status: 'open' | 'resolved' | 'dismissed';
    resolution: Record<string, unknown> | null;
    newer?: LedgerEntry | null;
    older?: LedgerEntry | null;
};

export type LedgerWriteResult = { entries: LedgerEntry[], added: number, updated: number, usedModel: boolean, clashes: LedgerClash[] };

type LedgerCore = {
    STATUSES: LedgerStatus[];
    ledgerDir(): string;
    ledgerFile(): string;
    writeFromRecord(record: unknown, recordFile: string | null, options?: { apiKey?: string }): Promise<LedgerWriteResult>;
    noteOnRecord(recordPath: string, result: LedgerWriteResult): void;
    backfill(recordsDirectory: string, options?: { apiKey?: string }): Promise<{ records: number, entries: number, added: number, updated: number }>;
    list(filters?: { project?: string, status?: string, q?: string }): { entries: LedgerEntry[], projects: string[], counts: Record<string, number>, total: number, clashes: LedgerClash[] };
    ask(question: string, options?: { project?: string, apiKey?: string }): Promise<
        { ok: true, answered: boolean, answer: string, cited: LedgerEntry[], needsKey?: boolean } | { ok: false, status: number, error: string }>;
    createToken(): { token: string, hint: string };
    tokenStatus(): { exists: boolean, hint?: string, createdAt?: string };
    revokeToken(): { ok: true };
    checkToken(presented: string): boolean;
    bearer(header: string | undefined): string;
    resolveClash(clashId: string, standsId: string, confirmedBy: string):
        { ok: true, stands: LedgerEntry, replaced: LedgerEntry, confirmedBy: string, at: string } | { ok: false, status: number, error: string };
    dismissClash(clashId: string, dismissedBy: string): { ok: true } | { ok: false, status: number, error: string };
    appendRecordEvent(recordPath: string, event: { type: string, detail: string, data?: Record<string, unknown> }): boolean;
    draftAskDecider(clashId: string, recordsDirectory: string): { ok: true, recordFile: string, actionId: string } | { ok: false, status: number, error: string };
    checkClosure(
        closure: { project: string, label: string, note?: string, evidence?: Array<{ speaker: string, quote: string }> },
        currentEntries: LedgerEntry[],
        apiKey: string,
    ): Promise<{ earlierId: string, earlierStatement: string, message: string } | null>;
    get(id: string): LedgerEntry | null;
};

export const Ledger = core;
