/**
 * Zeus hosted cockpit — Phase 6, Milestone 1.
 *
 * A standalone, dependency-free Node server that puts the cockpit on a real
 * URL. It is ADDITIVE ONLY: the normal local run
 * (npx tsx apps/teams-bot/src/gate.ts <link> → localhost:4300) is untouched
 * and does not use this file.
 *
 * What it does:
 *   - Shows a styled access-code screen until the right code is entered
 *     (code comes from the ACCESS_CODE environment variable — a server-side
 *     setting, never written into the page).
 *   - Then serves the SAME cockpit.html the local app uses — one source of
 *     truth, nothing copied that could drift.
 *   - Answers the same API the page already speaks: GET /state, POST /setup,
 *     POST /command — backed by in-memory state, exactly like the local
 *     CockpitServer.
 *   - DEMO MODE (until the cloud bot is wired in at Milestone 3): after a
 *     brief is submitted, a short scripted meeting plays out against the
 *     conditions the visitor actually typed, so the hosted cockpit looks
 *     and feels real. Set DEMO_MODE=0 once the real bot is connected.
 *
 * Run:  node deploy/cockpit-server/server.js   (from the repo root)
 * Env:  PORT (default 4400), ACCESS_CODE (default zeus-demo), DEMO_MODE (default 1)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 4400;
const ACCESS_CODE = process.env.ACCESS_CODE || 'zeus-demo';
const DEMO_MODE = (process.env.DEMO_MODE ?? '1') !== '0';
const MAX_CONDITIONS = 3;
// Phase 6 M3: the shared secret the cloud bot presents on /bot/* calls.
// Set the same value on both Railway services. Empty = bot endpoints off.
const BOT_TOKEN = process.env.BOT_TOKEN || '';

// The one cockpit page, shared with the local app.
const COCKPIT_PAGE = path.join(__dirname, '..', '..', 'apps', 'teams-bot', 'src', 'cockpit.html');

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
 * Meeting state — same shape the local CockpitServer serves
 * ================================================
 */
const startedAt = new Date().toISOString();
const state = {
    briefed: false,
    briefedAt: null,
    meetingName: null,
    meetingStatus: 'connecting',
    scheduledMinutes: 30,
    meetingJoinedAt: null,
    ownerName: '',
    meetingUrl: '', // typed into the hosted briefing form; the cloud bot joins it
    context: '',
    conditions: [],
    nudges: [],
    transcript: [],
    mentions: [],
};

// Phase 6 M3: hub-side plumbing between the website and the cloud bot.
// briefClaimed — the bot has collected the brief and is on its way.
// steerQueue   — owner instructions waiting for the bot's next check-in.
let briefClaimed = false;
let steerQueue = [];

const resetState = () => {
    state.briefed = false;
    state.briefedAt = null;
    state.meetingName = null;
    state.meetingStatus = 'connecting';
    state.scheduledMinutes = 30;
    state.meetingJoinedAt = null;
    state.ownerName = '';
    state.meetingUrl = '';
    state.context = '';
    state.conditions = [];
    state.nudges = [];
    state.transcript = [];
    state.mentions = [];
    briefClaimed = false;
    steerQueue = [];
};

const buildStateJson = () => {
    // Same nudge-fate derivation as the local CockpitServer.
    const nudgesWithStatus = state.nudges.map((nudge, index) => {
        const condition = nudge.conditionId === null
            ? undefined
            : state.conditions.find((c) => c.id === nudge.conditionId);
        let status;
        if (nudge.conditionId === null) {
            status = 'sent';
        } else if (condition && condition.status === 'closed') {
            status = 'landed';
        } else if (state.nudges.some((other, otherIndex) => otherIndex > index && other.conditionId === nudge.conditionId)) {
            status = 'ignored';
        } else {
            status = 'waiting';
        }
        return { ...nudge, conditionLabel: condition ? condition.label : 'your steer', status };
    }).reverse();

    return {
        startedAt,
        briefed: state.briefed,
        briefedAt: state.briefedAt,
        meetingName: state.meetingName,
        meetingStatus: state.meetingStatus,
        scheduledMinutes: state.scheduledMinutes,
        meetingJoinedAt: state.meetingJoinedAt,
        conditions: state.conditions,
        nudges: nudgesWithStatus,
        transcript: state.transcript,
        ownerName: state.ownerName,
        mentions: [...state.mentions].reverse(),
        meetingUrl: state.meetingUrl,
    };
};

/**
 * ================================================
 * Demo meeting — plays out against whatever conditions were typed
 * (removed once the real cloud bot is wired in at Milestone 3)
 * ================================================
 */
const say = (speaker, text, hit = false) => {
    state.transcript.push({ speaker, text, ts: new Date().toISOString(), hit });
};

const runDemoMeeting = () => {
    const [c0, c1, c2] = state.conditions;
    const owner = state.ownerName;
    const after = (seconds, fn) => setTimeout(fn, seconds * 1000);

    after(3, () => {
        state.meetingStatus = 'in-meeting';
        state.meetingJoinedAt = new Date().toISOString();
    });
    after(6, () => say('Maya', "Right, let's get going — where did we land after last week?"));
    after(11, () => say('Jordan', 'Good progress on our side, two options ready to show.'));
    after(16, () => say('Sam', 'Before that — did everyone see the summary I sent round?'));

    if (c0) {
        after(21, () => {
            state.nudges.push({
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
            state.mentions.push({ speaker: 'Sam', quote: `Hold on — we can't finalise the rest until ${owner} takes a look.`, at: new Date().toISOString() });
        });
    }
    if (c1) {
        after(50, () => {
            state.nudges.push({
                text: `[ZEUS] One thing still open — "${c1.label}". Can we pin it down before we lose the room?`,
                conditionId: c1.id, steered: false, at: new Date().toISOString(),
            });
            c1.nudges++;
            c1.note = 'Agent has raised it — waiting on the room.';
            c1.why = 'It has been raised once but the discussion moved on without an answer.';
        });
        after(58, () => say('Maya', "Let's take that offline — next item."));
        after(66, () => {
            state.nudges.push({
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
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700&family=Inter:wght@400;500&family=IBM+Plex+Mono:wght@400&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0;}
html,body{height:100%;background:#0d1210;color:#eef4f0;font-family:'Inter',sans-serif;font-size:14px;}
body{display:flex;align-items:center;justify-content:center;}
.card{width:min(400px,90vw);padding:8px;}
.mark{font-family:'Bricolage Grotesque',sans-serif;font-weight:700;font-size:20px;letter-spacing:-.4px;margin-bottom:22px;}
.mark em{font-style:normal;color:#43c293;}
h1{font-family:'Bricolage Grotesque',sans-serif;font-weight:600;font-size:24px;letter-spacing:-.5px;margin-bottom:6px;}
p{font-size:13px;color:#8fa39a;line-height:1.5;margin-bottom:22px;}
input{width:100%;background:#1a231f;border:1px solid rgba(255,255,255,.13);border-radius:10px;padding:12px 13px;color:#eef4f0;font-size:14px;outline:none;font-family:'IBM Plex Mono',monospace;letter-spacing:2px;}
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

const server = http.createServer(async (req, res) => {
    const url = (req.url || '/').split('?')[0];

    // The front door: access code first, cockpit after.
    if (url === '/' || url === '/index.html') {
        if (!isAuthed(req)) {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(LOGIN_PAGE);
            return;
        }
        fs.readFile(COCKPIT_PAGE, (error, html) => {
            if (error) {
                res.writeHead(500, { 'content-type': 'text/plain' });
                res.end('cockpit.html is missing');
                return;
            }
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
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

    // ── Phase 6 M3: the cloud bot's endpoints — shared-secret auth, not cookies ──
    if (url.startsWith('/bot/')) {
        if (!BOT_TOKEN || req.headers['x-bot-token'] !== BOT_TOKEN) {
            answer(res, 403, { ok: false, error: 'bad bot token' });
            return;
        }
        if (url === '/bot/brief' && req.method === 'GET') {
            // Hand the brief over exactly once; the bot is now responsible.
            if (state.briefed && !briefClaimed) {
                briefClaimed = true;
                console.log('BOT >>> collected the brief, heading for the meeting');
                answer(res, 200, {
                    brief: {
                        meetingName: state.meetingName,
                        labels: state.conditions.map((c) => c.label),
                        context: state.context,
                        lengthMinutes: state.scheduledMinutes,
                        ownerName: state.ownerName,
                        meetingUrl: state.meetingUrl,
                    },
                });
            } else {
                answer(res, 200, { brief: null });
            }
            return;
        }
        if (url === '/bot/state' && req.method === 'POST') {
            // The bot's snapshot replaces the hub copy; steers ride back.
            try {
                const snap = JSON.parse(await readBody(req));
                if (typeof snap.meetingStatus === 'string') state.meetingStatus = snap.meetingStatus;
                if (snap.meetingJoinedAt !== undefined) state.meetingJoinedAt = snap.meetingJoinedAt;
                if (Array.isArray(snap.conditions)) state.conditions = snap.conditions;
                if (Array.isArray(snap.nudges)) state.nudges = snap.nudges;
                if (Array.isArray(snap.transcript)) state.transcript = snap.transcript;
                if (Array.isArray(snap.mentions)) state.mentions = snap.mentions;
                const steers = steerQueue;
                steerQueue = [];
                answer(res, 200, { ok: true, steers });
            } catch {
                answer(res, 400, { ok: false, error: 'body must be JSON' });
            }
            return;
        }
        if (url === '/bot/reset' && req.method === 'POST') {
            // Meeting over — back to a fresh briefing screen for the next user.
            console.log('BOT >>> meeting ended, cockpit reset for the next brief');
            resetState();
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

    if (url === '/state') {
        answer(res, 200, buildStateJson());
        return;
    }

    if (url === '/setup' && req.method === 'POST') {
        if (state.briefed) {
            answer(res, 409, { ok: false, error: 'The shared agent is already handling a meeting — try again once it finishes.' });
            return;
        }
        try {
            const parsed = JSON.parse(await readBody(req));
            // Re-check after the body arrived: two near-simultaneous submits
            // (double-click) both pass the first check, and used to both
            // write their conditions — the "six conditions" bug.
            if (state.briefed) {
                answer(res, 409, { ok: false, error: 'The shared agent is already handling a meeting — try again once it finishes.' });
                return;
            }
            // Phase 6 M3: the hosted brief carries the meeting link (locally the
            // bot gets it from the launch command instead). Demo mode excepted.
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
            state.briefed = true;
            state.briefedAt = new Date().toISOString();
            state.meetingName = (typeof parsed.meetingName === 'string' && parsed.meetingName.trim()) ? parsed.meetingName.trim() : 'Untitled meeting';
            state.scheduledMinutes = Number.isFinite(rawLength) && rawLength > 0 ? Math.min(480, Math.max(1, Math.round(rawLength))) : 30;
            state.ownerName = typeof parsed.ownerName === 'string' ? parsed.ownerName.trim() : '';
            state.meetingUrl = meetingUrl;
            state.context = typeof parsed.context === 'string' ? parsed.context.trim() : '';
            labels.forEach((label, index) => {
                state.conditions.push({ id: `c${index}`, label, status: 'open', nudges: 0 });
            });
            console.log(`BRIEFED >>> "${state.meetingName}" — ${labels.join(' | ')}${DEMO_MODE ? ' (demo meeting starting)' : ''}`);
            if (DEMO_MODE) {
                runDemoMeeting();
            }
            answer(res, 200, { ok: true });
        } catch {
            answer(res, 400, { ok: false, error: 'body must be JSON' });
        }
        return;
    }

    if (url === '/command' && req.method === 'POST') {
        // Phase 6 M3: steers are queued here; the cloud bot collects them on
        // its next check-in (every couple of seconds) and acts immediately.
        if (!state.briefed) {
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
            steerQueue.push(instruction);
            console.log(`STEER queued >>> ${instruction}`);
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
    console.log(`Zeus hosted cockpit listening on port ${PORT} (demo mode: ${DEMO_MODE ? 'ON' : 'off'})`);
});
