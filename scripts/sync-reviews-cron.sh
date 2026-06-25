#!/bin/bash
# sync-reviews-cron.sh — preflight Chrome + run REVIEWS orchestrator (dual-push local + production)
# Called by launchd (com.jiancha.grab-reviews) every 6h. Self-heals Chrome if down.

set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNNER="$ROOT/runner"
CDP_URL="http://localhost:9222/json/version"
LOG="$RUNNER/logs/reviews-cron.log"
mkdir -p "$RUNNER/logs"
ts() { date "+%Y-%m-%dT%H:%M:%SZ"; }
log() { echo "[$(ts)] [reviews-cron] $*" >> "$LOG"; }

log "═══ Reviews sync starting ═══"

# 1. Ensure Chrome CDP up
if curl -fsS -m 3 "$CDP_URL" >/dev/null 2>&1; then
  log "Chrome CDP up"
else
  log "Chrome down — launching"
  bash "$RUNNER/launch-chrome.sh" 3-C4N3JLJHJTVGTJ >> "$LOG" 2>&1 &
  disown
  for i in $(seq 1 30); do
    curl -fsS -m 2 "$CDP_URL" >/dev/null 2>&1 && { log "Chrome up after ${i}s"; break; }
    sleep 1
    [ "$i" = "30" ] && { log "❌ Chrome failed to start"; exit 1; }
  done
  sleep 3
fi

# 2. Run reviews orchestrator (dual-push reads PROD_* from runner/.env)
cd "$RUNNER"
rm -f logs/.sync-reviews.lock
exec /opt/homebrew/bin/node multi-account-sync-reviews.js --shuffle --skip-fresh-hours 4 >> "$LOG" 2>&1
