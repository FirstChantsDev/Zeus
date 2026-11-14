/**
 * The decision ledger - one company-wide record of truth (Phase 18 M3).
 *
 * ONE implementation, used by both halves of the product: the local bot
 * loads it through the typed wrapper lib/Ledger.ts, and the hosted hub
 * through deploy/cockpit-server/ledger.js. It is plain CommonJS with no
 * dependencies precisely so the dependency-free hub can load it too -
 * the two sides can never drift apart.
 *
 * What it holds: ONE entry per DECISION (not per meeting), grouped by
 * project. Entries are written when a meeting ends, from that meeting's
 * final board. The ledger is ONE plain JSON file, ledger/ledger.json
 * (LEDGER_DIR / ZEUS_LEDGER_DIR override; on the hub it defaults to a
 * `ledger` folder inside RECORDS_DIR so it lives on the same Railway
 * volume as the records). Like records, it contains meeting content: it
 * is gitignored and never committed.
 *
 * Golden rule: the room decides; Clarus only records. The status of an
 * entry is derived from the board the room produced - the model may word
 * an entry more crisply, but it can never promote one (see `allowed`).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STATUSES = ['decided', 'needs-approval', 'conditional', 'not-agreed', 'unclear', 'superseded'];
const NO_PROJECT = 'No project';

const ledgerDir = () =>
    process.env.LEDGER_DIR
    || process.env.ZEUS_LEDGER_DIR
    || (process.env.RECORDS_DIR ? path.join(process.env.RECORDS_DIR, 'ledger') : path.join(process.cwd(), 'ledger'));
const ledgerFile = () => path.join(ledgerDir(), 'ledger.json');
/** Where the model lives. ANTHROPIC_BASE_URL exists so tests can point it at a stand-in. */
const anthropicBase = () => (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');

/** The whole ledger; an empty one when the file does not exist yet. */
const readLedger = () => {
    try {
        const parsed = JSON.parse(fs.readFileSync(ledgerFile(), 'utf8'));
        return { v: 1, entries: Array.isArray(parsed.entries) ? parsed.entries : [], clashes: Array.isArray(parsed.clashes) ? parsed.clashes : [] };
    } catch {
        return { v: 1, entries: [], clashes: [] };
    }
};

/** Written to a temp file first, then renamed - a crash never leaves half a ledger. */
const writeLedger = (ledger) => {
    fs.mkdirSync(ledgerDir(), { recursive: true });
    const tmp = `${ledgerFile()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, entries: ledger.entries, clashes: ledger.clashes || [] }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, ledgerFile());
};

const clean = (value) => (typeof value === 'string' ? value.trim() : '');

/** Which ledger statuses a board state may honestly map to. */
const allowed = (condition) => {
    if (condition.status === 'closed') return ['decided'];
    if (condition.status === 'held') return ['conditional', 'needs-approval'];
    return ['not-agreed', 'unclear'];
};

/** What is still outstanding, in plain words (empty for a decided entry). */
const missingFor = (status, condition) => {
    if (status === 'conditional') return `Until: ${clean(condition.heldOn) || 'the attached condition is met'}`;
    if (status === 'needs-approval') return `Waiting on: ${clean(condition.heldOn) || 'the named approver'}`;
    if (status === 'unclear') return clean(condition.note) || 'The wording in the room was not a clear decision';
    if (status === 'not-agreed') return clean(condition.note) || 'Not agreed in the meeting';
    return '';
};

/**
 * The board -> ledger entries, with no model involved. This is the honest
 * floor: every entry it produces is backed by what the record shows. The
 * model step below only sharpens the wording.
 */
const entriesFromRecord = (record, recordFile) => {
    const project = clean(record.project) || NO_PROJECT;
    const when = record.endedAt || new Date().toISOString();
    return (record.conditions || []).map((condition, index) => {
        const conditionId = clean(condition.id) || `c${index}`;
        const unclear = /^unclear wording/i.test(clean(condition.note));
        const status = condition.status === 'closed' ? 'decided'
            : condition.status === 'held' ? 'conditional'
            : unclear ? 'unclear' : 'not-agreed';
        const evidence = Array.isArray(condition.evidence) ? condition.evidence : [];
        // Only a DECIDED entry's quote is a decision; the rest are just what was said.
        const proofKind = status === 'decided' ? 'decision' : 'quote';
        const proof = evidence
            .filter((line) => line && clean(line.quote))
            .map((line) => ({ source: 'meeting', kind: proofKind, quote: clean(line.quote), who: clean(line.speaker), when, recordFile: recordFile || null }));
        if (condition.rationaleEvidence && clean(condition.rationaleEvidence.quote)) {
            proof.push({ source: 'meeting', kind: 'reason', quote: clean(condition.rationaleEvidence.quote), who: clean(condition.rationaleEvidence.speaker), when, recordFile: recordFile || null });
        }
        // What happened to this decision DURING the meeting (held, revised, reopened...).
        const history = (record.events || [])
            .filter((event) => event && event.data && event.data.id === conditionId && /^condition-(closed|held|released|revised|reopened)$/.test(event.type))
            .map((event) => ({ at: event.at, event: event.type.replace('condition-', ''), detail: clean(event.detail) }));
        history.push({ at: when, event: 'recorded', detail: `Recorded in the ledger as: ${status}` });
        const label = clean(condition.label) || 'Untitled decision';
        const note = clean(condition.note);
        return {
            id: `${record.id}-${conditionId}`,
            project,
            statement: status === 'decided' && note ? `${label}: ${note}` : label,
            status,
            decider: status === 'decided' || status === 'conditional' ? clean(evidence[0] && evidence[0].speaker) : '',
            date: when,
            rationale: clean(condition.rationale),
            missing: missingFor(status, condition),
            proof,
            conditionLabel: label,
            sourceMeeting: { id: record.id, name: clean(record.meetingName) || 'Untitled meeting' },
            sourceRecord: recordFile || null,
            supersedes: null,
            supersededBy: null,
            history,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
    });
};

/**
 * ONE paid API call per meeting: asks the model to word each entry
 * crisply ("Launch approved: 14 October"), name the decider, and tell a
 * plain condition from a named approver. It cannot change what was
 * decided: a status outside `allowed` for that board state is ignored.
 * Any failure leaves the deterministic entries exactly as they were.
 */
const refineWithModel = async (record, entries, apiKey) => {
    if (!apiKey || entries.length === 0) return false;
    const board = (record.conditions || []).map((c, index) => {
        const evidence = (c.evidence || []).map((l) => `${l.speaker}: "${l.quote}"`).join(' / ');
        return `- id "${clean(c.id) || `c${index}`}": ${c.label} - ${String(c.status).toUpperCase()}`
            + `${c.heldOn ? ` (held on: ${c.heldOn})` : ''}${c.note ? ` (${c.note})` : ''}`
            + `${c.rationale ? ` [stated reason: ${c.rationale}]` : ''}${evidence ? ` [evidence: ${evidence}]` : ''}`;
    }).join('\n');
    const system = [
        'Punctuation rule: NEVER use an em dash ("\u2014") anywhere you write. Use a comma, full stop, or hyphen instead.',
        'You are Clarus, an agent that openly attended a meeting for its owner and keeps the company',
        'decision ledger. The meeting has ended. Turn its final board into ledger entries. You only',
        'RECORD what the room decided - you never decide, upgrade or guess anything yourself.',
        '',
        'For EACH condition on the board return:',
        '- statement: a crisp one-line record of where it stands, e.g. "Launch approved: 14 October",',
        '  "Vendor contract: approved by Maya, legal confirmed", "Launch owner: not agreed". Use only',
        '  facts from the board and its evidence.',
        '- status: CLOSED conditions are always "decided". HELD conditions are "needs-approval" when',
        '  they wait on a NAMED PERSON or team saying yes ("yes if Dan in Finance signs off"), otherwise',
        '  "conditional". OPEN conditions are "unclear" when the room gave vague assent ("probably Tom",',
        '  "sounds fine I think"), otherwise "not-agreed".',
        '- decider: the person who agreed it, taken from the evidence speaker. "" if nobody did.',
        '- missing: what is still outstanding, in a few plain words. For needs-approval start with',
        '  "Waiting on: <who>". For conditional start with "Until: <what>". For unclear, quote the',
        '  vague words. "" for a decided entry.',
        '',
        'Reply with ONLY strict JSON on one line, exactly this shape:',
        '{"entries": [{"conditionId": "<id>", "statement": "...", "status": "decided"|"needs-approval"|"conditional"|"not-agreed"|"unclear", "decider": "...", "missing": "..."}]}',
    ].join('\n');
    try {
        const response = await fetch(`${anthropicBase()}/v1/messages`, {
            method: 'POST',
            headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
            body: JSON.stringify({
                model: 'claude-opus-4-8',
                max_tokens: 900,
                system,
                messages: [{ role: 'user', content: `Meeting: "${record.meetingName || 'Untitled meeting'}"${record.project ? ` (project: ${record.project})` : ''}\n\nFinal board:\n${board}` }],
            }),
        });
        if (!response.ok) {
            console.error(`LEDGER >>> model wording skipped (Anthropic answered ${response.status})`);
            return false;
        }
        const data = await response.json();
        const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('').trim().replace(/\u2014/g, '-');
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start < 0 || end <= start) return false;
        const parsed = JSON.parse(text.slice(start, end + 1));
        for (const refined of (Array.isArray(parsed.entries) ? parsed.entries : [])) {
            const index = (record.conditions || []).findIndex((c, i) => (clean(c.id) || `c${i}`) === refined.conditionId);
            if (index < 0 || !entries[index]) continue;
            const condition = record.conditions[index];
            const entry = entries[index];
            if (clean(refined.statement)) entry.statement = clean(refined.statement);
            // The model may only choose between statuses the board state allows.
            if (allowed(condition).includes(refined.status) && refined.status !== entry.status) {
                entry.status = refined.status;
                entry.history[entry.history.length - 1].detail = `Recorded in the ledger as: ${entry.status}`;
                entry.missing = missingFor(entry.status, condition);
            }
            if (entry.status !== 'decided' && clean(refined.missing)) entry.missing = clean(refined.missing);
            if (entry.status === 'decided') entry.missing = '';
            // A decider must be someone the evidence actually quotes.
            const speakers = (condition.evidence || []).map((l) => clean(l.speaker).toLowerCase());
            if (clean(refined.decider) && speakers.includes(clean(refined.decider).toLowerCase())) entry.decider = clean(refined.decider);
        }
        return true;
    } catch (error) {
        console.error('LEDGER >>> model wording skipped:', error instanceof Error ? error.message : error);
        return false;
    }
};

/**
 * Adds new entries and updates existing ones (same id = the same decision
 * recorded again, e.g. a backfill re-run). An update that changes the
 * status or the statement is kept in the entry's history - nothing is
 * ever silently overwritten, and nothing is ever deleted.
 */
const upsert = (incoming) => {
    const ledger = readLedger();
    let added = 0;
    let updated = 0;
    for (const entry of incoming) {
        const existing = ledger.entries.find((e) => e.id === entry.id);
        if (!existing) {
            ledger.entries.push(entry);
            added++;
            continue;
        }
        // A superseded entry stays superseded: re-recording its meeting must not revive it.
        const status = existing.status === 'superseded' ? 'superseded' : entry.status;
        const changed = existing.status !== status || existing.statement !== entry.statement;
        const history = existing.history || [];
        if (changed) {
            history.push({ at: new Date().toISOString(), event: 'updated', detail: `Was "${existing.statement}" (${existing.status}); now "${entry.statement}" (${status})` });
        }
        const proofKey = (p) => `${p.source}|${p.kind}|${p.who}|${p.quote}`;
        const seen = new Set((existing.proof || []).map(proofKey));
        const proof = [...(existing.proof || []), ...entry.proof.filter((p) => !seen.has(proofKey(p)))];
        Object.assign(existing, entry, {
            status, history, proof,
            supersedes: existing.supersedes || null,
            supersededBy: existing.supersededBy || null,
            createdAt: existing.createdAt || entry.createdAt,
            updatedAt: changed ? new Date().toISOString() : (existing.updatedAt || entry.updatedAt),
        });
        if (changed) updated++;
    }
    writeLedger(ledger);
    return { added, updated };
};

/**
 * The end-of-meeting step: one finished record in, its ledger entries
 * written. `apiKey` is optional - without it (no key, or over the daily
 * cap) the deterministic entries are written as they are.
 */
const writeFromRecord = async (record, recordFile, options = {}) => {
    if (!record || !Array.isArray(record.conditions) || record.conditions.length === 0) {
        return { entries: [], added: 0, updated: 0, usedModel: false };
    }
    const entries = entriesFromRecord(record, recordFile);
    const usedModel = await refineWithModel(record, entries, options.apiKey || '');
    const { added, updated } = upsert(entries);
    // Phase 18 M4: does anything just recorded contradict an earlier decision?
    const clashes = await detectClashes(entries, options.apiKey || '');
    console.log(`LEDGER >>> "${record.meetingName || 'Untitled meeting'}" [${entries[0].project}]: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} (${added} new, ${updated} updated)${usedModel ? '' : ' - plain wording, no model call'}`);
    return { entries, added, updated, usedModel, clashes };
};

/** Adds the `ledger-written` audit event to a record file already on disk. */
const noteOnRecord = (recordPath, result) => {
    try {
        const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
        record.events = Array.isArray(record.events) ? record.events : [];
        if (record.events.some((e) => e.type === 'ledger-written')) return;
        record.events.push({
            at: new Date().toISOString(),
            type: 'ledger-written',
            detail: `Ledger written: ${result.entries.length} entr${result.entries.length === 1 ? 'y' : 'ies'} (${result.entries.map((e) => e.status).join(', ')})`,
            data: { entryIds: result.entries.map((e) => e.id) },
        });
        fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));
    } catch (error) {
        console.error('LEDGER >>> could not note the ledger write on the record:', error instanceof Error ? error.message : error);
    }
};

/**
 * Backfill: runs the same end-of-meeting step over every record file in a
 * directory, oldest first, so the ledger is not empty on day one. Safe to
 * re-run - entries are matched by id.
 */
const backfill = async (recordsDirectory, options = {}) => {
    let files = [];
    try {
        files = fs.readdirSync(recordsDirectory).filter((f) => f.endsWith('.json')).sort();
    } catch {
        return { records: 0, entries: 0, added: 0, updated: 0 };
    }
    const totals = { records: 0, entries: 0, added: 0, updated: 0 };
    for (const file of files) {
        let record = null;
        try { record = JSON.parse(fs.readFileSync(path.join(recordsDirectory, file), 'utf8')); } catch { continue; }
        if (!record || !record.id || !Array.isArray(record.conditions) || !record.endedAt) continue; // not a meeting record
        const result = await writeFromRecord(record, file, options);
        if (result.entries.length === 0) continue;
        noteOnRecord(path.join(recordsDirectory, file), result);
        totals.records++;
        totals.entries += result.entries.length;
        totals.added += result.added;
        totals.updated += result.updated;
    }
    return totals;
};

/**
 * ================================================
 * Phase 18 M4: clashes. A new decision that contradicts an earlier one
 * in the same project is FLAGGED - never resolved by Clarus. A person
 * confirms which stands; the other entry is then marked Superseded and
 * linked both ways. Nothing is ever deleted.
 * ================================================
 */

/** Entries that state a position a later decision could contradict. */
const isCurrentPosition = (entry) => ['decided', 'conditional', 'needs-approval'].includes(entry.status);

const entryLine = (e) => `- id "${e.id}" (${String(e.date).slice(0, 10)}, ${e.sourceMeeting ? e.sourceMeeting.name : 'meeting'}): ${e.statement}`
    + `${e.status !== 'decided' ? ` [${e.status}${e.missing ? `: ${e.missing}` : ''}]` : ''}`;

/** One model call, shared by the ledger-write check and the live check. */
const askModel = async (apiKey, system, user, maxTokens) => {
    const response = await fetch(`${anthropicBase()}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-opus-4-8', max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
    });
    if (!response.ok) throw new Error(`Anthropic answered ${response.status}`);
    const data = await response.json();
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('').trim().replace(/\u2014/g, '-');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('no JSON in the reply');
    return JSON.parse(text.slice(start, end + 1));
};

/**
 * At ledger write: ONE API call per project touched by this meeting. It
 * compares the entries just recorded against the CURRENT entries already
 * in that project and returns the pairs that contradict each other.
 * Needs a key - there is no honest way to spot a contradiction without
 * reading the decisions, so with no key nothing is flagged.
 */
const detectClashes = async (justRecorded, apiKey) => {
    if (!apiKey) return [];
    const ledger = readLedger();
    const found = [];
    const projects = [...new Set(justRecorded.map((e) => e.project))];
    for (const project of projects) {
        const fresh = justRecorded.filter((e) => e.project === project).map((e) => ledger.entries.find((x) => x.id === e.id)).filter((e) => e && isCurrentPosition(e));
        const freshIds = new Set(fresh.map((e) => e.id));
        const earlier = ledger.entries.filter((e) => e.project === project && !freshIds.has(e.id) && isCurrentPosition(e));
        if (fresh.length === 0 || earlier.length === 0) continue;
        const system = [
            'Punctuation rule: NEVER use an em dash ("\u2014") anywhere you write. Use a comma, full stop, or hyphen instead.',
            'You are Clarus, an agent that keeps a company decision ledger for its owner. You are given',
            'decisions just recorded from a meeting, and the decisions already on record for the same',
            'project. Report every pair where a NEW decision CONTRADICTS an EARLIER one: the same subject',
            'with a different outcome (a different date, figure, owner, or a yes against a no).',
            'Decisions about different subjects do not clash. A new decision that merely adds detail or',
            'confirms an earlier one does not clash. When unsure, do not report it.',
            'You only FLAG clashes for a person to settle. Never say which decision is right.',
            '',
            'Reply with ONLY strict JSON on one line:',
            '{"clashes": [{"newId": "<id of the new decision>", "earlierId": "<id of the earlier decision>", "explanation": "<one plain sentence saying what differs>"}]}',
            'Use {"clashes": []} when nothing clashes.',
        ].join('\n');
        const user = `Project: ${project}\n\nJust recorded:\n${fresh.map(entryLine).join('\n')}\n\nAlready on record:\n${earlier.map(entryLine).join('\n')}`;
        try {
            const parsed = await askModel(apiKey, system, user, 600);
            for (const pair of (Array.isArray(parsed.clashes) ? parsed.clashes : [])) {
                const a = fresh.find((e) => e.id === pair.newId);
                const b = earlier.find((e) => e.id === pair.earlierId);
                if (!a || !b) continue; // the model named an entry that was not in front of it
                const known = (ledger.clashes || []).some((c) => (c.newerId === a.id && c.olderId === b.id) || (c.newerId === b.id && c.olderId === a.id));
                if (known) continue;
                const [newer, older] = String(a.date) >= String(b.date) ? [a, b] : [b, a];
                const clash = {
                    id: `clash-${newer.id}-${older.id}`,
                    project,
                    newerId: newer.id,
                    olderId: older.id,
                    explanation: clean(pair.explanation) || 'These two decisions do not agree.',
                    detectedAt: new Date().toISOString(),
                    status: 'open',
                    resolution: null,
                };
                ledger.clashes.push(clash);
                for (const entry of [newer, older]) {
                    entry.history.push({ at: clash.detectedAt, event: 'clash-flagged', detail: `Flagged as clashing with "${entry === newer ? older.statement : newer.statement}"` });
                }
                found.push(clash);
                console.log(`LEDGER CLASH >>> [${project}] "${newer.statement}" vs "${older.statement}" - ${clash.explanation}`);
            }
        } catch (error) {
            console.error('LEDGER >>> clash check skipped:', error instanceof Error ? error.message : error);
        }
    }
    if (found.length) writeLedger(ledger);
    return found;
};

/** Open clashes (optionally for one project), each with both entries attached. */
const openClashes = (project) => {
    const ledger = readLedger();
    return (ledger.clashes || [])
        .filter((c) => c.status === 'open' && (!project || c.project === project))
        .map((c) => ({ ...c, newer: ledger.entries.find((e) => e.id === c.newerId) || null, older: ledger.entries.find((e) => e.id === c.olderId) || null }))
        .filter((c) => c.newer && c.older);
};

/**
 * A PERSON confirms which of two clashing decisions stands. The other is
 * marked Superseded and the two are linked both ways. Returns what the
 * caller needs to write the `decision-superseded` audit event.
 */
const resolveClash = (clashId, standsId, confirmedBy) => {
    const ledger = readLedger();
    const clash = (ledger.clashes || []).find((c) => c.id === clashId);
    if (!clash) return { ok: false, status: 404, error: 'clash not found' };
    if (clash.status !== 'open') return { ok: false, status: 409, error: 'this clash was already settled' };
    if (standsId !== clash.newerId && standsId !== clash.olderId) return { ok: false, status: 400, error: 'pick one of the two decisions' };
    const stands = ledger.entries.find((e) => e.id === standsId);
    const replaced = ledger.entries.find((e) => e.id === (standsId === clash.newerId ? clash.olderId : clash.newerId));
    if (!stands || !replaced) return { ok: false, status: 404, error: 'entry not found' };
    const at = new Date().toISOString();
    const who = clean(confirmedBy) || 'the owner';
    replaced.history.push({ at, event: 'superseded', detail: `${who} confirmed "${stands.statement}" stands. Was: ${replaced.status}` });
    replaced.status = 'superseded';
    replaced.supersededBy = stands.id;
    replaced.missing = stands.statement; // shown as "Replaced by: ..."
    replaced.updatedAt = at;
    stands.supersedes = replaced.id;
    stands.history.push({ at, event: 'confirmed', detail: `${who} confirmed this stands over "${replaced.statement}"` });
    stands.updatedAt = at;
    clash.status = 'resolved';
    clash.resolution = { standsId: stands.id, supersededId: replaced.id, confirmedBy: who, at };
    writeLedger(ledger);
    console.log(`LEDGER >>> ${who} confirmed "${stands.statement}" stands; "${replaced.statement}" is superseded`);
    return { ok: true, stands, replaced, confirmedBy: who, at };
};

/** A person says the two flagged decisions do not actually clash. */
const dismissClash = (clashId, dismissedBy) => {
    const ledger = readLedger();
    const clash = (ledger.clashes || []).find((c) => c.id === clashId);
    if (!clash) return { ok: false, status: 404, error: 'clash not found' };
    if (clash.status !== 'open') return { ok: false, status: 409, error: 'this clash was already settled' };
    const at = new Date().toISOString();
    const who = clean(dismissedBy) || 'the owner';
    clash.status = 'dismissed';
    clash.resolution = { dismissedBy: who, at };
    for (const id of [clash.newerId, clash.olderId]) {
        const entry = ledger.entries.find((e) => e.id === id);
        if (entry) entry.history.push({ at, event: 'clash-dismissed', detail: `${who} said this is not a clash - both stand` });
    }
    writeLedger(ledger);
    return { ok: true };
};

/** Appends one audit event to a record file on disk (never throws). */
const appendRecordEvent = (recordPath, event) => {
    try {
        const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
        record.events = Array.isArray(record.events) ? record.events : [];
        record.events.push({ at: new Date().toISOString(), ...event });
        fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));
        return true;
    } catch (error) {
        console.error('LEDGER >>> could not write to the meeting record:', error instanceof Error ? error.message : error);
        return false;
    }
};

/**
 * "Ask the decider": drafts a short message to the person who made the
 * NEWER decision and files it as a proposed follow-up action on that
 * meeting's record - the Phase 14 action layer, so it is editable and
 * goes nowhere until the owner approves it. A fixed template, no API call.
 */
const draftAskDecider = (clashId, recordsDirectory) => {
    const clash = openClashes('').find((c) => c.id === clashId);
    if (!clash) return { ok: false, status: 404, error: 'clash not found' };
    const { newer, older } = clash;
    if (!newer.sourceRecord) return { ok: false, status: 409, error: 'the newer decision has no meeting record to attach the draft to' };
    const recordPath = path.join(recordsDirectory, newer.sourceRecord);
    let record = null;
    try { record = JSON.parse(fs.readFileSync(recordPath, 'utf8')); } catch { return { ok: false, status: 404, error: 'meeting record not found' }; }
    record.actions = Array.isArray(record.actions) ? record.actions : [];
    const existing = record.actions.find((a) => a.clashId === clashId);
    if (existing) return { ok: true, recordFile: newer.sourceRecord, actionId: existing.id };
    const day = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
    const name = clean(newer.decider);
    const attendee = (record.attendees || []).find((a) => name && clean(a.name).toLowerCase().includes(name.toLowerCase()));
    const action = {
        id: `a${record.actions.length + 1}`,
        type: 'email',
        title: `Ask ${name || 'the decider'} which decision stands`,
        body: [
            `Hi ${name || 'there'},`,
            '',
            `Two decisions on record for ${clash.project} do not agree, and I would like to confirm which one stands.`,
            '',
            `1. ${day(older.date)}, ${older.sourceMeeting ? older.sourceMeeting.name : 'earlier meeting'}: ${older.statement}`,
            `2. ${day(newer.date)}, ${newer.sourceMeeting ? newer.sourceMeeting.name : 'later meeting'}: ${newer.statement}`,
            '',
            'Does the second replace the first, or does the first still hold? A one-line reply is all I need.',
            '',
            'Thanks,',
            clean(record.ownerName) || '',
        ].join('\n').trim(),
        source: `Ledger clash: "${newer.statement}" against "${older.statement}"`,
        recipients: [{ name: name || 'The decider', email: attendee ? attendee.email : null }],
        status: 'proposed',
        clashId,
    };
    record.actions.push(action);
    record.events = Array.isArray(record.events) ? record.events : [];
    record.events.push({ at: new Date().toISOString(), type: 'action-drafted', detail: `Drafted a message asking ${name || 'the decider'} which decision stands (waiting for your approval)`, data: { actionId: action.id, clashId } });
    try {
        fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));
    } catch {
        return { ok: false, status: 500, error: 'could not save the draft' };
    }
    return { ok: true, recordFile: newer.sourceRecord, actionId: action.id };
};

/**
 * Live in the meeting (the cheap version): when a condition CLOSES
 * mid-call, ONE API call checks it against the project's current ledger
 * entries. On a contradiction it returns one chat line for the agent to
 * post, asking the room whether the new decision replaces the old one.
 * The room answers; Clarus never settles it.
 */
const checkClosure = async (closure, currentEntries, apiKey) => {
    const candidates = (currentEntries || []).filter(isCurrentPosition).slice(0, 40);
    if (!apiKey || candidates.length === 0) return null;
    const system = [
        'Punctuation rule: NEVER use an em dash ("\u2014") anywhere you write. Use a comma, full stop, or hyphen instead.',
        'You are Clarus, an agent openly sitting in a live meeting for its owner. The room has just',
        'settled a decision. You are given that decision and the decisions already on record for the',
        'same project. Does the new decision CONTRADICT one on record: the same subject with a',
        'different outcome (a different date, figure, owner, or a yes against a no)?',
        'A different subject, added detail, or a confirmation is NOT a contradiction. When unsure, no.',
        '',
        'If it does, write ONE short chat line for the room that states the earlier decision with its',
        'date and asks whether the new one replaces it, e.g. "[CLARUS] On 3 Nov the steering committee',
        'agreed 21 October. Is 14 October replacing that?" Ask only. Never say which is right.',
        '',
        'Reply with ONLY strict JSON on one line:',
        '{"clash": true|false, "earlierId": "<id>"|null, "message": "[CLARUS] ..."|null}',
    ].join('\n');
    const evidence = (closure.evidence || []).map((l) => `${l.speaker}: "${l.quote}"`).join(' / ');
    const user = `Just settled in the room: ${closure.label}${closure.note ? ` - ${closure.note}` : ''}${evidence ? ` [said: ${evidence}]` : ''}\n\nAlready on record for ${closure.project}:\n${candidates.map(entryLine).join('\n')}`;
    try {
        const parsed = await askModel(apiKey, system, user, 300);
        const earlier = candidates.find((e) => e.id === parsed.earlierId);
        if (parsed.clash !== true || !earlier || !clean(parsed.message)) return null;
        const message = clean(parsed.message);
        return { earlierId: earlier.id, earlierStatement: earlier.statement, message: message.startsWith('[CLARUS]') ? message : `[CLARUS] ${message}` };
    } catch (error) {
        console.error('LEDGER >>> live clash check skipped:', error instanceof Error ? error.message : error);
        return null;
    }
};

/** The Ledger view's data: filtered entries (newest first) plus the filter options. */
const list = (filters = {}) => {
    const all = readLedger().entries;
    const project = clean(filters.project);
    const status = clean(filters.status);
    // Search matches on the question's WORDS, not the exact phrase, and
    // looks inside the quotes too: "launch 14th" finds "Launch moved: 14
    // October" through its quote. Every word must appear; if nothing has
    // them all, entries with any of the words are returned instead.
    const words = keywords(filters.q);
    const haystack = (e) => [e.statement, e.rationale, e.missing, e.decider, e.conditionLabel, e.project,
        e.sourceMeeting && e.sourceMeeting.name, ...(e.proof || []).map((p) => p.quote)].join(' ').toLowerCase();
    const scoped = all
        .filter((e) => !project || e.project === project)
        .filter((e) => !status || e.status === status);
    let matched = scoped;
    if (words.length) {
        const everyWord = scoped.filter((e) => words.every((w) => haystack(e).includes(w)));
        matched = everyWord.length ? everyWord : scoped.filter((e) => words.some((w) => haystack(e).includes(w)));
    }
    // Best match first when searching (most of the words), newest first otherwise.
    const hits = (e) => words.filter((w) => haystack(e).includes(w)).length;
    const entries = matched.sort((a, b) => (words.length ? hits(b) - hits(a) : 0) || String(b.date).localeCompare(String(a.date)));
    const inProject = all.filter((e) => !project || e.project === project);
    const counts = {};
    for (const s of STATUSES) counts[s] = inProject.filter((e) => e.status === s).length;
    return {
        entries,
        projects: [...new Set(all.map((e) => e.project))].sort(),
        counts,
        total: inProject.length,
        clashes: openClashes(project),
    };
};

const get = (id) => readLedger().entries.find((e) => e.id === id) || null;

/**
 * ================================================
 * Phase 18 M5: ask the ledger. A question goes to ONE API call together
 * with the most relevant entries (pre-filtered by project and by the
 * question's own words, capped), and comes back as a short answer that
 * cites entries by id. It answers ONLY from the ledger: when the ledger
 * does not hold the answer it says so, it never guesses.
 * ================================================
 */
const STOP_WORDS = new Set(('a an and are as at be by did do does for from has have how i in is it of on or our that the '
    + 'their this to was we were what when where which who why will with you your').split(' '));

/** The question's meaningful words, for the free pre-filter. */
const keywords = (text) => [...new Set(clean(text).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP_WORDS.has(w)))];

/** Entries most likely to hold the answer: scored by shared words, current ones first. */
const relevantEntries = (question, project, cap) => {
    const words = keywords(question);
    const all = readLedger().entries.filter((e) => !project || e.project === project);
    const scored = all.map((entry) => {
        const text = [entry.statement, entry.rationale, entry.missing, entry.decider, entry.conditionLabel, entry.project,
            entry.sourceMeeting && entry.sourceMeeting.name, ...(entry.proof || []).map((p) => p.quote)].join(' ').toLowerCase();
        const hits = words.filter((w) => text.includes(w)).length;
        return { entry, hits };
    });
    const matched = scored.filter((x) => x.hits > 0);
    // Nothing shares a word with the question: fall back to the newest entries.
    const pool = matched.length ? matched : scored;
    return pool
        .sort((a, b) => (b.hits - a.hits) || ((a.entry.status === 'superseded') - (b.entry.status === 'superseded')) || String(b.entry.date).localeCompare(String(a.entry.date)))
        .slice(0, cap)
        .map((x) => x.entry);
};

const ask = async (question, options = {}) => {
    const asked = clean(question).slice(0, 500);
    if (!asked) return { ok: false, status: 400, error: 'Ask a question first.' };
    const project = clean(options.project);
    const candidates = relevantEntries(asked, project, 20);
    if (candidates.length === 0) {
        return { ok: true, answered: false, answer: 'The ledger is empty, so there is nothing to answer from yet.', cited: [] };
    }
    if (!options.apiKey) {
        return { ok: true, answered: false, needsKey: true, answer: 'Answering questions needs the AI key, which is not set on this server. These are the entries closest to your words.', cited: candidates.slice(0, 5) };
    }
    const describe = (e) => [
        `id "${e.id}" [${e.status}] (${e.project}, ${String(e.date).slice(0, 10)}, ${e.sourceMeeting ? e.sourceMeeting.name : 'meeting'})`,
        `  decision: ${e.statement}`,
        e.decider ? `  agreed by: ${e.decider}` : '',
        e.rationale ? `  reason given: ${e.rationale}` : '',
        e.missing ? `  ${e.status === 'superseded' ? 'replaced by' : 'missing'}: ${e.missing}` : '',
        ...(e.proof || []).slice(0, 3).map((p) => `  ${p.kind} quote, ${p.who}: "${p.quote}"`),
    ].filter(Boolean).join('\n');
    const system = [
        'Punctuation rule: NEVER use an em dash ("\u2014") anywhere you write. Use a comma, full stop, or hyphen instead.',
        'You are Clarus, an agent that keeps a company decision ledger. Someone is asking the ledger a',
        'question. Answer ONLY from the entries below. They are the whole of what you know.',
        '',
        'Rules:',
        '- Answer in 1 to 3 short plain sentences: the current decision, who agreed it, when, and the',
        '  reason if one is on record. Prefer the CURRENT entry; if an entry is superseded, say what',
        '  replaced it. Say plainly when something is conditional, waiting on approval, or not agreed.',
        '- If the entries do not answer the question, set "answered" to false and say so plainly, e.g.',
        '  "The ledger has no decision on that." NEVER guess, infer, or add outside knowledge.',
        '- "cited" lists the ids of the entries your answer rests on, most important first, at most 4.',
        '  Use [] when you could not answer.',
        '',
        'Reply with ONLY strict JSON on one line: {"answered": true|false, "answer": "...", "cited": ["<id>", ...]}',
    ].join('\n');
    try {
        const parsed = await askModel(options.apiKey, system, `Question: ${asked}\n\nLedger entries:\n${candidates.map(describe).join('\n\n')}`, 500);
        // Only entries that were actually put in front of the model can be cited.
        const cited = (Array.isArray(parsed.cited) ? parsed.cited : [])
            .map((id) => candidates.find((e) => e.id === id)).filter(Boolean).slice(0, 4);
        const answered = parsed.answered === true && cited.length > 0;
        return {
            ok: true,
            answered,
            answer: clean(parsed.answer) || (answered ? '' : 'The ledger has no decision on that.'),
            cited: answered ? cited : [],
        };
    } catch (error) {
        console.error('LEDGER >>> ask failed:', error instanceof Error ? error.message : error);
        return { ok: false, status: 502, error: 'Could not get an answer just now. Try again.' };
    }
};

/**
 * ================================================
 * Phase 18 M5: the read-only API token. ONE active token for the owner,
 * shown once when created and never again: only a salted hash is kept
 * (ledger/api-token.json). Creating a new token replaces the old one;
 * revoking deletes it. The salt is LEDGER_TOKEN_SALT when set, otherwise
 * a random one stored beside the hash.
 * ================================================
 */
const tokenFile = () => path.join(ledgerDir(), 'api-token.json');
const readTokenFile = () => {
    try { return JSON.parse(fs.readFileSync(tokenFile(), 'utf8')); } catch { return null; }
};
const hashToken = (token, salt) => crypto.createHash('sha256').update(`${salt}:${token}`).digest('hex');

const createToken = () => {
    const token = `clr_${crypto.randomBytes(24).toString('hex')}`;
    const salt = process.env.LEDGER_TOKEN_SALT || crypto.randomBytes(16).toString('hex');
    fs.mkdirSync(ledgerDir(), { recursive: true });
    fs.writeFileSync(tokenFile(), JSON.stringify({
        hash: hashToken(token, salt),
        salt: process.env.LEDGER_TOKEN_SALT ? null : salt, // an env salt is never written to disk
        hint: token.slice(-4),
        createdAt: new Date().toISOString(),
    }, null, 2), { mode: 0o600 });
    console.log('LEDGER API >>> a new read-only token was created (any earlier one no longer works)');
    return { token, hint: token.slice(-4) };
};

const tokenStatus = () => {
    const stored = readTokenFile();
    return stored ? { exists: true, hint: stored.hint, createdAt: stored.createdAt } : { exists: false };
};

const revokeToken = () => {
    try { fs.unlinkSync(tokenFile()); } catch { /* already gone */ }
    console.log('LEDGER API >>> the read-only token was revoked');
    return { ok: true };
};

/** True only for the current token. Compared in constant time. */
const checkToken = (presented) => {
    const stored = readTokenFile();
    const token = clean(presented);
    if (!stored || !token) return false;
    const salt = stored.salt || process.env.LEDGER_TOKEN_SALT || '';
    const given = Buffer.from(hashToken(token, salt));
    const expected = Buffer.from(String(stored.hash));
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
};

/** Pulls the token out of an `Authorization: Bearer ...` header. */
const bearer = (header) => {
    const match = /^Bearer\s+(.+)$/i.exec(clean(header));
    return match ? match[1].trim() : '';
};

/**
 * ================================================
 * Phase 18 M6: proof from OUTSIDE a meeting. A message in a tool where
 * the work happens (Slack first) can confirm an entry that was left
 * open - "Approved, no conditions on the DPA" in #legal.
 *
 * Two safeguards keep this honest:
 *  1. A free keyword pre-filter decides whether a message is even worth
 *     a model call, so ordinary chatter costs nothing.
 *  2. An entry only moves to Decided automatically when the message is an
 *     unconditional confirmation AND it comes from the person the entry
 *     was waiting on (or its decider). Anything else is kept as a
 *     "possible confirmation" for the owner to accept or dismiss.
 * ================================================
 */
const OPEN_STATUSES = ['needs-approval', 'conditional', 'not-agreed', 'unclear'];
const APPROVAL_WORDS = /\b(approved?|approval|confirm(ed|s|ing)?|sign(ed|s)?[ -]off|accept(ed|s)?|agreed?|go ahead|good to go|no conditions|cleared?|pass(ed|es)?|done|lgtm|yes)\b/i;

/** Open entries a message MIGHT be about. Free: no model involved. */
const messageCandidates = (text) => {
    const words = keywords(text);
    if (words.length === 0) return [];
    const approving = APPROVAL_WORDS.test(clean(text));
    return readLedger().entries
        .filter((e) => OPEN_STATUSES.includes(e.status))
        .map((entry) => {
            const hay = [entry.statement, entry.missing, entry.conditionLabel, entry.project, entry.rationale].join(' ').toLowerCase();
            return { entry, hits: words.filter((w) => w.length > 2 && hay.includes(w)).length };
        })
        // Two shared words, or one plus an approving word ("DPA approved").
        .filter((x) => x.hits >= 2 || (x.hits >= 1 && approving))
        .sort((a, b) => b.hits - a.hits)
        .slice(0, 8)
        .map((x) => x.entry);
};

/** ONE API call: does this message confirm, block or change one of the candidates? */
const judgeMessage = async (message, candidates, apiKey) => {
    if (!apiKey || candidates.length === 0) return null;
    const system = [
        'Punctuation rule: NEVER use an em dash ("\u2014") anywhere you write. Use a comma, full stop, or hyphen instead.',
        'You are Clarus, an agent that keeps a company decision ledger. A message was posted in a work',
        'channel the company connected to the ledger. You are given the message and the ledger entries',
        'that are still OPEN. Decide whether the message settles one of them.',
        '',
        '- match: the id of the ONE entry the message is clearly about, or null. A message on another',
        '  subject, a question, a joke or general chatter matches nothing. When unsure, null.',
        '- effect: "confirms" if it gives the approval, confirmation or answer the entry was waiting',
        '  for; "blocks" if it refuses it or says it is not ready; "none" otherwise.',
        '- unconditional: true only if a confirmation comes with no strings attached ("approved, no',
        '  conditions"). "Approved once the audit is done" is NOT unconditional.',
        '- note: one plain sentence saying what the message did, e.g. "Priya approved the DPA wording',
        '  with no conditions."',
        'You only report what the message says. You never decide anything yourself.',
        '',
        'Reply with ONLY strict JSON on one line:',
        '{"match": "<id>"|null, "effect": "confirms"|"blocks"|"none", "unconditional": true|false, "note": "..."}',
    ].join('\n');
    const user = `Message from ${message.who || 'someone'}${message.channel ? ` in #${message.channel}` : ''}: "${clean(message.text).slice(0, 1500)}"\n\nOpen ledger entries:\n${candidates.map(entryLine).join('\n')}`;
    try {
        const parsed = await askModel(apiKey, system, user, 300);
        const entry = candidates.find((e) => e.id === parsed.match);
        if (!entry || (parsed.effect !== 'confirms' && parsed.effect !== 'blocks')) return null;
        return { entryId: entry.id, effect: parsed.effect, unconditional: parsed.unconditional === true, note: clean(parsed.note) };
    } catch (error) {
        console.error('LEDGER >>> message check skipped:', error instanceof Error ? error.message : error);
        return null;
    }
};

/** Is the speaker the person this entry was waiting on (or its decider)? */
const speakerIsNamed = (entry, who) => {
    const named = `${entry.missing || ''} ${entry.decider || ''}`.toLowerCase();
    return clean(who).toLowerCase().split(/[^a-z0-9]+/).some((part) => part.length >= 3 && new RegExp(`\\b${part}\\b`).test(named));
};

/**
 * Attaches outside proof to an entry. Returns what happened so the
 * caller can write the `proof-attached` audit event.
 *   proof: { source, quote, who, when, link, channel }
 *   judged: { effect, unconditional, note } from judgeMessage
 */
const attachExternalProof = (entryId, proof, judged) => {
    const ledger = readLedger();
    const entry = ledger.entries.find((e) => e.id === entryId);
    if (!entry || !OPEN_STATUSES.includes(entry.status)) return { ok: false, reason: 'entry is not open' };
    const already = [...(entry.proof || []), ...(entry.possibleProof || [])].some((p) => p.link && p.link === proof.link);
    if (already) return { ok: false, reason: 'already recorded' };
    const at = new Date().toISOString();
    const where = proof.channel ? ` in #${proof.channel}` : '';
    const sourceName = proof.source.charAt(0).toUpperCase() + proof.source.slice(1);
    const base = {
        id: `p${crypto.randomBytes(4).toString('hex')}`,
        source: proof.source, quote: clean(proof.quote), who: clean(proof.who), when: proof.when || at,
        link: proof.link || null, channel: proof.channel || null, recordFile: null, note: judged.note || '',
    };
    const settles = judged.effect === 'confirms' && judged.unconditional && speakerIsNamed(entry, proof.who);
    if (settles) {
        const was = entry.status;
        entry.proof = [...(entry.proof || []), { ...base, kind: 'confirmation', label: `${sourceName} · confirmed${where}` }];
        entry.status = 'decided';
        entry.missing = '';
        entry.updatedAt = at;
        entry.history.push({ at, event: 'proof-attached', detail: `${base.who} confirmed${where}: "${base.quote}". Was: ${was}, now decided` });
        writeLedger(ledger);
        console.log(`LEDGER PROOF >>> "${entry.statement}" confirmed by ${base.who}${where} - now decided`);
        return { ok: true, attached: true, moved: true, entry, proof: base };
    }
    // Not certain enough to move anything: keep it for the owner to judge.
    entry.possibleProof = [...(entry.possibleProof || []), {
        ...base,
        kind: judged.effect === 'blocks' ? 'objection' : 'confirmation',
        label: `${sourceName} · ${judged.effect === 'blocks' ? 'objection' : 'possible confirmation'}${where}`,
        wouldDecide: judged.effect === 'confirms' && judged.unconditional,
    }];
    entry.updatedAt = at;
    entry.history.push({ at, event: 'possible-proof', detail: `${base.who}${where}: "${base.quote}" - kept for the owner to accept or dismiss` });
    writeLedger(ledger);
    console.log(`LEDGER PROOF >>> possible ${judged.effect === 'blocks' ? 'objection' : 'confirmation'} for "${entry.statement}" from ${base.who}${where} - waiting for the owner`);
    return { ok: true, attached: false, possible: true, entry, proof: base };
};

/** The owner accepts or dismisses a possible confirmation. */
const resolvePossibleProof = (entryId, proofId, op, by) => {
    const ledger = readLedger();
    const entry = ledger.entries.find((e) => e.id === entryId);
    const pending = entry && (entry.possibleProof || []).find((p) => p.id === proofId);
    if (!entry || !pending) return { ok: false, status: 404, error: 'that possible confirmation was not found' };
    const at = new Date().toISOString();
    const who = clean(by) || 'the owner';
    entry.possibleProof = entry.possibleProof.filter((p) => p.id !== proofId);
    if (op === 'accept') {
        const { wouldDecide, ...kept } = pending;
        entry.proof = [...(entry.proof || []), { ...kept, label: kept.label.replace('possible confirmation', 'confirmed'), acceptedBy: who }];
        const was = entry.status;
        if (wouldDecide && OPEN_STATUSES.includes(entry.status)) { entry.status = 'decided'; entry.missing = ''; }
        entry.history.push({ at, event: 'proof-attached', detail: `${who} accepted ${pending.who}'s message as proof${entry.status !== was ? `. Was: ${was}, now ${entry.status}` : ''}` });
    } else {
        entry.history.push({ at, event: 'proof-dismissed', detail: `${who} dismissed ${pending.who}'s message as proof` });
    }
    entry.updatedAt = at;
    writeLedger(ledger);
    return { ok: true, accepted: op === 'accept', entry, proof: pending };
};

module.exports = {
    STATUSES, NO_PROJECT, ledgerDir, ledgerFile, readLedger, writeLedger,
    entriesFromRecord, refineWithModel, upsert, writeFromRecord, noteOnRecord, backfill, list, get,
    detectClashes, openClashes, resolveClash, dismissClash, appendRecordEvent, draftAskDecider, checkClosure,
    messageCandidates, judgeMessage, attachExternalProof, resolvePossibleProof, OPEN_STATUSES,
    ask, relevantEntries, createToken, tokenStatus, revokeToken, checkToken, bearer,
};
