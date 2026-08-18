# =============================================================================
# TextPresenter — Dockerfile
# =============================================================================
# Build:   docker build -t textpresenter .
# Run:     see docker-compose.yml, or:
#   docker run -d --name textpresenter \
#     -p 3000:3000 \
#     -e ADMIN_PASSWORD=... \
#     -v textpresenter-data:/data \
#     --restart unless-stopped \
#     textpresenter
#
# Persistent state (channels.json and the session signing secret) lives in
# DATA_DIR=/data. Mount a volume there or every container recreation wipes
# every church's channel and signs everyone out.

FROM node:22-alpine

ENV NODE_ENV=production \
    DATA_DIR=/data

WORKDIR /app

# Dependencies first, so code changes don't bust the layer cache. The repo
# deliberately doesn't commit package-lock.json, so this is `install`, not `ci`.
COPY package.json ./
RUN npm install --omit=dev

COPY --chown=node:node . .

# Pre-create the data directory owned by the app user. When a fresh named
# volume is mounted over it, Docker copies this ownership into the volume,
# so the unprivileged app user can write without any extra setup.
RUN mkdir -p /data && chown node:node /data

USER node

EXPOSE 3000

# /healthz answers 200 with a JSON payload.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --tries=1 --spider http://127.0.0.1:${PORT:-3000}/healthz || exit 1

CMD ["node", "server.js"]
