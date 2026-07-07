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
# Plain Node base + ONLY Chromium keeps the image under cloud size limits.
# (The all-in Playwright base ships three browsers ≈ 5.5GB; deleting files
# from a base layer hides them but doesn't shrink the image.)
FROM node:22-bookworm-slim

WORKDIR /app

# Browsers are installed explicitly below — stop npm downloading them all.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Only the packages the bot actually imports (playwright pinned to match the
# browser below). The full monorepo install carries dev tools and leftovers
# that push the image past Railway's 4GB estimated limit.
RUN npm init -y > /dev/null \
    && npm install playwright@1.54.2 @playwright/test@1.54.2 zod dotenv tsx \
    && npm cache clean --force

# Chromium only, plus its system libraries and the virtual screen (xvfb).
RUN npx playwright install --with-deps chromium \
    && apt-get update && apt-get install -y --no-install-recommends xvfb xauth \
    && rm -rf /var/lib/apt/lists/*

# The bot's source code — local launcher and the cloud launcher.
COPY apps ./apps
COPY deploy/bot ./deploy/bot

# No Google Chrome in the container — use the image's bundled Chromium.
# (Locally, without this setting, gate.ts keeps using installed Chrome.)
ENV ZEUS_BROWSER_CHANNEL=bundled

# The cockpit lives on this port inside the container.
EXPOSE 4300

# xvfb-run gives the "headed" browser its virtual screen.
# Two modes, one image:
#   HUB_URL set   → cloud mode: poll the hosted cockpit for briefs (Milestone 3)
#   HUB_URL empty → local mode: join $MEETING_URL, cockpit on port 4300 (Milestone 2)
CMD if [ -n "$HUB_URL" ]; then \
        xvfb-run --auto-servernum -- npx tsx deploy/bot/src/cloud-gate.ts; \
    else \
        xvfb-run --auto-servernum -- npx tsx apps/teams-bot/src/gate.ts "$MEETING_URL"; \
    fi
