#!/bin/bash
# sync-with-chrome.sh — preflight: ensure Chrome CDP is up before running the orchestrator
#
# Called by launchd (com.jiancha.grab-sync) every 6h.
# Self-heals: if Chrome died (Mac sleep, crash, manual close), relaunch it.
#
# ENV (forwarded to orchestrator):
#   SYNC_SERVER, SYNC_TOKEN, JITTER_MIN, JITTER_MAX

set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNNER="$ROOT/runner"
LAUNCH_CHROME="$RUNNER/launch-chrome.sh"
CDP_URL="http://localhost:9222/json/version"
LOG="$RUNNER/logs/launchd.log"

ts() { date "+%Y-%m-%dT%H:%M:%SZ"; }
log() { echo "[$(ts)] [preflight] $*" >> "$LOG"; }

mkdir -p "$RUNNER/logs"

# 1. Is CDP already reachable?
if curl -fsS -m 3 "$CDP_URL" >/dev/null 2>&1; then
  log "Chrome CDP already up — proceeding"
else
  log "Chrome CDP down — launching"
  # Launch in background, detached
  bash "$LAUNCH_CHROME" shared >> "$LOG" 2>&1 &
  disown

  # Poll up to 30s for CDP to come up
  for i in $(seq 1 30); do
    if curl -fsS -m 2 "$CDP_URL" >/dev/null 2>&1; then
      log "Chrome CDP up after ${i}s"
      break
    fi
    sleep 1
    if [ "$i" = "30" ]; then
      log "❌ Chrome CDP did not come up within 30s — aborting sync"
      exit 1
    fi
  done

  # Extra settle time so Chrome is fully ready
  sleep 3
fi

# 2. Run the orchestrator with the forwarded args.
# Use slow-sync-all.js — its human-like typing + per-button moveAndClick clicks
# bypass Grab's anti-bot consistently. multi-account-sync.js uses fast .click()
# on the saved-accounts / submit buttons and gets flagged.
cd "$RUNNER"
exec /opt/homebrew/bin/node slow-sync-all.js "$@"
