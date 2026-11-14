# Clarus ledger MCP server

Lets Claude, Copilot and other AI tools check the Clarus decision ledger
before they act. Read-only: it can look things up, it cannot change anything.

Tools: `search_decisions`, `get_decision`, `list_open_items`.

It needs two settings:

- `CLARUS_URL`: where your cockpit lives, e.g. `https://app.meetclarus.com`
  (or `http://localhost:4300` for the local bot)
- `CLARUS_TOKEN`: the read-only token from the Ledger view, under
  "Connect other tools"

Run it with `node server.mjs`. There is nothing to install or build.
Step-by-step setup for Claude Desktop is in the repo's `NOTES.md`.
