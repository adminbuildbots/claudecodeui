# syntax=docker/dockerfile:1
#
# CloudCLI fork — single-stage image for the lab.keylinkit droplet.
#
# Single-stage on purpose: 4 GB droplet, image size doesn't matter,
# debuggability and iteration speed do. Multi-stage when we need it.
#
# Companion docker-compose.yml lives in the parent lab.keylinkit/ repo
# and supplies bind mounts for ~/.cloudcli, ~/.claude, and the workspace.

FROM node:22-bookworm

# Native build deps (node-pty, better-sqlite3, bcrypt) plus the dev tools
# upstream's docker/shared/install-cloudcli.sh ships — the in-browser shell
# is a lot more useful with jq/ripgrep/sqlite/etc. on PATH.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      python3 \
      python3-setuptools \
      git \
      jq \
      ripgrep \
      sqlite3 \
      zip \
      unzip \
      tree \
      vim-tiny \
    && rm -rf /var/lib/apt/lists/*

# Claude Code CLI itself. cloudcli's "Connect Claude" terminal shells out
# to `claude`, so it has to be on PATH inside the container.
RUN npm install -g @anthropic-ai/claude-code

# Non-root runtime user, uid/gid 1000 to match the typical droplet user
# (waddl) so bind-mounted dotdirs are writable without chown gymnastics.
RUN groupadd --gid 1000 cloudcli \
 && useradd  --uid 1000 --gid cloudcli --shell /bin/bash --create-home cloudcli

WORKDIR /app

# Install deps first for layer caching. HUSKY=0 skips git hook install
# (no .git in image and no commits happen from inside the container).
COPY --chown=cloudcli:cloudcli package.json package-lock.json ./
RUN HUSKY=0 npm ci

# Source + build the client bundle (vite -> dist/).
COPY --chown=cloudcli:cloudcli . .
RUN npm run build

USER cloudcli
ENV NODE_ENV=production
EXPOSE 3001

CMD ["node", "server/index.js"]
