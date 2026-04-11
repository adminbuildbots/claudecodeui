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
      python3-pip \
      python3-venv \
      libpq-dev \
      postgresql-client \
      git \
      jq \
      ripgrep \
      sqlite3 \
      zip \
      unzip \
      tree \
      vim-tiny \
    && rm -rf /var/lib/apt/lists/*

# Python deps for in-house MCP servers (lab.keylinkit/mcp-servers/*).
# `mcp` is the official Anthropic Python MCP SDK. `psycopg[binary]` is the
# Postgres driver for our keylink-console MCP server. Installed system-wide
# via --break-system-packages because Debian Bookworm marks the system
# Python as PEP-668 externally-managed; we accept that since the only
# Python in this image is for our MCP servers, no system tooling depends
# on it. The break-system-packages flag was added in pip 23.0+.
RUN pip3 install --break-system-packages --no-cache-dir \
      "mcp>=1.0.0" \
      "psycopg[binary]>=3.2.0"

# Claude Code CLI itself. cloudcli's "Connect Claude" terminal shells out
# to `claude`, so it has to be on PATH inside the container.
RUN npm install -g @anthropic-ai/claude-code

# ruflo (multi-agent orchestration via @claude-flow/cli, exposed as MCP).
# Bake into the image so the binary is on PATH the moment the container
# starts; no first-run install race, and rebuilds pin the version.
# Registration as a Claude MCP server is a runtime step done once per
# fresh ~/.claude — see CLAUDE.md "Ruflo / MCP" section.
RUN npm install -g ruflo

# WORKAROUND 1: ruflo's bundled @xenova/transformers v2.17.2 hardcodes its
# model cache to `<package-install-dir>/.cache`, which is read-only to the
# `node` user inside the container. The library does NOT respect any env
# var for cache path in this version (only programmatic env.cacheDir).
# Result: every `ruflo memory *` call retries the ~90 MB Xenova model
# download, can't write the cache, spams EACCES errors, and (when output
# is piped through tail) appears to hang.
#
# Fix: symlink the hardcoded cache path to a directory under the
# bind-mounted ~/.claude-flow/cache/, so writes succeed AND the downloaded
# model survives across image rebuilds.
RUN ln -s /home/node/.claude-flow/cache/transformers \
      /usr/local/lib/node_modules/ruflo/node_modules/@xenova/transformers/.cache

# WORKAROUND 2: in ruflo v3.5.78, every memory operation (store, retrieve,
# search, list) tries the "AgentDB v3 bridge" path first via getBridge() in
# memory-initializer.js. The bridge intercepts everything, returns success-
# shaped results, but does NOT actually persist to the bind-mounted SQLite
# db that the fallback path would use. Net effect: `ruflo memory store`
# reports "Data stored successfully" with an entry id, but a direct sqlite3
# query of memory.db shows zero rows, every queryable table empty, and
# subsequent retrieve/list/search return "No entries found".
#
# Root cause: AgentDB v3 init reports "Activated: 15 Failed: 8" — 8 of 23
# controllers fail silently, leaving the bridge in a half-initialized state
# that accepts writes but doesn't durably persist them. Same code path is
# used by both the CLI and the MCP `memory_*` tools, so Claude can't escape
# the bug either.
#
# Fix: rename memory-bridge.js so the dynamic import in getBridge() throws.
# The catch block sets `_bridge = null` and every storeEntry/searchEntries
# call falls through to the working raw-sql.js fallback that writes to
# `process.cwd()/.swarm/memory.db` (which we bind-mount via data/swarm/).
#
# Trade-off: we lose the AgentDB v3 features the bridge enables — BM25
# hybrid search, ReasoningBank pattern store, CausalMemoryGraph edges,
# ExplainableRecall provenance, AttestationLog. None of these were working
# anyway given the failed controllers. The fallback gives us actual,
# durable, namespace-scoped key/value memory with vector embeddings and
# HNSW similarity search — which is the 80% use case.
#
# When ruflo upstream fixes the bridge, undo this by removing the rename
# (or pinning to a version that doesn't have the bug).
RUN mv /usr/local/lib/node_modules/ruflo/node_modules/@claude-flow/cli/dist/src/memory/memory-bridge.js \
      /usr/local/lib/node_modules/ruflo/node_modules/@claude-flow/cli/dist/src/memory/memory-bridge.js.disabled-by-fork

# WORKAROUND 3: in ruflo v3.5.78, MCP tool input validation runs through an
# OPTIONAL @claude-flow/security module via a dynamic import in
# `mcp-tools/validate-input.js#getSecurityModule()`. The intent is "load
# enhanced Zod schemas if available, fall through to working inline regex
# checks otherwise". Same defensive-fallback pattern as the memory bridge.
#
# Bug: the security module's `SpawnAgentSchema` Zod schema disagrees with
# every other place in the codebase about field names. The MCP tool, the
# CLI handler, and validate-input.js's inline checks all use `agentType`,
# but the security schema requires literal `type`. Result: every single
# `mcp__ruflo__agent_spawn` call fails with `Input validation failed:
# type: Required` — the field the schema wants doesn't exist anywhere on
# the calling side. The CLI path swallows this error silently and prints
# "Agent X spawned successfully" with empty fields (no agent is actually
# created — `ruflo agent list` returns 0 entries afterward).
#
# Fix: rename the @claude-flow/security package directory so the dynamic
# import in getSecurityModule() throws. The catch block sets
# `_securityModule = null`, validateAgentSpawn falls through to its inline
# regex checks (which work correctly), and agent_spawn calls succeed.
#
# Trade-off: lose the additional Zod-based validation hardening that the
# security package was meant to provide. Acceptable because (a) it doesn't
# work anyway in this version, and (b) inline regex checks are still
# applied — we're not disabling validation, just disabling the broken
# *enhanced* validation layer.
#
# When ruflo upstream fixes the field-name mismatch, undo this by removing
# the rename. The same security package may also affect other tools that
# call validateAgentSpawn or sibling validators — if anything else breaks
# with a similar "Input validation failed" pattern, this is the first
# place to look.
RUN mv /usr/local/lib/node_modules/ruflo/node_modules/@claude-flow/security \
      /usr/local/lib/node_modules/ruflo/node_modules/@claude-flow/security.disabled-by-fork

# Playwright MCP server (microsoft/playwright-mcp). Lets Claude drive a real
# headless browser via the Playwright API — useful for scraping,
# screenshotting, filling forms, and debugging end-to-end browser tests
# from inside a chat session.
#
# WHY GOOGLE CHROME, NOT THE BUNDLED CHROMIUM:
# playwright-mcp's `--browser` flag accepts only release channels —
# `chrome`, `firefox`, `webkit`, `msedge` — and defaults to `chrome`.
# It does NOT accept `chromium` (the upstream open-source build that
# `playwright install chromium` lays down). We tried both `--browser
# chromium` and `--executable-path` to the bundled headless shell;
# `--browser chromium` is rejected as an invalid channel, and the
# version-pinned executable path (e.g. /ms-playwright/chromium-1217/...)
# is a footgun that breaks silently every time playwright is upgraded
# to a new browser revision. The cleanest fix is to install what
# playwright-mcp actually expects by default: Google Chrome stable.
#
# `playwright install --with-deps chrome` does two things in one shot:
#   (1) downloads and installs Google Chrome stable to /opt/google/chrome
#       (~280 MB) using the official Google deb package
#   (2) apt-installs the system shared libs it depends on (libnss3,
#       libxkbcommon, libdrm, libgbm, libpango, libcairo, libasound2,
#       fonts-liberation, etc — ~30 packages)
#
# Google Chrome installs to /opt/google/chrome regardless of
# PLAYWRIGHT_BROWSERS_PATH, so we don't bother setting that env var.
# The /opt/google/chrome tree is root-owned and world-readable by
# default — the unprivileged `node` user can launch it at runtime
# without any chown work.
#
# Registration as an MCP server is a runtime step done once per fresh
# ~/.claude.json — see CLAUDE.md "MCP servers" section for the
# `claude mcp add playwright ...` command.
RUN npm install -g @playwright/mcp playwright \
    && playwright install --with-deps chrome \
    && rm -rf /var/lib/apt/lists/*

# Reuse the base image's built-in `node` user (uid/gid 1000). It already
# matches the typical droplet user (waddl, also uid 1000) so bind-mounted
# dotdirs are writable without chown gymnastics, and creating a second
# uid-1000 account would just collide.

WORKDIR /app

# Install deps first for layer caching. HUSKY=0 skips git hook install
# (no .git in image and no commits happen from inside the container).
# scripts/ has to land before npm ci because cloudcli's postinstall hook
# (`node scripts/fix-node-pty.js`) runs during install — even though the
# script is a no-op on Linux, Node still tries to load it and crashes if
# the file isn't on disk.
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node scripts ./scripts
RUN HUSKY=0 npm ci

# Source + build the client bundle (vite -> dist/).
COPY --chown=node:node . .
RUN npm run build

USER node
ENV NODE_ENV=production
EXPOSE 3001

CMD ["node", "server/index.js"]
