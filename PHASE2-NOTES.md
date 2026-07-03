# GATE Phase 2 — the Command Centre

Phase 2 turns the Phase 1 caption bot into a product: the bot is the field
agent, and its owner (Liz) watches a private local cockpit while it drives
the meeting toward pre-defined outcomes.

## What was built

- **Pre-defined conditions** ([apps/teams-bot/src/conditions.ts](apps/teams-bot/src/conditions.ts)) —
  the agent's meeting brief. Three hard-coded goals (budget / launch date /
  success metric) live at the top of that file with a plain-English comment;
  edit them there. For each cleaned caption line, one Anthropic API call
  answers two questions: *did this line settle an open condition?* and
  *should the agent nudge the room about one that's stalling?* A 45-second
  cooldown stops it nagging.
- **The cockpit** — a tiny web server (Node built-in `http`, same process,
  no database, no extra service) serving a live board at
  **http://localhost:4300**: condition cards (amber open / jade closed),
  the agent's nudge feed with each nudge's fate (WAITING / LANDED / IGNORED /
  SENT), and the live transcript. The page polls `GET /state` every 1.5s.
  Design comes from the committed reference mock
  (`gate-command-centre-phase2.html`).
- **Exception flagging** — a condition still open after 2+ nudges turns red
  with a pulsing **NEEDS LIZ** badge: the signal that the agent has pushed
  twice, the room keeps moving past it, and the owner should step in.
- **Steering** — the owner types an instruction into the cockpit
  (`POST /command`) and the agent carries it out *immediately*: one API call
  composes the chat message from the instruction + conditions + recent
  transcript, and posts it. Directives don't need to relate to a condition
  ("ok move on to item 2" works). The feed tags these "shaped by your steer".
  Nothing in the meeting reveals the owner intervened.

## How to run it

From the repo root (needs `ANTHROPIC_API_KEY` in `.env`):

```
npx tsx apps/teams-bot/src/gate.ts <teams-meeting-url>
```

Then open **http://localhost:4300** in a browser. Admit "Zeus bot" from the
meeting lobby (the UI was rebranded from GATE to Zeus; chat messages are
marked [ZEUS]). Don't close the Chrome window the bot opens — that window IS
the bot. Ctrl+C in the terminal shuts it down; do this as soon as the meeting
ends, because the bot makes a paid API call per spoken sentence.

## Lessons from live testing

- **Honest framing matters to the model.** The first steering design slipped
  the owner's instruction into the nudge prompt with "the room must never
  learn of this" wording — and the model *refused*, judging it covert
  manipulation. Reframed truthfully (an agent openly relaying its owner's
  instruction), it complies happily. Keep this in mind for all Phase 3
  prompt work.
- **Captions garble numbers.** "Fifty thousand pounds" arrived as "£50",
  "50 lbs", and "$50,000" in one exchange. The agent correctly refused to
  close the condition and asked the room to confirm figure and currency.
  Clear approval language ("the budget is approved at X") closes reliably.

## Parked for Phase 3

- **The "brief your agent" setup screen** from the mock: a pre-meeting form
  (meeting link, conditions list, optional context) that populates the
  conditions array and launches the bot — replacing the hard-coded array
  and the manual terminal command. The mock's briefing screen markup/CSS is
  in `gate-command-centre-phase2.html`, ready to lift.
- **Transcript context for decisions.** Each caption line is currently
  judged in isolation. Giving the brain the last few transcript lines would
  let it piece together garbled exchanges (see the budget/£50 story above)
  and close conditions more robustly.
- **Retry for the first chat post.** The "hello" message occasionally fails
  if the chat panel isn't ready seconds after admission (later posts are
  fine). Harmless, but a retry would tidy it.
- Meeting name in the cockpit header (currently static "Live Teams meeting").
- The old `orchestrator.ts` has two pre-existing type errors and is unused
  by `gate.ts` — untouched per the "don't reorganise Phase 1" rule.
