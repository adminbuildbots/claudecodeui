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

# TaskMaster AI (eyaltoledano/claude-task-master). AI-driven task management
# that decomposes PRDs into sequenced dev tasks. cloudcli's Settings → Tasks
# tab detects it via `which task-master && task-master --version`. Also
# registerable as an MCP server so Claude can use task-master tools natively
# in chat sessions. Pure JS, no native deps, ~10-20 MB.
RUN npm install -g task-master-ai

# Bitwarden CLI (`bw`) for Vaultwarden access. Auto-unlocked at container
# startup by /usr/local/bin/bw-init.sh using a service-account API key +
# master password from .env (BW_CLIENTID, BW_CLIENTSECRET, BW_PASSWORD).
# After unlock, BW_SESSION is exported to all child processes — Claude
# shells inherit it and can call `bw get/list/search` without credentials.
# Scoped to the read-only "CloudCLI Tools" collection per CLAUDE.md
# Vaultwarden integration design.
RUN npm install -g @bitwarden/cli

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
# WHY THE BUNDLED CHROMIUM HEADLESS SHELL, AND WHY THE STABLE SYMLINK:
# playwright-mcp's `--browser` flag accepts only release channels —
# `chrome`, `firefox`, `webkit`, `msedge` — and defaults to `chrome`.
# We tried each of those:
#   - Google Chrome stable (147.0.7727): the bundled chrome_crashpad_handler
#     is broken on Debian Bookworm — Chrome's main process spawns it
#     without --database and the handler crashes the whole browser with
#     SIGTRAP on every navigate. No combination of --disable-crash-reporter,
#     --crash-dumps-dir, --user-data-dir flags suppresses it. Tested
#     2026-04-11.
#   - `--browser chromium`: rejected by playwright-mcp as an invalid
#     channel (the help text is correct, not incomplete).
#
# What DOES work: launching the bundled `chrome-headless-shell` binary
# (a stripped-down Chromium variant that ships with `playwright install
# chromium`) directly via playwright-mcp's `--executable-path` flag.
# We verified it works end-to-end in the same image.
#
# The footgun with --executable-path is the version-suffixed directory
# (e.g. /ms-playwright/chromium_headless_shell-1217/...) which changes
# every time playwright is upgraded — leaving a registration that
# silently breaks at the next rebuild. We sidestep this by creating a
# stable symlink at /usr/local/bin/playwright-chromium that resolves to
# whatever version the current image has, re-pointed by the build step
# itself on every rebuild. The MCP registration uses the stable name.
#
# `playwright install --with-deps chromium` does two things in one shot:
#   (1) apt-installs the system shared libs Chromium needs (libnss3,
#       libxkbcommon, libdrm, libgbm, libpango, libcairo, libasound2,
#       fonts-noto-color-emoji, etc — ~30 packages, ~250 MB)
#   (2) downloads the bundled Chromium build (~170 MB) into
#       PLAYWRIGHT_BROWSERS_PATH, including the chrome-headless-shell
#       variant we actually want
#
# We pin the browser cache to /ms-playwright (instead of the default
# ~/.cache/ms-playwright) so the binaries are owned by root, readable by
# everyone, and survive image rebuilds via the docker layer cache. The
# unprivileged `node` user reads from this path at runtime via the same
# PLAYWRIGHT_BROWSERS_PATH env var, which stays set for the runtime stage
# below — no chown needed.
#
# Registration as an MCP server is a runtime step done once per fresh
# ~/.claude.json — see CLAUDE.md "MCP servers" section for the
# `claude mcp add playwright ...` command.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npm install -g @playwright/mcp playwright \
    && playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/* \
    && chmod -R a+rx /ms-playwright \
    && BIN=$(ls /ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell) \
    && ln -sf "$BIN" /usr/local/bin/playwright-chromium

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

# bw-init wrapper: auto-unlock Vaultwarden at startup, export BW_SESSION
# into env, then exec the original CMD. Fail-open if creds aren't configured
# (logs friendly message and starts cloudcli normally).
COPY --chown=node:node scripts/bw-init.sh /usr/local/bin/bw-init.sh
USER root
RUN chmod 755 /usr/local/bin/bw-init.sh
USER node

ENTRYPOINT ["/usr/local/bin/bw-init.sh"]
CMD ["node", "server/index.js"]
