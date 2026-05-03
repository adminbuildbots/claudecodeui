#!/bin/bash
#
# Auto-unlock the Bitwarden CLI service-account vault at container startup.
# Captures the unlocked session token and exports it as BW_SESSION so all
# child processes (cloudcli, every Claude shell it spawns) inherit it and
# can call `bw` without asking for credentials.
#
# Designed to FAIL OPEN: if any Vaultwarden creds are missing or wrong,
# log a friendly message and start cloudcli normally — image must remain
# usable when the service account isn't configured yet.
#
# Required env (set via docker-compose from .env):
#   BW_CLIENTID      — service account API client ID (Vaultwarden Settings → Security → API Key)
#   BW_CLIENTSECRET  — service account API client secret (same place)
#   BW_PASSWORD      — service account master password (used only to derive session, then scrubbed)
#
# After successful init, child processes inherit BW_SESSION (and ONLY that —
# the master password is unset before exec'ing the original CMD).

set -e

if [ -z "${BW_CLIENTID:-}" ] || [ -z "${BW_CLIENTSECRET:-}" ] || [ -z "${BW_PASSWORD:-}" ]; then
  echo "[bw-init] BW_CLIENTID/BW_CLIENTSECRET/BW_PASSWORD not all set; skipping vault unlock." >&2
  exec "$@"
fi

# Point bw at our self-hosted Vaultwarden. Idempotent.
bw config server https://vault.keylinkit.net >/dev/null 2>&1 || true

# Authenticate with the API key (idempotent — bw login --check handles re-runs).
if ! bw login --check >/dev/null 2>&1; then
  if ! bw login --apikey >/dev/null 2>&1; then
    echo "[bw-init] bw login --apikey failed (check BW_CLIENTID/BW_CLIENTSECRET)." >&2
    unset BW_PASSWORD
    exec "$@"
  fi
fi

# Unlock and capture the session token. --raw prints just the token to stdout.
SESSION="$(bw unlock --raw --passwordenv BW_PASSWORD 2>/dev/null)" || {
  echo "[bw-init] bw unlock failed (check BW_PASSWORD)." >&2
  unset BW_PASSWORD
  exec "$@"
}

# Scrub the password so child processes (Claude shells, etc.) never see it.
# BW_SESSION is what's needed for every subsequent `bw` call.
unset BW_PASSWORD

export BW_SESSION="$SESSION"

echo "[bw-init] vault unlocked, BW_SESSION exported (${#SESSION} chars)." >&2
exec "$@"
