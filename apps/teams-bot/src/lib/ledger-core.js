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

const STATUSES = ['decided', 'needs-approval', 'conditional', 'not-agreed', 'unclear', 'superseded'];
const NO_PROJECT = 'No project';

const ledgerDir = () =>
    process.env.LEDGER_DIR
    || process.env.ZEUS_LEDGER_DIR
    || (process.env.RECORDS_DIR ? path.join(process.env.RECORDS_DIR, 'ledger') : path.join(process.cwd(), 'ledger'));
const ledgerFile = () => path.join(ledgerDir(), 'ledger.json');

/** The whole ledger; an empty one when the file does not exist yet. */
const readLedger = () => {
    try {
        const parsed = JSON.parse(fs.readFileSync(ledgerFile(), 'utf8'));
        return { v: 1, entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
    } catch {
        return { v: 1, entries: [] };
    }
};

/** Written to a temp file first, then renamed - a crash never leaves half a ledger. */
const writeLedger = (ledger) => {
    fs.mkdirSync(ledgerDir(), { recursive: true });
    const tmp = `${ledgerFile()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, entries: ledger.entries }, null, 2), { mode: 0o600 });
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
        const response = await fetch('https://api.anthropic.com/v1/messages', {
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
    console.log(`LEDGER >>> "${record.meetingName || 'Untitled meeting'}" [${entries[0].project}]: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} (${added} new, ${updated} updated)${usedModel ? '' : ' - plain wording, no model call'}`);
    return { entries, added, updated, usedModel };
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

/** The Ledger view's data: filtered entries (newest first) plus the filter options. */
const list = (filters = {}) => {
    const all = readLedger().entries;
    const project = clean(filters.project);
    const status = clean(filters.status);
    const q = clean(filters.q).toLowerCase();
    const entries = all
        .filter((e) => !project || e.project === project)
        .filter((e) => !status || e.status === status)
        .filter((e) => !q || [e.statement, e.rationale, e.missing, e.decider, e.conditionLabel, e.project].join(' ').toLowerCase().includes(q))
        .sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const inProject = all.filter((e) => !project || e.project === project);
    const counts = {};
    for (const s of STATUSES) counts[s] = inProject.filter((e) => e.status === s).length;
    return {
        entries,
        projects: [...new Set(all.map((e) => e.project))].sort(),
        counts,
        total: inProject.length,
    };
};

const get = (id) => readLedger().entries.find((e) => e.id === id) || null;

module.exports = {
    STATUSES, NO_PROJECT, ledgerDir, ledgerFile, readLedger, writeLedger,
    entriesFromRecord, refineWithModel, upsert, writeFromRecord, noteOnRecord, backfill, list, get,
};
