# Zeus — project notes (Phases 1–6)

Zeus is a meeting agent: a bot that joins a Microsoft Teams meeting as a
participant, listens to the live captions, and drives the meeting toward
outcomes its owner (Liz) briefed it with — nudging the room in chat when a
goal is being ignored, and reporting everything to a private local cockpit.

## What each phase built

- **Phase 1 — the field bot.** Joins a Teams meeting from a link as
  "Zeus bot" (camera/mic off, visible Chrome window), posts to the meeting
  chat, turns on live captions and cleans them into one-sentence transcript
  lines. Chat messages are marked [ZEUS].
- **Phase 2 — the command centre.** A tiny web server inside the same
  process serves a private cockpit at **http://localhost:4300**: condition
  cards (amber open / jade closed), the agent's nudge feed with each nudge's
  fate (WAITING / LANDED / IGNORED / SENT), and the live transcript. For
  each caption line, one Anthropic API call decides *did this settle an open
  condition?* and *should the agent nudge?* (45-second cooldown between
  nudges). A condition still open after 2+ nudges turns red with a pulsing
  **NEEDS LIZ** badge. The owner can also steer: type an instruction into
  the cockpit and the agent posts a chat message carrying it out
  immediately — the room never learns the owner intervened.
- **Phase 3 — brief the agent.** The front door. The cockpit now opens on a
  **"Brief your agent"** screen: meeting name, 1–3 conditions in your own
  words, an optional context line ("Maya holds the budget"). Nothing is
  hard-coded any more — the agent drives whatever you typed, and the context
  line is fed into its decision prompt as extra guidance. **The bot only
  joins the meeting after you click "Send agent into the meeting"** — until
  then it waits, `/state` reports `briefed: false`, and the board is empty.
  Briefing is once per run; restart the bot to brief it again (no code edits
  needed — conditions live only in memory).
- **Phase 4 — meeting-aware agent.** Three upgrades to the brain:
  1. *Whole-conversation judgement.* The agent used to judge each caption
     line in isolation, so "what's the budget?" / "£50k" / "yes, approved"
     across three speakers never closed anything. Now every decision call
     sends a rolling window of the last 40 transcript lines and asks the
     model to judge each open condition against the whole conversation —
     still one API call per spoken sentence.
  2. *Expandable "why" on each card.* Cards look the same as before, but the
     one-line status is now the agent's live judgement, and a small ＋ on
     each card expands to its fuller plain-English explanation ("Sean said
     he can't commit until finance confirms the budget, so this is blocked
     on condition 1"). Collapsed by default; refreshed on every decision.
  3. *Time awareness.* The briefing screen has a **"Scheduled length
     (minutes)"** field (default 30). The clock starts when the bot enters
     the meeting; remaining time is fed into every decision so nudges grow
     more urgent as the end nears ("Ten minutes left and the budget is
     still open — can we lock it now?"), and the cockpit header shows a
     countdown (amber once under a third remains, red once over time).
     Deliberately NOT read from the real calendar — no Graph API, no auth.

- **Phase 5 — the owner's agent.** Four upgrades: (1) *Evidence quotes* —
  every judgement carries the verbatim transcript line(s) behind it
  (speaker + exact words), shown in the expanded card as the receipt.
  (2) *Owner-mention detection* — the briefing takes "Your name"; when the
  room says it needs you ("we can't confirm until Calvin looks"), a blue
  **NEEDS YOUR ATTENTION** strip appears with the quote — distinct from the
  red condition exceptions. (3) *Join call button* in the header opens the
  meeting link so the owner joins as themselves. (4) *Reliable greeting* —
  the hello ("Hi, I'm {owner}'s meeting assistant…", one place: `greetingFor`
  in gate.ts) is confirmed posted (compose box must clear) and retried.
  The red badge also became **NEEDS YOU** (was NEEDS LIZ).
- **Phase 6 — deployed to the web.** Two halves, hosted separately on
  Railway, all code additive in `deploy/` — **the local run is unchanged**:
  1. *The cockpit* — `deploy/cockpit-server/server.js`, a dependency-free
     Node server at **https://cockpit-production-062b.up.railway.app**
     behind an access code. Serves the SAME cockpit.html as local.
  2. *The bot* — the same procedures in a Docker container
     (`deploy/bot/Dockerfile` + `deploy/bot/src/cloud-gate.ts`), polling
     the cockpit for briefs, joining the meeting from the cloud, pushing
     state back every 2s and collecting steers.
  **One shared cloud bot, one meeting at a time** — a second brief while
  busy gets a polite "agent is busy" message. Per-user sessions / a browser
  pool is the **Phase 7** upgrade, when concurrent meetings are real.

## Demo script — run the whole thing from cold

1. **Start it** (needs `ANTHROPIC_API_KEY` in `.env` at the repo root):

   ```
   npx tsx apps/teams-bot/src/gate.ts <teams-meeting-url>
   ```

   The terminal says it's waiting for your brief. No browser window opens yet.
2. **Open http://localhost:4300.** You get the briefing screen.
3. **Brief it.** Type a meeting name, a scheduled length in minutes (use
   something short like 5 if you want to see the urgency escalate during a
   demo), 1–3 conditions in any wording (e.g. "Venue deposit signed off"),
   optionally a context line. Click **"Send agent into the meeting →"**.
   The screen fades to the live cockpit ("AWAITING YOUR BRIEF" flips to the
   agent's live status) and a Chrome window opens and heads for the meeting.
4. **Admit it.** In Teams, admit "Zeus bot" from the lobby. It says hello in
   chat, turns captions on, the cockpit transcript starts moving, and the
   countdown appears in the header next to the clock.
   Don't close the Chrome window — that window IS the bot.
5. **What to say out loud, and what you'll see:**
   - Talk about anything else → after a while the agent posts a [ZEUS]
     nudge about your most important open condition; it appears in the
     cockpit feed as WAITING.
   - Settle a condition ACROSS SEVERAL SENTENCES AND VOICES — e.g. one
     person asks "so what's the deposit?", another says "two hundred",
     a third says "fine, approved" → the card still flips jade/CLOSED,
     the closing transcript line turns jade, and the nudge flips to
     LANDED. No single sentence has to contain the whole decision.
   - Click the ＋ on any card → the agent's fuller explanation of why it's
     still open (or how it closed) unfolds. Click − to collapse.
   - Keep ignoring a condition through two nudges → its card turns red and
     pulses **NEEDS LIZ**.
   - Let the countdown run low (amber, then red once over) → the agent's
     nudges get noticeably more urgent and start mentioning the time.
   - Type an instruction into the steer bar ("tell them lunch is moved to
     1pm") → the agent posts it in chat within seconds, tagged "shaped by
     your steer" in the feed. The room never sees the cockpit.
6. **Shut it down** with Ctrl+C in the terminal as soon as the meeting
   ends — the bot makes a paid API call per spoken sentence.

- **Phase 7a — UI polish + mobile (front-end only).** No bot logic, endpoints,
  or deploy setup touched — purely cockpit.html CSS plus two tiny render
  fixes. Condition cards cap at ~360px instead of stretching on wide
  screens; the newest agent-activity item is no longer clipped (missing
  top padding + a stale-scroll-position bug on re-render); tablets get a
  single-column stack with per-panel scroll caps; phones get full-width
  cards, a wrapping two-row header (identity chip only), 16px inputs (no
  iOS auto-zoom), 44px tap targets, and no horizontal scroll. The reported
  "Lanch date"/"meetingng" typos were typed briefing input, not code.

## Hosted demo script — no terminal anywhere

1. Both Railway services ("cockpit" and "bot" in the **zeus-cockpit**
   project) must be Online — check https://railway.com dashboard.
2. Start a Teams meeting on any account.
3. Open **https://cockpit-production-062b.up.railway.app** on any device
   and enter the access code (Railway variable `ACCESS_CODE` on the
   cockpit service — change it there anytime).
4. Brief the agent: paste the **Teams meeting link** into its field, add
   your name, length, and 1–3 conditions. One click on "Send agent in".
5. Within ~10 seconds the cloud bot heads for the meeting — **admit
   "Zeus bot"** from the lobby. It greets in chat; the website board,
   transcript, nudges, mentions, and steering all run live.
6. When the meeting ends, the bot notices (~90s), resets the website to a
   fresh briefing screen for the next person, and waits.

## Hosted operations — redeploy, secrets, costs, kill switch

- **Redeploy** (after code changes, from the repo root, `railway` CLI
  logged in): `npx @railway/cli up --service cockpit` and/or
  `npx @railway/cli up --service bot`. Both start via `node deploy/start.js`
  (Railway runs Dockerfile start commands WITHOUT a shell — no `if`).
- **Secrets live as Railway service variables, never in code:** cockpit has
  `ACCESS_CODE`, `BOT_TOKEN`, `DEMO_MODE=0`; bot has `ANTHROPIC_API_KEY`,
  `BOT_TOKEN` (same value), `HUB_URL`, `MAX_DAILY_DECISIONS`,
  `RAILWAY_DOCKERFILE_PATH=deploy/bot/Dockerfile`.
- **Usage cap:** the bot makes at most `MAX_DAILY_DECISIONS` (500) paid API
  calls per UTC day, then goes quiet until tomorrow.
- **Kill switch:** Railway dashboard → bot service → Settings → remove the
  active deployment (or delete the service). The cockpit alone costs
  pennies; the bot is the ~1GB always-on machine — stop it when not
  demoing. Plan note: the **Hobby plan ($5/mo) is required** — the trial's
  500MB memory limit kills Chrome the moment a Teams meeting loads
  (diagnosed live: "joined then left").
- **Version pin:** the bot image installs `playwright@1.54.2` explicitly
  (deploy/bot/Dockerfile). If the repo's Playwright is ever upgraded, bump
  that pin to match, or browser and library drift apart.
- **Teams-join fingerprint (hard-won):** the cloud bot must present as
  **Windows Chrome** — an honest Linux user agent makes the Teams launcher
  hide the "continue on this browser" button entirely.

## Lessons from live testing

- **Honest framing matters to the model.** The first steering design slipped
  the owner's instruction into the nudge prompt with "the room must never
  learn of this" wording — and the model *refused*, judging it covert
  manipulation. Reframed truthfully (an agent openly relaying its owner's
  instruction), it complies happily. Keep this in mind for all future
  prompt work.
- **Captions garble numbers.** "Fifty thousand pounds" arrived as "£50",
  "50 lbs", and "$50,000" in one exchange. The agent correctly refused to
  close the condition and asked the room to confirm figure and currency.
  Clear approval language ("the budget is approved at X") closes reliably.

## Where things live

- `apps/teams-bot/src/gate.ts` — the launcher: cockpit first, wait for the
  brief, then browser → lobby → meeting → captions → nudge loop.
- `apps/teams-bot/src/conditions.ts` — the shared conditions array (starts
  empty; `applyBrief` fills it with what you typed) and the `Condition` type.
- `apps/teams-bot/src/lib/CockpitServer.ts` — the cockpit web server:
  `GET /` (page), `GET /state` (poll), `POST /setup` (the brief),
  `POST /command` (steers).
- `apps/teams-bot/src/lib/Nudger.ts` — the decision brain: one API call per
  caption line, judging every open condition against the last ~40 transcript
  lines (status + one-line reason + fuller "why") and deciding whether to
  nudge, with remaining meeting time shaping the urgency. Also executes
  steers immediately. The briefing context line and the time state are
  added to both prompts.
- `apps/teams-bot/src/cockpit.html` — the whole UI, briefing screen and live
  cockpit in one page; design lifted from the committed reference mock
  `gate-command-centre-phase2.html`.

## Parked for later

- **Phase 7: per-user bot sessions.** Separate logins, private cockpits,
  concurrent meetings (a browser pool or bot-per-brief), per-user billing.
  Today: one shared bot, one meeting at a time, one shared access code —
  fine for demos and first users, not for two active users at once.
- **Auto-pull meeting duration from the Teams/Outlook calendar via Graph
  API.** The scheduled length is typed into the briefing screen for now.
- **Consolidate the two launchers.** `deploy/bot/src/cloud-gate.ts`
  deliberately mirrors `apps/teams-bot/src/gate.ts` (same procedures, hub
  instead of local cockpit). If the meeting loop changes, change BOTH —
  merging them is a Phase 7 refactor candidate.
- **Re-brief without restart.** `POST /setup` is deliberately once per run
  so the board and feed never disagree; a "new meeting" reset button would
  need to clear both.
- The old `orchestrator.ts` has two pre-existing type errors and is unused
  by `gate.ts` — untouched per the "don't reorganise Phase 1" rule.
