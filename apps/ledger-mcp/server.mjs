#!/usr/bin/env node
/**
 * Clarus ledger MCP server (Phase 18 M5).
 *
 * Lets Claude, Copilot and other AI tools CHECK the company decision
 * ledger before they act. Strictly read-only: three tools, each a GET
 * against the Clarus ledger API. It cannot change, add or delete anything.
 *
 * No dependencies and no build step on purpose: it speaks the MCP stdio
 * protocol (newline-delimited JSON-RPC 2.0) directly, so the whole setup
 * is "node server.mjs" plus two settings:
 *
 *   CLARUS_URL    where the cockpit lives, e.g. https://app.meetclarus.com
 *                 (or http://localhost:4300 for the local bot)
 *   CLARUS_TOKEN  the read-only API token from the Ledger view
 *
 * Nothing is ever written to stdout except protocol messages; logs go to
 * stderr, which is where MCP clients expect them.
 */
import readline from 'node:readline';

const BASE = (process.env.CLARUS_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.CLARUS_TOKEN || '';
const OPEN_STATUSES = ['needs-approval', 'conditional', 'not-agreed', 'unclear'];
const STATUS_LABEL = {
    'decided': 'Decided', 'needs-approval': 'Needs approval', 'conditional': 'Conditional',
    'not-agreed': 'Not agreed yet', 'unclear': 'Unclear wording', 'superseded': 'Superseded',
};

const log = (...args) => console.error('[clarus-ledger]', ...args);

/** One GET against the ledger API. Errors come back as plain sentences. */
const api = async (pathname) => {
    if (!BASE) throw new Error('CLARUS_URL is not set. Point it at your Clarus cockpit, e.g. https://app.meetclarus.com');
    if (!TOKEN) throw new Error('CLARUS_TOKEN is not set. Create a token in the Clarus Ledger view (Connect other tools).');
    let response;
    try {
        response = await fetch(`${BASE}${pathname}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    } catch (error) {
        throw new Error(`Could not reach Clarus at ${BASE} (${error instanceof Error ? error.message : error}).`);
    }
    if (response.status === 401) throw new Error('Clarus refused the token. It may have been revoked or replaced: create a new one in the Ledger view.');
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Clarus answered ${response.status}.`);
    return response.json();
};

/** A decision as a short, readable block. AI tools read this text. */
const describe = (e, full = false) => {
    const lines = [
        `${e.statement}`,
        `  status: ${STATUS_LABEL[e.status] || e.status} | project: ${e.project} | date: ${String(e.date).slice(0, 10)} | id: ${e.id}`,
    ];
    if (e.decider) lines.push(`  agreed by: ${e.decider}`);
    if (e.rationale) lines.push(`  why: ${e.rationale}`);
    if (e.missing) lines.push(`  ${e.status === 'superseded' ? 'replaced by' : 'missing'}: ${e.missing}`);
    if (e.sourceMeeting && e.sourceMeeting.name) lines.push(`  meeting: ${e.sourceMeeting.name}`);
    const proof = (e.proof || []).slice(0, full ? 20 : 1);
    for (const p of proof) lines.push(`  ${p.kind === 'reason' ? 'reason' : 'proof'} (${p.source}, ${p.who}): "${p.quote}"`);
    if (full) {
        if (e.supersededBy) lines.push(`  superseded by entry: ${e.supersededBy}`);
        if (e.supersedes) lines.push(`  supersedes entry: ${e.supersedes}`);
        for (const h of (e.history || [])) lines.push(`  history ${String(h.at).slice(0, 16).replace('T', ' ')}: ${h.event} - ${h.detail}`);
    }
    return lines.join('\n');
};

const TOOLS = [
    {
        name: 'search_decisions',
        description: 'Search the Clarus company decision ledger. Returns decisions with their status (Decided, Needs approval, Conditional, Not agreed yet, Unclear wording, Superseded), who agreed them, the stated reason and the exact words that prove them. Check this before acting on something a meeting may have decided. A Superseded entry has been replaced: follow "replaced by".',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Words to look for, e.g. "launch date" or "vendor contract". Leave empty to list everything in the project.' },
                project: { type: 'string', description: 'Exact project name to limit the search to, e.g. "Project Atlas".' },
                status: { type: 'string', enum: Object.keys(STATUS_LABEL), description: 'Only entries with this status.' },
            },
        },
    },
    {
        name: 'get_decision',
        description: 'Get one decision from the Clarus ledger by its id, with all of its proof, its full history and what it superseded or was superseded by.',
        inputSchema: {
            type: 'object',
            properties: { id: { type: 'string', description: 'The entry id from search_decisions.' } },
            required: ['id'],
        },
    },
    {
        name: 'list_open_items',
        description: 'List everything in the Clarus ledger that is NOT settled yet: decisions waiting on an approver, conditional on something, not agreed, or left with unclear wording, each with what is still missing.',
        inputSchema: {
            type: 'object',
            properties: { project: { type: 'string', description: 'Exact project name to limit the list to.' } },
        },
    },
];

const query = (params) => {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value) qs.set(key, String(value));
    return qs.toString() ? `?${qs}` : '';
};

const callTool = async (name, args) => {
    if (name === 'search_decisions') {
        const data = await api(`/api/ledger${query({ q: args.query, project: args.project, status: args.status })}`);
        const entries = (data && data.entries) || [];
        if (entries.length === 0) {
            const known = (data && data.projects && data.projects.length) ? ` Projects on record: ${data.projects.join(', ')}.` : '';
            return `The ledger has no matching decision.${known}`;
        }
        return `${entries.length} decision${entries.length === 1 ? '' : 's'} found:\n\n${entries.slice(0, 25).map((e) => describe(e)).join('\n\n')}`;
    }
    if (name === 'get_decision') {
        if (!args.id) throw new Error('get_decision needs an id.');
        const entry = await api(`/api/ledger/${encodeURIComponent(args.id)}`);
        return entry ? describe(entry, true) : `The ledger has no entry with id "${args.id}".`;
    }
    if (name === 'list_open_items') {
        const data = await api(`/api/ledger${query({ project: args.project })}`);
        const open = ((data && data.entries) || []).filter((e) => OPEN_STATUSES.includes(e.status));
        if (open.length === 0) return 'Nothing is open: every decision on record is settled or superseded.';
        return `${open.length} open item${open.length === 1 ? '' : 's'}:\n\n${open.map((e) => describe(e)).join('\n\n')}`;
    }
    throw new Error(`Unknown tool: ${name}`);
};

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

const handle = async (message) => {
    const { id, method, params } = message;
    const isRequest = id !== undefined && id !== null;
    try {
        if (method === 'initialize') {
            send({ jsonrpc: '2.0', id, result: {
                protocolVersion: (params && params.protocolVersion) || '2024-11-05',
                capabilities: { tools: {} },
                serverInfo: { name: 'clarus-ledger', version: '1.0.0' },
                instructions: 'Read-only access to the Clarus company decision ledger. Use it to check what was decided, by whom and why, before acting.',
            } });
        } else if (method === 'ping') {
            send({ jsonrpc: '2.0', id, result: {} });
        } else if (method === 'tools/list') {
            send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
        } else if (method === 'tools/call') {
            try {
                const text = await callTool(params && params.name, (params && params.arguments) || {});
                send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
            } catch (error) {
                // A tool failure is reported to the model as a result, not a protocol error.
                send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true } });
            }
        } else if (isRequest) {
            send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
        }
        // Notifications (no id), e.g. notifications/initialized, need no reply.
    } catch (error) {
        if (isRequest) send({ jsonrpc: '2.0', id, error: { code: -32603, message: error instanceof Error ? error.message : 'Internal error' } });
    }
};

const lines = readline.createInterface({ input: process.stdin, terminal: false });
lines.on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
    void handle(message);
});
lines.on('close', () => process.exit(0));
log(`ready (${BASE || 'CLARUS_URL not set'})`);
