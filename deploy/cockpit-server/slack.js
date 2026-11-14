/**
 * Clarus <-> Slack (Phase 18 M6). Hosted hub only: Slack has to reach
 * Clarus at a public address, so the local bot has no Slack side.
 *
 * Three jobs, one Slack app:
 *   PROOF IN        a message in a channel the app was invited to can
 *                   confirm an open ledger entry (Events API, never
 *                   history polling).
 *   ANSWERS OUT     `/clarus ask <question>` and @mentions are answered
 *                   from the ledger, visible only to the asker.
 *   DECISIONS POSTED a drafted channel post, sent ONLY when the owner
 *                   approves it (a `slack-post` follow-up action).
 *
 * Dependency-free like the rest of the hub: Slack's signature check and
 * its Web API are a few lines of crypto and fetch.
 *
 * Railway variables on the COCKPIT service (secrets, never in code):
 *   SLACK_SIGNING_SECRET   proves a request really came from Slack
 *   SLACK_BOT_TOKEN        xoxb-... lets Clarus read names and post
 *   SLACK_DEFAULT_CHANNEL  optional, pre-fills the channel on drafts
 *
 * Scopes (kept minimal, listed in NOTES.md): channels:history,
 * channels:read, users:read, app_mentions:read, chat:write, commands.
 */
const crypto = require('crypto');

const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || '';
const BOT_TOKEN = process.env.SLACK_BOT_TOKEN || '';
const DEFAULT_CHANNEL = (process.env.SLACK_DEFAULT_CHANNEL || '').replace(/^#/, '');
/** Slack's API. SLACK_API_BASE exists so tests can point it at a stand-in. */
const API_BASE = (process.env.SLACK_API_BASE || 'https://slack.com/api').replace(/\/+$/, '');

const configured = () => Boolean(SIGNING_SECRET && BOT_TOKEN);
const status = () => ({ configured: configured(), defaultChannel: DEFAULT_CHANNEL || null });

/**
 * Slack signs every request: HMAC-SHA256 of "v0:<timestamp>:<raw body>"
 * with the signing secret. A stale timestamp (over 5 minutes) is refused
 * so a captured request cannot be replayed.
 */
const verify = (req, rawBody) => {
    if (!SIGNING_SECRET) return false;
    const timestamp = String(req.headers['x-slack-request-timestamp'] || '');
    const signature = String(req.headers['x-slack-signature'] || '');
    if (!/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
    const expected = `v0=${crypto.createHmac('sha256', SIGNING_SECRET).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
};

/** One Slack Web API call. Slack answers 200 with { ok: false, error } on failure. */
const web = async (method, params) => {
    const response = await fetch(`${API_BASE}/${method}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${BOT_TOKEN}`, 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
        body: new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])).toString(),
    });
    const data = await response.json().catch(() => ({ ok: false, error: `http_${response.status}` }));
    if (!data.ok) throw new Error(data.error || 'slack_error');
    return data;
};

/** Slack's error codes, in words the owner can act on. */
const explain = (code) => ({
    not_in_channel: 'Clarus is not in that channel. In Slack, type /invite @Clarus in the channel, then approve again.',
    channel_not_found: 'Slack could not find that channel. Check the name, and invite Clarus to it if it is private.',
    invalid_auth: 'Slack refused the bot token. Check SLACK_BOT_TOKEN on the cockpit service.',
    not_authed: 'No Slack bot token is set. Add SLACK_BOT_TOKEN on the cockpit service.',
    missing_scope: 'The Slack app is missing a permission. Add the scopes listed in NOTES.md and reinstall the app.',
    is_archived: 'That channel is archived.',
}[code] || `Slack said: ${code}`);

// Names are looked up once and remembered (they rarely change).
const nameCache = new Map();
const userName = async (userId) => {
    if (!userId) return '';
    if (nameCache.has(userId)) return nameCache.get(userId);
    try {
        const { user } = await web('users.info', { user: userId });
        const name = (user && (user.real_name || (user.profile && user.profile.display_name) || user.name)) || userId;
        nameCache.set(userId, name);
        return name;
    } catch { return userId; }
};
const channelName = async (channelId) => {
    if (!channelId) return '';
    if (nameCache.has(channelId)) return nameCache.get(channelId);
    try {
        const { channel } = await web('conversations.info', { channel: channelId });
        const name = (channel && channel.name) || channelId;
        nameCache.set(channelId, name);
        return name;
    } catch { return channelId; }
};
const permalink = async (channel, ts) => {
    try { return (await web('chat.getPermalink', { channel, message_ts: ts })).permalink || null; } catch { return null; }
};

/** A ledger answer as Slack text: the answer, then the entries behind it. */
const STATUS_LABEL = {
    'decided': 'Decided', 'needs-approval': 'Needs approval', 'conditional': 'Conditional',
    'not-agreed': 'Not agreed yet', 'unclear': 'Unclear wording', 'superseded': 'Superseded',
};
const formatAnswer = (question, result) => {
    if (!result.ok) return `I could not check the ledger just now. ${result.error || ''}`.trim();
    const lines = [`*${question}*`, result.answer];
    for (const e of (result.cited || []).slice(0, 4)) {
        const quote = (e.proof || []).find((p) => p.kind !== 'reason');
        lines.push(`• *${e.statement}* (${STATUS_LABEL[e.status] || e.status}, ${e.project}, ${String(e.date).slice(0, 10)})`
            + `${quote ? `\n   _${quote.who}: "${quote.quote}"_` : ''}`);
    }
    lines.push('_Answered only from the Clarus decision ledger._');
    return lines.join('\n');
};

// Slack retries an event it thinks was missed; each event_id is handled once.
const seenEvents = new Set();
const firstSight = (eventId) => {
    if (!eventId) return true;
    if (seenEvents.has(eventId)) return false;
    seenEvents.add(eventId);
    if (seenEvents.size > 2000) seenEvents.delete(seenEvents.values().next().value);
    return true;
};

/**
 * One event from Slack, already verified and acknowledged. `deps` carries
 * the ledger, the API key and a callback that notes proof on the record.
 */
const handleEvent = async (payload, deps) => {
    const event = payload && payload.event;
    if (!event || !firstSight(payload.event_id)) return;

    if (event.type === 'app_mention') {
        const question = String(event.text || '').replace(/<@[^>]+>/g, '').trim();
        if (!question) return;
        const result = await deps.ledger.ask(question, { apiKey: deps.apiKey });
        await web('chat.postEphemeral', { channel: event.channel, user: event.user, text: formatAnswer(question, result), thread_ts: event.thread_ts })
            .catch((error) => console.error('SLACK >>> could not answer the mention:', explain(error.message)));
        return;
    }

    // PROOF IN: a person's ordinary message in a channel Clarus was invited to.
    if (event.type !== 'message' || event.subtype || event.bot_id || !event.text || !event.user) return;
    const candidates = deps.ledger.messageCandidates(event.text); // free pre-filter
    if (candidates.length === 0) return;
    const [who, channel] = await Promise.all([userName(event.user), channelName(event.channel)]);
    const judged = await deps.ledger.judgeMessage({ text: event.text, who, channel }, candidates, deps.apiKey); // ONE API call
    if (!judged) return;
    const link = await permalink(event.channel, event.ts);
    const outcome = deps.ledger.attachExternalProof(judged.entryId, {
        source: 'slack', quote: event.text, who, channel, link,
        when: new Date(Number(String(event.ts).split('.')[0]) * 1000).toISOString(),
    }, judged);
    if (outcome.ok) deps.onProof(outcome);
};

/**
 * `/clarus ask <question>`. Slack wants an answer within 3 seconds, so the
 * caller acknowledges at once and this posts the real answer to the
 * command's response_url. Ephemeral: only the asker sees it.
 */
const commandAck = (text) => {
    const question = String(text || '').replace(/^ask\s+/i, '').trim();
    if (!question || /^help$/i.test(question)) {
        return { question: '', reply: { response_type: 'ephemeral', text: 'Ask the decision ledger a question, for example:\n`/clarus ask Why did we move the Atlas launch to the 14th?`' } };
    }
    return { question, reply: { response_type: 'ephemeral', text: `Checking the ledger: _${question}_` } };
};
const answerCommand = async (question, responseUrl, deps) => {
    const result = await deps.ledger.ask(question, { apiKey: deps.apiKey });
    await fetch(responseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ response_type: 'ephemeral', replace_original: true, text: formatAnswer(question, result) }),
    }).catch((error) => console.error('SLACK >>> could not deliver the answer:', error instanceof Error ? error.message : error));
};

/**
 * DECISIONS POSTED: the draft. Built from a finished meeting's DECIDED
 * ledger entries with a fixed template (no API call). It is only a
 * proposed action: nothing reaches Slack until the owner approves it.
 */
const draftPost = (record, entries) => {
    const decided = entries.filter((e) => e.status === 'decided');
    if (!configured() || decided.length === 0) return null;
    const stillOpen = entries.length - decided.length;
    const body = [
        `Decisions from "${record.meetingName || 'the meeting'}"${entries[0].project && entries[0].project !== 'No project' ? ` (${entries[0].project})` : ''}:`,
        ...decided.map((e) => `• ${e.statement}${e.decider ? ` (${e.decider})` : ''}${e.rationale ? `\n   Why: ${e.rationale}` : ''}`),
        ...(stillOpen ? [`${stillOpen} item${stillOpen === 1 ? ' is' : 's are'} still open in the ledger.`] : []),
    ].join('\n');
    return {
        type: 'slack-post',
        title: `Post ${decided.length} decision${decided.length === 1 ? '' : 's'} to Slack`,
        body,
        source: 'Decided entries from this meeting, as recorded in the ledger',
        recipients: [],
        channel: DEFAULT_CHANNEL,
        status: 'proposed',
    };
};

/** Sends an APPROVED post. Throws a plain-English error when Slack refuses. */
const post = async (channel, text) => {
    const target = String(channel || '').trim().replace(/^#/, '');
    if (!configured()) throw new Error('Slack is not connected. Add SLACK_SIGNING_SECRET and SLACK_BOT_TOKEN on the cockpit service.');
    if (!target) throw new Error('Choose a channel to post to.');
    try {
        const sent = await web('chat.postMessage', { channel: target, text, unfurl_links: false });
        return { channel: target, channelId: sent.channel, ts: sent.ts, permalink: await permalink(sent.channel, sent.ts) };
    } catch (error) {
        throw new Error(explain(error instanceof Error ? error.message : String(error)));
    }
};

module.exports = { configured, status, verify, handleEvent, commandAck, answerCommand, draftPost, post, formatAnswer };
