/**
 * Zeus hosted cockpit — the hub.
 *
 * A standalone, dependency-free Node server that puts the cockpit on a real
 * URL. It is ADDITIVE ONLY: the normal local run
 * (npx tsx apps/teams-bot/src/gate.ts <link> → localhost:4300) is untouched
 * and does not use this file.
 *
 * Phase 7c: state is PER MEETING. Every meeting lives in its own drawer in
 * the `meetings` map, keyed by a meeting ID, with its own conditions,
 * transcript, nudges, mentions, timer, and steer queue — nothing shared.
 * Endpoints carry the meeting ID (/state/<id>, /command/<id>, /bot/state/<id>);
 * the old ID-less forms keep working by routing to the newest meeting, so
 * the ordinary single-meeting flow is byte-for-byte unchanged.
 *
 * Run:  node deploy/cockpit-server/server.js   (from the repo root)
 * Env:  PORT (default 4400), ACCESS_CODE, DEMO_MODE (default 1), BOT_TOKEN,
 *       MAX_MEETINGS (default 1 — Milestone 2 raises the default ceiling)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// Phase 10 on the hub: the owner's Outlook calendar (read-only, single
// owner). Reports configured:false when MS_CLIENT_ID/SECRET are absent —
// then nothing changes anywhere.
const calendar = require('./calendar');

const PORT = Number(process.env.PORT) || 4400;
const ACCESS_CODE = process.env.ACCESS_CODE || 'zeus-demo';
const DEMO_MODE = (process.env.DEMO_MODE ?? '1') !== '0';
const MAX_CONDITIONS = 5;
// Phase 7c Milestone 2: up to three meetings at once. Each is a full
// Chrome on the bot machine (~500MB+), so 3 is the deliberate ceiling —
// a 4th brief is politely refused.
const MAX_MEETINGS = Number(process.env.MAX_MEETINGS) || 3;
// The shared secret the cloud bot presents on /bot/* calls.
const BOT_TOKEN = process.env.BOT_TOKEN || '';
// Phase 9: the hub's own key for the chat-mode briefing (one call per
// owner message). Server-side only; without it the page shows the form.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

// The one cockpit page, shared with the local app.
const COCKPIT_PAGE = path.join(__dirname, '..', '..', 'apps', 'teams-bot', 'src', 'cockpit.html');

/**
 * ================================================
 * Persisted meeting records — one JSON file per completed meeting.
 * The cloud bot POSTs the finished record to /bot/record/<id>; the
 * cockpit reads it back via /history. Same file shape as the local
 * bot's records/ directory. NOTE: on Railway this directory is only
 * durable if a volume is mounted at RECORDS_DIR — documented in NOTES.md.
 * ================================================
 */
const RECORDS_DIR = process.env.RECORDS_DIR || path.join(process.cwd(), 'records');

const writeRecordFile = (record) => {
    try {
        fs.mkdirSync(RECORDS_DIR, { recursive: true });
        const file = path.join(RECORDS_DIR, `${String(record.endedAt).replace(/[:.]/g, '-')}-${record.id}.json`);
        fs.writeFileSync(file, JSON.stringify(record, null, 2));
        console.log(`RECORD SAVED >>> ${file}`);
        return true;
    } catch (error) {
        console.error('RECORD SAVE FAILED >>>', error);
        return false;
    }
};

/** All records, newest first — same shape as the local bot's /history */
const listRecords = () => {
    let files = [];
    try {
        files = fs.readdirSync(RECORDS_DIR).filter((f) => f.endsWith('.json'));
    } catch {
        return [];
    }
    const entries = [];
    for (const file of files) {
        try {
            const record = JSON.parse(fs.readFileSync(path.join(RECORDS_DIR, file), 'utf8'));
            entries.push({
                file,
                meetingName: record.meetingName || 'Untitled meeting',
                ownerName: record.ownerName || '',
                endedAt: record.endedAt || '',
                durationMinutes: record.durationMinutes ?? null,
                conditionsTotal: (record.conditions || []).length,
                conditionsClosed: (record.conditions || []).filter((c) => c.status === 'closed').length,
                editedMidCall: Boolean(record.editedMidCall),
                hasSummary: Boolean(record.summary),
            });
        } catch { /* a corrupt file must not break the whole history */ }
    }
    return entries.sort((a, b) => b.endedAt.localeCompare(a.endedAt));
};

const readRecord = (file) => {
    if (!/^[0-9A-Za-z\-]+\.json$/.test(file)) return null;
    try {
        return JSON.parse(fs.readFileSync(path.join(RECORDS_DIR, file), 'utf8'));
    } catch {
        return null;
    }
};

const computeMetrics = (entries) => {
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

/**
 * ================================================
 * Sessions — who has entered the access code
 * ================================================
 */
const sessions = new Set();

const parseCookies = (req) => {
    const header = req.headers.cookie || '';
    const cookies = {};
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq > 0) {
            cookies[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
        }
    }
    return cookies;
};

const isAuthed = (req) => sessions.has(parseCookies(req).zeus_session || '');

/**
 * ================================================
 * Meetings — one drawer of state per meeting, keyed by ID
 * ================================================
 */
const startedAt = new Date().toISOString();
/** meetingId -> meeting state (see createMeeting for the shape) */
const meetings = new Map();

const createMeeting = ({ meetingName, labels, context, lengthMinutes, ownerName, meetingUrl, meetingStart, calendarEventId }) => {
    const id = crypto.randomBytes(4).toString('hex');
    const meeting = {
        id,
        briefedAt: new Date().toISOString(),
        meetingName,
        // A calendar-picked meeting that starts later shows as scheduled
        // until the bot takes over the status on its check-ins.
        meetingStatus: (meetingStart && Date.parse(meetingStart) > Date.now()) ? 'scheduled' : 'connecting',
        scheduledMinutes: lengthMinutes,
        meetingJoinedAt: null,
        ownerName,
        meetingUrl,
        meetingStart: meetingStart || null, // ISO start from the calendar pick, null when unknown
        calendarEventId: calendarEventId || null, // lets the hub follow the event if it moves
        killReason: null, // set when the hub itself stands the agent down (e.g. event cancelled)
        context,
        conditions: labels.map((label, index) => ({ id: `c${index}`, label, status: 'open', nudges: 0 })),
        nudges: [],
        transcript: [],
        mentions: [],
        // Hub-side plumbing between the website and the cloud bot:
        briefClaimed: false, // the bot has collected this brief and owns the meeting
        steerQueue: [],      // owner instructions waiting for the bot's next check-in
        editQueue: [],       // live board edits waiting for the bot's next check-in
        killRequested: false, // the owner pressed Kill bot — the bot wraps up on its next check-in
    };
    meetings.set(id, meeting);
    return meeting;
};

/** Newest meeting first — the routing order for the ID-less legacy endpoints */
const meetingList = () => [...meetings.values()].sort((a, b) => b.briefedAt.localeCompare(a.briefedAt));

/** The meeting an ID-less request means: the newest one (there is at most one until Milestone 2). */
const defaultMeeting = () => meetingList()[0] ?? null;

const buildStateJson = (meeting) => {
    // Same nudge-fate derivation as the local CockpitServer.
    const nudgesWithStatus = meeting.nudges.map((nudge, index) => {
        const condition = nudge.conditionId === null
            ? undefined
            : meeting.conditions.find((c) => c.id === nudge.conditionId);
        let status;
        if (nudge.conditionId === null) {
            status = 'sent';
        } else if (condition && condition.status === 'closed') {
            status = 'landed';
        } else if (meeting.nudges.some((other, otherIndex) => otherIndex > index && other.conditionId === nudge.conditionId)) {
            status = 'ignored';
        } else {
            status = 'waiting';
        }
        return { ...nudge, conditionLabel: condition ? condition.label : 'your steer', status };
    }).reverse();

    return {
        startedAt,
        meetingId: meeting.id,
        briefed: true,
        briefedAt: meeting.briefedAt,
        meetingName: meeting.meetingName,
        meetingStatus: meeting.meetingStatus,
        scheduledMinutes: meeting.scheduledMinutes,
        meetingJoinedAt: meeting.meetingJoinedAt,
        conditions: meeting.conditions,
        nudges: nudgesWithStatus,
        transcript: meeting.transcript,
        ownerName: meeting.ownerName,
        mentions: [...meeting.mentions].reverse(),
        meetingUrl: meeting.meetingUrl,
        meetingStart: meeting.meetingStart,
        chatBriefing: Boolean(ANTHROPIC_API_KEY),
        // The hosted kill switch: POST /kill/<id> queues a shutdown the
        // cloud bot honours on its next 2s check-in.
        canShutdown: true,
    };
};

/** What /state answers when no meeting exists — the page shows the briefing screen. */
const emptyStateJson = () => ({
    startedAt,
    meetingId: null,
    briefed: false,
    briefedAt: null,
    meetingName: null,
    meetingStatus: 'connecting',
    scheduledMinutes: 30,
    meetingJoinedAt: null,
    conditions: [],
    nudges: [],
    transcript: [],
    ownerName: '',
    mentions: [],
    meetingUrl: '',
    chatBriefing: Boolean(ANTHROPIC_API_KEY),
});

/** The overseer rollup — one row per running meeting (used by the summary view). */
const buildSummaryJson = () => ({
    maxMeetings: MAX_MEETINGS,
    meetings: meetingList().map((meeting) => ({
        id: meeting.id,
        meetingName: meeting.meetingName,
        briefedAt: meeting.briefedAt,
        meetingStatus: meeting.meetingStatus,
        scheduledMinutes: meeting.scheduledMinutes,
        meetingJoinedAt: meeting.meetingJoinedAt,
        meetingStart: meeting.meetingStart,
        ownerName: meeting.ownerName,
        conditionsTotal: meeting.conditions.length,
        conditionsClosed: meeting.conditions.filter((c) => c.status === 'closed').length,
        // One dot per condition on the phone dashboard: jade closed, red
        // needs-you (2+ nudges while open), amber still open.
        conditionStates: meeting.conditions.map((c) => c.status === 'closed' ? 'closed' : (c.nudges >= 2 ? 'exception' : 'open')),
        needsYou: meeting.conditions.some((c) => c.status === 'open' && c.nudges >= 2),
        mentioned: meeting.mentions.length > 0,
    })),
});

/**
 * ================================================
 * Calendar tracking — a meeting the agent has NOT yet joined follows its
 * calendar event: moved later → the agent waits longer; moved earlier
 * (even to right now) → it joins sooner; cancelled → it stands down.
 * Runs only for briefs that came from a calendar pick (calendarEventId).
 * ================================================
 */
const CAL_REFRESH_MS = Number(process.env.CAL_REFRESH_MS) || 60000;

const refreshCalendarMeetings = async () => {
    for (const meeting of meetings.values()) {
        if (!meeting.calendarEventId || meeting.meetingJoinedAt || meeting.killRequested) continue;
        let event;
        try {
            event = await calendar.getEvent(meeting.calendarEventId);
        } catch (error) {
            // Token hiccup / Graph blip — try again next round, say why once here.
            console.error(`CALENDAR TRACK >>> (${meeting.id}) could not re-read the event:`, error instanceof Error ? error.message : error);
            continue;
        }
        if (!event) {
            // Cancelled or deleted. A claimed meeting is stood down via the
            // bot (proper record + reset); an unclaimed one is just dropped.
            console.log(`CALENDAR TRACK >>> (${meeting.id}) "${meeting.meetingName}" was cancelled — standing the agent down.`);
            if (meeting.briefClaimed) {
                meeting.killRequested = true;
                meeting.killReason = 'the calendar meeting was cancelled or deleted';
            } else {
                meetings.delete(meeting.id);
            }
            continue;
        }
        if (event.start && event.start !== meeting.meetingStart) {
            console.log(`CALENDAR TRACK >>> (${meeting.id}) "${meeting.meetingName}" moved: ${meeting.meetingStart} → ${event.start}`);
            meeting.meetingStart = event.start;
            meeting.scheduledMinutes = event.durationMinutes || meeting.scheduledMinutes;
            // Unclaimed (demo) meetings keep their own status honest; a
            // claimed one gets its status from the bot's check-ins.
            if (!meeting.briefClaimed) {
                meeting.meetingStatus = Date.parse(event.start) > Date.now() + 120000 ? 'scheduled' : 'connecting';
            }
        }
        if (event.joinUrl && event.joinUrl !== meeting.meetingUrl) {
            meeting.meetingUrl = event.joinUrl; // rare, but keep the Join button honest
        }
    }
};
setInterval(() => { void refreshCalendarMeetings().catch(() => { /* next round */ }); }, CAL_REFRESH_MS);

/**
 * ================================================
 * Demo meeting — plays out against whatever conditions were typed
 * (only when DEMO_MODE=1; the production hub runs with the real bot)
 * ================================================
 */
const runDemoMeeting = (meeting) => {
    const [c0, c1, c2] = meeting.conditions;
    const owner = meeting.ownerName;
    const after = (seconds, fn) => setTimeout(() => { if (meetings.has(meeting.id)) fn(); }, seconds * 1000);
    const say = (speaker, text, hit = false) => {
        meeting.transcript.push({ speaker, text, ts: new Date().toISOString(), hit });
    };

    after(3, () => {
        meeting.meetingStatus = 'in-meeting';
        meeting.meetingJoinedAt = new Date().toISOString();
    });
    after(6, () => say('Maya', "Right, let's get going — where did we land after last week?"));
    after(11, () => say('Jordan', 'Good progress on our side, two options ready to show.'));
    after(16, () => say('Sam', 'Before that — did everyone see the summary I sent round?'));

    if (c0) {
        after(21, () => {
            meeting.nudges.push({
                text: `[ZEUS] Before we drift — can we get "${c0.label}" settled? What's the decision?`,
                conditionId: c0.id, steered: false, at: new Date().toISOString(),
            });
            c0.nudges++;
            c0.note = 'Agent has raised it — waiting on the room.';
        });
        after(29, () => say('Maya', `Fair point. Let's call it settled — consider ${c0.label.toLowerCase()} done, signed off as of today.`, true));
        after(31, () => {
            c0.status = 'closed';
            c0.note = 'Settled by Maya — signed off today.';
            c0.why = 'Maya stated the sign-off directly and nobody objected, so the room treats it as agreed.';
            c0.evidence = [{ speaker: 'Maya', quote: `Let's call it settled — consider ${c0.label.toLowerCase()} done, signed off as of today.` }];
        });
    }
    after(37, () => say('Jordan', "Great. I'll circulate the follow-ups after this."));
    if (owner) {
        after(43, () => {
            say('Sam', `Hold on — we can't finalise the rest until ${owner} takes a look.`);
            meeting.mentions.push({ speaker: 'Sam', quote: `Hold on — we can't finalise the rest until ${owner} takes a look.`, at: new Date().toISOString() });
        });
    }
    if (c1) {
        after(50, () => {
            meeting.nudges.push({
                text: `[ZEUS] One thing still open — "${c1.label}". Can we pin it down before we lose the room?`,
                conditionId: c1.id, steered: false, at: new Date().toISOString(),
            });
            c1.nudges++;
            c1.note = 'Agent has raised it — waiting on the room.';
            c1.why = 'It has been raised once but the discussion moved on without an answer.';
        });
        after(58, () => say('Maya', "Let's take that offline — next item."));
        after(66, () => {
            meeting.nudges.push({
                text: `[ZEUS] Flagging again before we wrap — "${c1.label}" is still open. Can someone own it now?`,
                conditionId: c1.id, steered: false, at: new Date().toISOString(),
            });
            c1.nudges++; // second nudge while open → the cockpit turns this card red: NEEDS YOU
            c1.why = 'Nudged twice and the room keeps deferring it — this is the one that needs the owner.';
        });
    }
    if (c2) {
        after(72, () => say('Jordan', `On ${c2.label.toLowerCase()} — we're close, just waiting on one confirmation.`));
        after(74, () => {
            c2.note = 'Close — waiting on one confirmation.';
            c2.why = 'Jordan says it is nearly there; one confirmation outstanding before it can close.';
        });
    }
    // Phase 13: closed conditions stay alive — the room revises its first
    // decision and the jade card updates in place.
    if (c0) {
        after(82, () => say('Jordan', `One thing on ${c0.label.toLowerCase()} — I think we were too hasty earlier.`));
        after(86, () => say('Maya', "Fair — let's revise it: keep it agreed, but at the higher figure we discussed.", true));
        after(88, () => {
            c0.note = 'Revised by Maya — still agreed, now at the higher figure.';
            c0.why = 'The room revisited the earlier decision and agreed a revised figure; the condition stays settled with the new facts.';
            c0.evidence = [{ speaker: 'Maya', quote: "Fair — let's revise it: keep it agreed, but at the higher figure we discussed." }];
        });
    }
};

/**
 * ================================================
 * Phase 9: the chat-mode briefing brain (hub edition).
 * Same conversation design as the local Nudger.briefChat, in plain JS —
 * and, now the hub has the calendar too, the SAME calendar-aware prompt:
 * the model matches what the owner says against their upcoming meetings
 * (by index — join links never leave the server) and only falls back to
 * a pasted link when there is no calendar to read.
 * One in-memory conversation per signed-in browser session.
 * ================================================
 */
const chatSessions = new Map(); // session token -> { history: [{from, text}], meetings: [UpcomingMeeting] }

const briefChatCall = async (history, meetingsMeta, calendarConnected) => {
    const inProgress = (m) => {
        const startMs = Date.parse(m.start);
        return startMs <= Date.now() && Date.now() < startMs + m.durationMinutes * 60000;
    };
    const calendarLines = meetingsMeta.length
        ? [
            "The owner's upcoming meetings (their calendar is connected):",
            ...meetingsMeta.map((m) => `  ${m.index}: "${m.subject}" — ${m.start} (${m.durationMinutes} min)${inProgress(m) ? ' [IN PROGRESS right now — the agent joins immediately]' : ''}${m.hasTeamsLink ? '' : ' [NO Teams link — cannot be chosen]'}`),
        ]
        : calendarConnected
            ? ["The owner's calendar IS connected but shows NOTHING in the next two weeks. Say so plainly if they describe a meeting (\"your calendar shows nothing in the next two weeks — is it on a different account? Paste the Teams link instead\") and take a pasted link."]
            : ["The owner's calendar is NOT connected — they must paste a Teams meeting link in the chat."];

    const system = [
        "You are Zeus bot's briefing assistant. Your owner — a busy person, often on their phone — is",
        'briefing you, by chat, for a meeting you will attend and drive for them. Keep every message',
        'short and direct: 1-2 sentences, one question at a time. Do NOT over-interview.',
        '',
        'The flow, in order:',
        '1. UNDERSTAND THE SITUATION. Ask AT MOST 1-2 follow-up questions across the WHOLE conversation,',
        '   and only if the answer would materially change the conditions (e.g. "Who holds the budget',
        '   decision?" or "Is there a figure already in play?"). If their first message is enough, skip',
        '   questions entirely.',
        '2. PROPOSE CONDITIONS. Set proposeConditions to 2-3 specific, concrete conditions — things that',
        '   must be TRUE by the end of the meeting, framed as outcomes.',
        '   Good: "Event budget confirmed with a number" / "Launch date agreed" / "Owner assigned for follow-ups".',
        '   Bad: "Discuss the budget" / "Talk about the timeline".',
        "   The owner sees them as editable cards with a confirm button — your reply should invite",
        '   tweaks ("Here\'s what I\'ll drive the room to close — edit anything"). When their next',
        '   message starts "Confirmed conditions:", those exact conditions are final — do not re-propose.',
        '3. WHICH MEETING. If their words clearly match exactly ONE meeting in the calendar list below,',
        '   set proposeMeeting to its index and ask for confirmation, naming it with its day and time',
        '   ("I\'ll assume you mean \'Marketing Launch Sync\', Thu 15:00 — right?"). NEVER guess between',
        '   several plausible matches and never invent meetings — if nothing matches confidently, set',
        '   showList true and ask them to tap one. A pasted Teams link also works; without a calendar,',
        '   ask them to paste the link ("Last thing — paste the meeting link and I\'ll send the agent',
        '   in."). Meetings marked [NO Teams link] cannot be chosen. When the owner confirms your',
        '   proposal (yes / that one / correct), the meeting is resolved.',
        '   You may resolve the meeting before or after the conditions — take whichever the owner gives',
        '   first, but never skip the condition-confirm step.',
        '4. Their name and extra context are optional — fold at most ONE ask for them into another',
        '   question; never spend a whole turn on them. Scheduled length comes from the calendar; for a',
        '   pasted link default to 30 unless they say otherwise.',
        '',
        ...calendarLines,
        '',
        `Today is ${new Date().toISOString().slice(0, 10)} (times are UTC).`,
        '',
        'Reply with ONLY strict JSON on one line, exactly this shape:',
        '{"reply": "...", "proposeMeeting": <calendar index>|null, "showList": true|false,',
        ' "proposeConditions": ["..."]|null,',
        ' "brief": null | {"meetingIndex": <index>|null, "meetingUrl": "<pasted link>"|null,',
        '   "meetingName": "...", "lengthMinutes": <n>, "ownerName": "...", "conditions": ["..."],',
        '   "context": "..."}}',
        'Set "brief" ONLY once the meeting is resolved (confirmed index, or pasted link) AND the owner',
        'has confirmed the conditions. Its reply is still shown — make it the send-off ("Sending the',
        "agent in now. You'll see it on your board.\").",
    ].join('\n');
    const conversation = history.map((m) => `${m.from === 'owner' ? 'Owner' : 'You'}: ${m.text}`).join('\n');
    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
        },
        body: JSON.stringify({
            model: 'claude-opus-4-8',
            max_tokens: 600,
            system,
            messages: [{ role: 'user', content: `Conversation so far:\n${conversation}` }],
        }),
    });
    if (!response.ok) {
        console.error(`brief-chat: Anthropic answered ${response.status}`);
        return null;
    }
    const data = await response.json();
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('').trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
        const parsed = JSON.parse(text.slice(start, end + 1));
        if (typeof parsed.reply !== 'string' || !parsed.reply.trim()) return null;
        return parsed;
    } catch {
        return null;
    }
};

/**
 * ================================================
 * The access-code screen (served until the code is entered)
 * ================================================
 */
const LOGIN_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Zeus — Command Centre</title>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700&family=Inter:wght@400;500&family=IBM+Plex+Mono:wght@400&display=swap" rel="stylesheet" media="print" onload="this.media='all'">
<style>
*{box-sizing:border-box;margin:0;padding:0;}
html,body{height:100%;background:#0d1210;color:#eef4f0;font-family:'Inter',sans-serif;font-size:14px;}
body{display:flex;align-items:center;justify-content:center;}
.card{width:min(400px,90vw);padding:8px;}
.mark{font-family:'Bricolage Grotesque',sans-serif;font-weight:700;font-size:20px;letter-spacing:-.4px;margin-bottom:22px;}
.mark em{font-style:normal;color:#43c293;}
h1{font-family:'Bricolage Grotesque',sans-serif;font-weight:600;font-size:24px;letter-spacing:-.5px;margin-bottom:6px;}
p{font-size:13px;color:#8fa39a;line-height:1.5;margin-bottom:22px;}
input{width:100%;background:#1a231f;border:1px solid rgba(255,255,255,.13);border-radius:10px;padding:12px 13px;color:#eef4f0;font-size:16px;outline:none;font-family:'IBM Plex Mono',monospace;letter-spacing:2px;}
input:focus{border-color:rgba(67,194,147,.32);}
button{margin-top:12px;width:100%;background:#43c293;border:none;border-radius:11px;padding:13px;font-family:'Bricolage Grotesque',sans-serif;font-weight:600;font-size:15px;color:#08110d;cursor:pointer;}
button:hover{filter:brightness(1.07);}
.err{margin-top:12px;font-size:12px;color:#e86a5e;text-align:center;min-height:16px;}
</style>
</head>
<body>
<div class="card">
  <div class="mark">ZEUS<em>.</em></div>
  <h1>Private cockpit</h1>
  <p>Enter the access code to open the command centre.</p>
  <input id="code" type="password" placeholder="access code" autocomplete="off" autofocus>
  <button onclick="go()">Enter →</button>
  <div class="err" id="err"></div>
</div>
<script>
async function go(){
  const code = document.getElementById('code').value.trim();
  if(!code) return;
  const r = await fetch('/login', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({code})});
  if(r.ok){ location.reload(); }
  else{ document.getElementById('err').textContent = 'Wrong code — try again.'; }
}
document.getElementById('code').addEventListener('keydown', (e) => { if(e.key==='Enter') go(); });
</script>
</body>
</html>`;

/**
 * ================================================
 * The web server
 * ================================================
 */
const readBody = (req) => new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
});

const answer = (res, code, payload) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
};

/** Pulls the trailing /<meetingId> off a path like /state/ab12cd34; null if absent */
const idFrom = (url, prefix) => {
    if (!url.startsWith(prefix + '/')) return null;
    const id = url.slice(prefix.length + 1);
    return /^[0-9a-f]{8}$/.test(id) ? id : null;
};

const server = http.createServer(async (req, res) => {
    const url = (req.url || '/').split('?')[0];

    // The front door: access code first, cockpit after.
    if (url === '/' || url === '/index.html') {
        // no-store: phones must always fetch the CURRENT page — a cached
        // copy from before a redeploy looks exactly like "the fix didn't
        // work" (no chat, old layout) with nothing wrong server-side.
        if (!isAuthed(req)) {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            res.end(LOGIN_PAGE);
            return;
        }
        fs.readFile(COCKPIT_PAGE, (error, html) => {
            if (error) {
                res.writeHead(500, { 'content-type': 'text/plain' });
                res.end('cockpit.html is missing');
                return;
            }
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            res.end(html);
        });
        return;
    }

    if (url === '/login' && req.method === 'POST') {
        const body = await readBody(req);
        let code = '';
        try { code = String(JSON.parse(body).code || ''); } catch { /* fall through */ }
        if (code !== ACCESS_CODE) {
            answer(res, 403, { ok: false });
            return;
        }
        const token = crypto.randomBytes(24).toString('hex');
        sessions.add(token);
        const secure = (req.headers['x-forwarded-proto'] === 'https') ? '; Secure' : '';
        res.writeHead(200, {
            'content-type': 'application/json',
            'set-cookie': `zeus_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=43200${secure}`,
        });
        res.end(JSON.stringify({ ok: true }));
        return;
    }

    // ── The cloud bot's endpoints — shared-secret auth, not cookies ──
    if (url.startsWith('/bot/')) {
        if (!BOT_TOKEN || req.headers['x-bot-token'] !== BOT_TOKEN) {
            answer(res, 403, { ok: false, error: 'bad bot token' });
            return;
        }
        if (url === '/bot/brief' && req.method === 'GET') {
            // Hand each brief over exactly once; the bot then owns that meeting.
            const unclaimed = meetingList().reverse().find((m) => !m.briefClaimed); // oldest first
            if (unclaimed) {
                unclaimed.briefClaimed = true;
                console.log(`BOT >>> collected brief ${unclaimed.id} ("${unclaimed.meetingName}")`);
                answer(res, 200, {
                    brief: {
                        meetingId: unclaimed.id,
                        meetingName: unclaimed.meetingName,
                        labels: unclaimed.conditions.map((c) => c.label),
                        context: unclaimed.context,
                        lengthMinutes: unclaimed.scheduledMinutes,
                        ownerName: unclaimed.ownerName,
                        meetingUrl: unclaimed.meetingUrl,
                        meetingStart: unclaimed.meetingStart, // the bot holds off joining until near this
                    },
                });
            } else {
                answer(res, 200, { brief: null });
            }
            return;
        }
        const stateId = idFrom(url, '/bot/state');
        if ((stateId || url === '/bot/state') && req.method === 'POST') {
            // The bot's snapshot replaces that meeting's hub copy; steers ride back.
            const meeting = stateId ? meetings.get(stateId) : defaultMeeting();
            if (!meeting) {
                answer(res, 404, { ok: false, error: 'meeting not found (ended?)' });
                return;
            }
            try {
                const snap = JSON.parse(await readBody(req));
                if (typeof snap.meetingStatus === 'string') meeting.meetingStatus = snap.meetingStatus;
                if (snap.meetingJoinedAt !== undefined) meeting.meetingJoinedAt = snap.meetingJoinedAt;
                if (Array.isArray(snap.conditions)) meeting.conditions = snap.conditions;
                if (Array.isArray(snap.nudges)) meeting.nudges = snap.nudges;
                if (Array.isArray(snap.transcript)) meeting.transcript = snap.transcript;
                if (Array.isArray(snap.mentions)) meeting.mentions = snap.mentions;
                const steers = meeting.steerQueue;
                meeting.steerQueue = [];
                const edits = meeting.editQueue;
                meeting.editQueue = [];
                // kill rides back on the check-in; the bot wraps the meeting
                // up (record + reset) exactly as if the call had ended.
                // meetingStart is the CURRENT calendar truth — a waiting bot
                // follows it when the event gets moved.
                answer(res, 200, {
                    ok: true, steers, edits,
                    kill: Boolean(meeting.killRequested),
                    killReason: meeting.killReason,
                    meetingStart: meeting.meetingStart,
                });
            } catch {
                answer(res, 400, { ok: false, error: 'body must be JSON' });
            }
            return;
        }
        const recordId = idFrom(url, '/bot/record');
        if (recordId && req.method === 'POST') {
            // The finished meeting's audit record — persist it to disk.
            try {
                const record = JSON.parse(await readBody(req));
                if (!record || typeof record !== 'object' || !record.endedAt || !record.id) {
                    answer(res, 400, { ok: false, error: 'not a meeting record' });
                    return;
                }
                answer(res, writeRecordFile(record) ? 200 : 500, { ok: true });
            } catch {
                answer(res, 400, { ok: false, error: 'body must be JSON' });
            }
            return;
        }
        const resetId = idFrom(url, '/bot/reset');
        if ((resetId || url === '/bot/reset') && req.method === 'POST') {
            // Meeting over — drop its drawer entirely; its memory goes with it.
            const meeting = resetId ? meetings.get(resetId) : defaultMeeting();
            if (meeting) {
                meetings.delete(meeting.id);
                console.log(`BOT >>> meeting ${meeting.id} ended and removed (${meetings.size} still running)`);
            }
            answer(res, 200, { ok: true });
            return;
        }
        answer(res, 404, { ok: false, error: 'unknown bot endpoint' });
        return;
    }

    // Everything below is the cockpit API — access code required.
    if (!isAuthed(req)) {
        answer(res, 401, { ok: false, error: 'access code required' });
        return;
    }

    // Per-meeting state, and the ID-less legacy form (newest meeting).
    const stateId = idFrom(url, '/state');
    if (url === '/state' || stateId) {
        if (stateId) {
            const meeting = meetings.get(stateId);
            if (!meeting) {
                answer(res, 404, { ok: false, error: 'meeting not found — it may have ended' });
                return;
            }
            answer(res, 200, buildStateJson(meeting));
            return;
        }
        const meeting = defaultMeeting();
        answer(res, 200, meeting ? buildStateJson(meeting) : emptyStateJson());
        return;
    }

    // The overseer rollup (one row per running meeting).
    if (url === '/summary') {
        answer(res, 200, buildSummaryJson());
        return;
    }

    if (url === '/setup' && req.method === 'POST') {
        try {
            const parsed = JSON.parse(await readBody(req));
            // The ceiling — checked AFTER the body arrives so two
            // near-simultaneous submits can't both slip through.
            if (meetings.size >= MAX_MEETINGS) {
                answer(res, 409, { ok: false, error: MAX_MEETINGS === 1 ? 'The agent is already handling a meeting — try again once it finishes.' : `${MAX_MEETINGS} meetings are already running — try again when one finishes.` });
                return;
            }
            const meetingUrl = typeof parsed.meetingUrl === 'string' ? parsed.meetingUrl.trim() : '';
            if (!DEMO_MODE && (!meetingUrl || !meetingUrl.includes('teams.'))) {
                answer(res, 400, { ok: false, error: 'A Teams meeting link is required so the agent knows where to go.' });
                return;
            }
            const labels = (Array.isArray(parsed.conditions) ? parsed.conditions : [])
                .filter((label) => typeof label === 'string')
                .map((label) => label.trim())
                .filter(Boolean);
            if (labels.length < 1 || labels.length > MAX_CONDITIONS) {
                answer(res, 400, { ok: false, error: `Give the agent 1 to ${MAX_CONDITIONS} conditions.` });
                return;
            }
            const rawLength = Number(parsed.lengthMinutes);
            const meeting = createMeeting({
                meetingName: (typeof parsed.meetingName === 'string' && parsed.meetingName.trim()) ? parsed.meetingName.trim() : 'Untitled meeting',
                labels,
                context: typeof parsed.context === 'string' ? parsed.context.trim() : '',
                lengthMinutes: Number.isFinite(rawLength) && rawLength > 0 ? Math.min(480, Math.max(1, Math.round(rawLength))) : 30,
                ownerName: typeof parsed.ownerName === 'string' ? parsed.ownerName.trim() : '',
                meetingUrl,
                meetingStart: (typeof parsed.meetingStart === 'string' && Number.isFinite(Date.parse(parsed.meetingStart))) ? parsed.meetingStart : null,
                calendarEventId: typeof parsed.calendarEventId === 'string' ? parsed.calendarEventId : null,
            });
            console.log(`BRIEFED >>> ${meeting.id} "${meeting.meetingName}" — ${labels.join(' | ')}${DEMO_MODE ? ' (demo meeting starting)' : ''} (${meetings.size}/${MAX_MEETINGS} running)`);
            // A future-start brief stays "scheduled" — the demo playback
            // would contradict the card, so it only runs for now-meetings.
            if (DEMO_MODE && meeting.meetingStatus !== 'scheduled') {
                runDemoMeeting(meeting);
            }
            answer(res, 200, { ok: true, meetingId: meeting.id });
        } catch {
            answer(res, 400, { ok: false, error: 'body must be JSON' });
        }
        return;
    }

    // Phase 9: the chat-mode briefing (hub edition — no calendar, so the
    // conversation always ends with a pasted link). A finished brief goes
    // through the same rules as /setup: max meetings, link required.
    if (url === '/brief-chat/reset' && req.method === 'POST') {
        // A freshly-loaded page starts a fresh conversation.
        chatSessions.delete(parseCookies(req).zeus_session || '');
        answer(res, 200, { ok: true });
        return;
    }
    if (url === '/brief-chat' && req.method === 'POST') {
        const token = parseCookies(req).zeus_session || '';
        if (!ANTHROPIC_API_KEY) {
            answer(res, 200, { reply: 'Chat briefing is not set up on this server — use the form.', propose: null, showList: false, meetings: [], briefed: false });
            return;
        }
        let text = '';
        try { text = String(JSON.parse(await readBody(req)).text || '').trim(); } catch { /* empty check below */ }
        if (!text) {
            answer(res, 400, { ok: false, error: 'text required' });
            return;
        }
        const session = chatSessions.get(token) || { history: [], meetings: [] };
        session.history.push({ from: 'owner', text });
        chatSessions.set(token, session);

        // Refresh the calendar view each turn (it may have just been
        // connected in another tab). Join URLs stay in session.meetings —
        // the model and the page only ever see index + metadata.
        let calendarConnected = false;
        try {
            const calStatus = await calendar.status();
            calendarConnected = calStatus.connected;
            if (calStatus.connected) {
                session.meetings = await calendar.upcomingMeetings();
            }
        } catch (error) {
            // The convenience failing must not kill the chat — but say WHY
            // in the log, or this is undebuggable.
            console.error('BRIEF-CHAT >>> calendar fetch failed:', error instanceof Error ? error.message : error);
        }
        const meetingsMeta = session.meetings.map((m, index) => ({
            index, subject: m.subject, start: m.start, durationMinutes: m.durationMinutes, hasTeamsLink: Boolean(m.joinUrl),
        }));
        console.log(`BRIEF-CHAT >>> calendar ${calendarConnected ? 'connected' : 'not connected'}, ${meetingsMeta.length} meeting(s) in view (${meetingsMeta.filter((m) => m.hasTeamsLink).length} with a Teams link)`);

        let result = null;
        try { result = await briefChatCall(session.history, meetingsMeta, calendarConnected); } catch (error) { console.error('brief-chat failed:', error); }
        if (!result) {
            const reply = 'Sorry — I tripped over myself there. Say that again?';
            session.history.push({ from: 'agent', text: reply });
            answer(res, 200, { reply, propose: null, showList: false, meetings: [], briefed: false });
            return;
        }
        session.history.push({ from: 'agent', text: result.reply });

        let briefedNow = false;
        let briefError = null;
        let meetingId = null;
        if (result.brief && typeof result.brief === 'object') {
            const b = result.brief;
            // Resolve the join link server-side: a confirmed calendar index
            // wins (its URL never left this process), then a pasted link.
            const picked = (typeof b.meetingIndex === 'number' && session.meetings[b.meetingIndex])
                ? session.meetings[b.meetingIndex]
                : undefined;
            const meetingUrl = (picked && picked.joinUrl)
                ? picked.joinUrl
                : (typeof b.meetingUrl === 'string' ? b.meetingUrl.trim() : '');
            const labels = (Array.isArray(b.conditions) ? b.conditions : [])
                .filter((l) => typeof l === 'string').map((l) => l.trim()).filter(Boolean);
            if (meetings.size >= MAX_MEETINGS) {
                briefError = `${MAX_MEETINGS} meetings are already running — try again when one finishes.`;
            } else if (!DEMO_MODE && (!meetingUrl || !meetingUrl.includes('teams.'))) {
                briefError = 'That link does not look like a Teams meeting link — paste it again?';
            } else if (labels.length < 1 || labels.length > MAX_CONDITIONS) {
                briefError = `I need 1 to ${MAX_CONDITIONS} conditions before I go in.`;
            } else {
                const rawLength = Number(picked ? picked.durationMinutes : b.lengthMinutes);
                const meeting = createMeeting({
                    meetingName: (typeof b.meetingName === 'string' && b.meetingName.trim()) ? b.meetingName.trim() : (picked ? picked.subject : 'Untitled meeting'),
                    labels,
                    context: typeof b.context === 'string' ? b.context.trim() : '',
                    lengthMinutes: Number.isFinite(rawLength) && rawLength > 0 ? Math.min(480, Math.max(1, Math.round(rawLength))) : 30,
                    ownerName: typeof b.ownerName === 'string' ? b.ownerName.trim() : '',
                    meetingUrl,
                    meetingStart: (picked && picked.start) || null,
                    calendarEventId: (picked && picked.id) || null,
                });
                console.log(`BRIEFED (chat) >>> ${meeting.id} "${meeting.meetingName}" — ${labels.join(' | ')} (${meetings.size}/${MAX_MEETINGS} running)`);
                if (DEMO_MODE && meeting.meetingStatus !== 'scheduled') runDemoMeeting(meeting);
                briefedNow = true;
                meetingId = meeting.id;
                chatSessions.delete(token); // fresh conversation for the next brief
            }
            if (briefError) session.history.push({ from: 'agent', text: `Hmm — ${briefError}` });
        }
        // A clear single match → the one-tap confirm; unsure → the tappable list.
        const proposed = (typeof result.proposeMeeting === 'number' && meetingsMeta[result.proposeMeeting])
            ? meetingsMeta[result.proposeMeeting]
            : null;
        answer(res, 200, {
            reply: result.reply,
            propose: proposed,
            showList: Boolean(result.showList) && meetingsMeta.length > 0,
            proposeConditions: Array.isArray(result.proposeConditions) && result.proposeConditions.length
                ? result.proposeConditions.filter((c) => typeof c === 'string' && c.trim()).map((c) => c.trim())
                : null,
            meetings: result.showList ? meetingsMeta : [],
            briefed: briefedNow,
            meetingId,
            error: briefError,
        });
        return;
    }

    // ── Phase 10 on the hub: the owner's Outlook calendar (read-only) ──
    // Same endpoints and shapes as the local cockpit, so the shared page
    // lights up the calendar UI on the hosted URL too. All behind the
    // access code (the OAuth callback is a top-level redirect, so the
    // SameSite=Lax session cookie rides along).
    if (url === '/calendar/status') {
        answer(res, 200, await calendar.status().catch(() => ({ configured: true, connected: false, account: null })));
        return;
    }
    if (url === '/calendar/auth') {
        try {
            res.writeHead(302, { location: await calendar.authUrl(req) });
            res.end();
        } catch (error) {
            console.error('Calendar auth URL failed:', error);
            res.writeHead(500, { 'content-type': 'text/plain' });
            res.end('Calendar is not configured — set MS_CLIENT_ID and MS_CLIENT_SECRET on the cockpit service');
        }
        return;
    }
    if (url === '/auth/callback') {
        const params = new URL(req.url || '/', 'http://localhost').searchParams;
        const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        // The owner is on a phone — the deploy log is the WRONG place for
        // the reason. Put Microsoft's own words on the page.
        const failPage = (why) => {
            res.writeHead(500, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            res.end(`<body style="background:#0d1210;color:#eef4f0;font-family:sans-serif;padding:24px;line-height:1.6">
              <h2 style="color:#e86a5e">Calendar sign-in failed</h2>
              <p style="font-family:monospace;font-size:13px;color:#e8a24a;word-break:break-word">${escapeHtml(why).slice(0, 600)}</p>
              <p style="color:#8fa39a;font-size:14px">The usual suspects: (1) MS_CLIENT_SECRET on this service is the secret's <b>ID</b>, not its <b>Value</b> — Entra shows both columns; (2) the redirect URI is registered under the <b>SPA</b> platform instead of <b>Web</b> in the Entra app; (3) the registered URI doesn't exactly match this site's /auth/callback.</p>
              <p><a href="/" style="color:#43c293">← Back to the cockpit</a></p>
            </body>`);
        };
        // Microsoft can come back with an error instead of a code (consent
        // declined, bad redirect URI...) — show its words, don't throw.
        if (params.get('error')) {
            console.error(`Calendar sign-in failed: ${params.get('error')} — ${params.get('error_description') || ''}`);
            failPage(`${params.get('error')}: ${params.get('error_description') || '(no description from Microsoft)'}`);
            return;
        }
        try {
            const account = await calendar.handleCallback(req, params.get('code') || '');
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            res.end(`<meta http-equiv="refresh" content="2;url=/"><body style="background:#0d1210;color:#eef4f0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh"><p>Calendar connected as <b>${escapeHtml(account)}</b> — taking you back…</p></body>`);
        } catch (error) {
            console.error('Calendar sign-in failed:', error);
            failPage((error && (error.errorCode ? `${error.errorCode}: ${error.errorMessage || error.message}` : error.message)) || 'unknown error');
        }
        return;
    }
    if (url === '/calendar/meetings') {
        try {
            answer(res, 200, { meetings: await calendar.upcomingMeetings() });
        } catch (error) {
            console.error('Calendar fetch failed:', error);
            answer(res, 409, { ok: false, error: 'Calendar not connected — click Connect calendar on the briefing screen.' });
        }
        return;
    }

    // Past-meeting history + the metrics strip (read from the records dir).
    if (url === '/history') {
        const entries = listRecords();
        answer(res, 200, { entries, metrics: computeMetrics(entries) });
        return;
    }
    if (url.startsWith('/history/')) {
        const record = readRecord(url.slice('/history/'.length));
        answer(res, record ? 200 : 404, record ?? { ok: false, error: 'record not found' });
        return;
    }

    // Live board edits — per meeting, with the ID-less legacy form.
    const conditionsId = idFrom(url, '/conditions');
    if ((url === '/conditions' || conditionsId) && req.method === 'POST') {
        const meeting = conditionsId ? meetings.get(conditionsId) : defaultMeeting();
        if (!meeting) {
            answer(res, 409, { ok: false, error: 'Brief the agent first.' });
            return;
        }
        try {
            const parsed = JSON.parse(await readBody(req));
            const label = typeof parsed.label === 'string' ? parsed.label.trim() : '';
            if (!label) {
                answer(res, 400, { ok: false, error: 'The condition needs some words.' });
                return;
            }
            if (parsed.op === 'add' && meeting.conditions.length + meeting.editQueue.filter((e) => e.op === 'add').length >= MAX_CONDITIONS) {
                answer(res, 400, { ok: false, error: `The board is full — the agent tracks at most ${MAX_CONDITIONS} conditions.` });
                return;
            }
            if (parsed.op === 'edit' && !meeting.conditions.some((c) => c.id === parsed.id)) {
                answer(res, 404, { ok: false, error: 'No such condition.' });
                return;
            }
            if (parsed.op !== 'edit' && parsed.op !== 'add') {
                answer(res, 400, { ok: false, error: 'op must be "edit" or "add"' });
                return;
            }
            if (meeting.briefClaimed) {
                // The bot owns this meeting's state — queue the edit; it is
                // applied (and audit-logged) on the bot's next 2s check-in.
                meeting.editQueue.push(parsed.op === 'edit' ? { op: 'edit', id: parsed.id, label } : { op: 'add', label });
                console.log(`EDIT queued >>> (${meeting.id}) ${parsed.op} ${parsed.id ?? ''} "${label}"`);
            } else {
                // No bot attached (demo mode) — apply directly to hub state.
                if (parsed.op === 'edit') {
                    const condition = meeting.conditions.find((c) => c.id === parsed.id);
                    if (condition.status === 'closed') {
                        condition.status = 'open';
                        condition.nudges = 0;
                        delete condition.note; delete condition.why; delete condition.evidence;
                    }
                    condition.label = label;
                } else {
                    meeting.conditions.push({ id: `c${meeting.conditions.length}`, label, status: 'open', nudges: 0 });
                }
                console.log(`EDIT applied (demo) >>> (${meeting.id}) ${parsed.op} "${label}"`);
            }
            answer(res, 200, { ok: true });
        } catch {
            answer(res, 400, { ok: false, error: 'body must be JSON' });
        }
        return;
    }

    // The hosted kill switch — per meeting. With a cloud bot attached the
    // shutdown is queued for its next 2s check-in; in demo mode (no bot)
    // the meeting's drawer is dropped on the spot.
    const killId = idFrom(url, '/kill');
    if ((url === '/kill' || killId) && req.method === 'POST') {
        const meeting = killId ? meetings.get(killId) : defaultMeeting();
        if (!meeting) {
            answer(res, 404, { ok: false, error: 'meeting not found — it may have already ended' });
            return;
        }
        if (meeting.briefClaimed) {
            meeting.killRequested = true;
            console.log(`KILL queued >>> (${meeting.id}) "${meeting.meetingName}" — the bot wraps up on its next check-in`);
        } else {
            meetings.delete(meeting.id);
            console.log(`KILL applied (demo) >>> (${meeting.id}) "${meeting.meetingName}" removed (${meetings.size} still running)`);
        }
        answer(res, 200, { ok: true });
        return;
    }

    // Steers — per meeting, with the ID-less legacy form (newest meeting).
    const commandId = idFrom(url, '/command');
    if ((url === '/command' || commandId) && req.method === 'POST') {
        const meeting = commandId ? meetings.get(commandId) : defaultMeeting();
        if (!meeting) {
            answer(res, 409, { ok: false, error: 'Brief the agent first.' });
            return;
        }
        try {
            const parsed = JSON.parse(await readBody(req));
            const instruction = typeof parsed.instruction === 'string' ? parsed.instruction.trim() : '';
            if (!instruction) {
                answer(res, 400, { ok: false, error: 'instruction required' });
                return;
            }
            meeting.steerQueue.push(instruction);
            console.log(`STEER queued >>> (${meeting.id}) ${instruction}`);
            answer(res, 200, { ok: true });
        } catch {
            answer(res, 400, { ok: false, error: 'body must be JSON' });
        }
        return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
});

server.listen(PORT, () => {
    // The chat-briefing state is in this line ON PURPOSE: "the chat is not
    // appearing" is answered by the first line of the deploy logs.
    const chat = ANTHROPIC_API_KEY ? 'ON' : 'OFF — set ANTHROPIC_API_KEY on this service to enable it';
    console.log(`Zeus hosted cockpit listening on port ${PORT} (demo mode: ${DEMO_MODE ? 'ON' : 'off'}, max meetings: ${MAX_MEETINGS}, chat briefing: ${chat})`);
});
