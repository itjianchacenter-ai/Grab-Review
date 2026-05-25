#!/bin/bash
# backup-auto.sh — non-interactive backup for launchd
#
# Runs weekly via com.jiancha.backup launchd plist.
# Encrypts if BACKUP_PASSPHRASE is set (from scripts/backup.env, gitignored).
# Otherwise produces a plain tarball — fine for local-only backups.
#
# Output: backups/auto-<TIMESTAMP>.tar.gz[.enc]
# Retention: keeps last 8 backups (≈ 2 months at weekly), deletes older.

set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

LOG="$ROOT/logs/backup.log"
mkdir -p "$(dirname "$LOG")" backups

ts() { date "+%Y-%m-%d %H:%M:%S"; }
log() { echo "[$(ts)] $*" | tee -a "$LOG"; }

log "═══ Auto-backup start ═══"

# Optional passphrase from scripts/backup.env
ENV_FILE="$ROOT/scripts/backup.env"
if [ -f "$ENV_FILE" ]; then
  set -a; . "$ENV_FILE"; set +a
fi

# Files to back up
FILES=()
[ -f vault.enc ]                && FILES+=(vault.enc)
[ -f users.json ]               && FILES+=(users.json)
[ -f .sessions.json ]           && FILES+=(.sessions.json)
[ -f server-data.json ]         && FILES+=(server-data.json)
[ -f runner/.env ]              && FILES+=(runner/.env)
[ -d runner/profiles ]          && FILES+=(runner/profiles)

if [ ${#FILES[@]} -eq 0 ]; then
  log "✗ Nothing to back up — exiting"
  exit 1
fi

STAMP=$(date +%Y%m%d-%H%M%S)
if [ -n "$BACKUP_PASSPHRASE" ] && [ ${#BACKUP_PASSPHRASE} -ge 12 ]; then
  OUT="backups/auto-$STAMP.tar.gz.enc"
  log "Encrypting → $OUT"
  tar -cz "${FILES[@]}" 2>/dev/null \
    | openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -pass "pass:$BACKUP_PASSPHRASE" \
    > "$OUT"
else
  OUT="backups/auto-$STAMP.tar.gz"
  log "⚠ No BACKUP_PASSPHRASE set (or <12 chars) — plain tar (local only, do NOT push to git)"
  tar -czf "$OUT" "${FILES[@]}" 2>/dev/null
fi

SIZE=$(du -h "$OUT" | cut -f1)
log "✓ Created $OUT ($SIZE)"

# Retention: keep last 8 auto-backups
DELETED=0
ls -1t backups/auto-*.tar.gz* 2>/dev/null | tail -n +9 | while read -r old; do
  rm -f "$old"
  log "  ✗ Pruned $old"
  DELETED=$((DELETED + 1))
done

# Optional: heartbeat ping (set BACKUP_PING_URL in backup.env for healthchecks.io)
if [ -n "$BACKUP_PING_URL" ]; then
  curl -fsS -m 10 "$BACKUP_PING_URL" >/dev/null 2>&1 && log "  ↗ heartbeat ok"
fi

log "═══ Auto-backup done ═══"
