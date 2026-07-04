# Zeus — project notes (Phases 1–3)

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

## Demo script — run the whole thing from cold

1. **Start it** (needs `ANTHROPIC_API_KEY` in `.env` at the repo root):

   ```
   npx tsx apps/teams-bot/src/gate.ts <teams-meeting-url>
   ```

   The terminal says it's waiting for your brief. No browser window opens yet.
2. **Open http://localhost:4300.** You get the briefing screen.
3. **Brief it.** Type a meeting name, 1–3 conditions in any wording
   (e.g. "Venue deposit signed off"), optionally a context line. Click
   **"Send agent into the meeting →"**. The screen fades to the live
   cockpit ("AWAITING YOUR BRIEF" flips to the agent's live status) and a
   Chrome window opens and heads for the meeting.
4. **Admit it.** In Teams, admit "Zeus bot" from the lobby. It says hello in
   chat, turns captions on, and the cockpit transcript starts moving.
   Don't close the Chrome window — that window IS the bot.
5. **What to say out loud, and what you'll see:**
   - Talk about anything else → after a while the agent posts a [ZEUS]
     nudge about your most important open condition; it appears in the
     cockpit feed as WAITING.
   - Clearly settle a condition ("the venue deposit is approved, book it")
     → its card flips jade/CLOSED, the transcript line that did it turns
     jade, and the nudge flips to LANDED.
   - Keep ignoring a condition through two nudges → its card turns red and
     pulses **NEEDS LIZ**.
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
  caption line (resolve? nudge?), plus immediate steer execution. The
  briefing context line is added to both prompts.
- `apps/teams-bot/src/cockpit.html` — the whole UI, briefing screen and live
  cockpit in one page; design lifted from the committed reference mock
  `gate-command-centre-phase2.html`.

## Parked for later

- **Transcript context for decisions.** Each caption line is judged in
  isolation. Giving the brain the last few transcript lines would let it
  piece together garbled exchanges (see the budget/£50 story above) and
  close conditions more robustly.
- **Retry for the first chat post.** The "hello" message occasionally fails
  if the chat panel isn't ready seconds after admission (later posts are
  fine). Harmless, but a retry would tidy it.
- **Re-brief without restart.** `POST /setup` is deliberately once per run
  so the board and feed never disagree; a "new meeting" reset button would
  need to clear both.
- The old `orchestrator.ts` has two pre-existing type errors and is unused
  by `gate.ts` — untouched per the "don't reorganise Phase 1" rule.
