# Zeus bot in a box — Phase 6, Milestone 2.
#
# Built on Microsoft's official Playwright image, which ships the exact
# browser build Playwright 1.54.2 expects plus every Linux library it
# needs. The bot runs "headed" on a virtual screen (xvfb) — no real
# display exists in a container, but Teams tolerates a headed browser
# far better than a headless one.
#
# Build (from the repo root):
#   docker build -f deploy/bot/Dockerfile -t zeus-bot .
#
# Run (the meeting link and API key are passed at RUN time — no secret
# is ever baked into the image; .dockerignore keeps .env out):
#   docker run --rm -p 4300:4300 --env-file .env -e MEETING_URL="<teams-link>" zeus-bot
#
# Then brief the agent at http://localhost:4300 as usual.
FROM mcr.microsoft.com/playwright:v1.54.2-noble

WORKDIR /app

# The image already contains the browsers — stop npm re-downloading them.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Install dependencies first (cached unless package files change).
COPY package.json package-lock.json turbo.json ./
COPY apps/teams-bot/package.json apps/teams-bot/package.json
COPY apps/bot-launcher-server/package.json apps/bot-launcher-server/package.json
RUN npm ci

# The bot's source code.
COPY apps ./apps

# No Google Chrome in the container — use the image's bundled Chromium.
# (Locally, without this setting, gate.ts keeps using installed Chrome.)
ENV ZEUS_BROWSER_CHANNEL=bundled

# The cockpit lives on this port inside the container.
EXPOSE 4300

# xvfb-run gives the "headed" browser its virtual screen.
CMD xvfb-run --auto-servernum -- npx tsx apps/teams-bot/src/gate.ts "$MEETING_URL"
