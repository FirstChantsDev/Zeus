# Zeus — deployment track (Phase 6)

Everything in this folder is ADDITIVE. The normal local run —
`npx tsx apps/teams-bot/src/gate.ts <teams-meeting-url>` then
**http://localhost:4300** — is untouched and never uses these files.

## The two halves

1. **The cockpit** (`cockpit-server/`) — the website: access-code screen,
   briefing form, live board. A tiny dependency-free Node server that
   serves the SAME `apps/teams-bot/src/cockpit.html` as the local app.
   Cheap to host, always on.
2. **The bot** — a real Chrome browser (Playwright) that joins the Teams
   meeting. Needs Docker + an always-on machine with ~1GB RAM. Hosted
   separately (Milestones 2–3). Known risk: Teams is more suspicious of
   datacenter IPs than home laptops, so the cloud join may need tuning.

Architecture decision: **one shared cloud bot, one meeting at a time.**
Second briefing while busy = queue. Per-user bot sessions / a browser pool
is the Phase 7 upgrade, only when concurrent meetings are actually needed.

## Cockpit server

Run locally (from the repo root — uses port 4400 so it never collides with
the local app's 4300):

```
node deploy/cockpit-server/server.js
```

Environment variables (all server-side; none appear in page code):

| Variable      | Default     | Meaning                                            |
|---------------|-------------|----------------------------------------------------|
| `PORT`        | `4400`      | Set automatically by the host (Railway).           |
| `ACCESS_CODE` | `zeus-demo` | The code visitors must enter. CHANGE IT when hosted.|
| `DEMO_MODE`   | `1`         | After a brief, a scripted meeting plays out so the  |
|               |             | cockpit feels real. Set `0` once the real cloud bot |
|               |             | is wired in (Milestone 3).                          |

The Anthropic API key is NOT used by this half at all — no AI calls happen
until the bot half exists. When it does, the key lives as a host-side
secret (Railway environment variable), never in the front-end.
