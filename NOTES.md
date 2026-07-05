# Zeus — project notes (Phases 1–4)

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

- **Phase 5: auto-pull meeting duration from the Teams/Outlook calendar via
  Graph API.** The scheduled length is typed into the briefing screen for
  now; hooking the real calendar invite (duration, title, maybe attendees)
  needs Microsoft Graph auth and is a deliberate later phase.
- **Retry for the first chat post.** The "hello" message occasionally fails
  if the chat panel isn't ready seconds after admission (later posts are
  fine). Harmless, but a retry would tidy it.
- **Re-brief without restart.** `POST /setup` is deliberately once per run
  so the board and feed never disagree; a "new meeting" reset button would
  need to clear both.
- The old `orchestrator.ts` has two pre-existing type errors and is unused
  by `gate.ts` — untouched per the "don't reorganise Phase 1" rule.
