#!/usr/bin/env bash
# =============================================================================
# Mimi Chicken OS — Postgres backup script (SCOPE-IN-11 / NFR-06)
# =============================================================================
# Dumps the running `mimi-postgres` container's database with pg_dump,
# compresses it, keeps a rolling local retention window, and copies the
# newest dump offsite (rclone remote, or any command you swap in below).
#
# Intended to run from cron on the VPS, e.g. nightly at 02:00 WITA:
#   0 2 * * * /opt/mimi-chicken/infrastructure/backup/backup.sh >> /var/log/mimi-backup.log 2>&1
#
# This script does NOT run automatically as part of the compose stack — wire
# it into cron (or systemd timer) on the host during the W7-01 VPS
# provisioning ticket. It is safe to test manually at any time; it only reads
# from postgres (pg_dump), never writes.
# =============================================================================
set -euo pipefail

# ---- Configuration (override via environment or a sourced .env) -----------
COMPOSE_PROJECT_DIR="${COMPOSE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
CONTAINER_NAME="${POSTGRES_CONTAINER:-mimi-postgres}"
POSTGRES_DB="${POSTGRES_DB:-mimi}"
POSTGRES_USER="${POSTGRES_USER:-mimi}"
BACKUP_DIR="${BACKUP_DIR:-$COMPOSE_PROJECT_DIR/infrastructure/backup/dumps}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
DUMP_FILE="$BACKUP_DIR/mimi-${TIMESTAMP}.sql.gz"

# Offsite copy target. Defaults to a no-op so the script is safe to run
# before offsite storage is provisioned; set OFFSITE_REMOTE to enable it,
# e.g. "rclone copy" with a configured remote, or "aws s3 cp" for S3.
# Example: OFFSITE_REMOTE_CMD='rclone copy "$DUMP_FILE" remote:mimi-backups/'
OFFSITE_REMOTE_CMD="${OFFSITE_REMOTE_CMD:-}"

mkdir -p "$BACKUP_DIR"

# `verify` mode: is there a RECENT dump? Exits non-zero if not.
#
# This exists because the failure this script actually had was SILENT. Five
# consecutive nightly runs died on a lost executable bit, the log recorded
# every one, and nobody read it — reading a log is a thing a person has to
# remember. Meanwhile dumps/ held two hand-made files, so the directory looked
# like a working backup. A dump nobody checks for is not a backup; this is the
# check, callable from cron or from a deploy.
if [ "${1:-}" = "verify" ]; then
  MAX_AGE_HOURS="${BACKUP_MAX_AGE_HOURS:-36}"
  # `|| true` is load-bearing: with no dumps the glob matches nothing, `ls`
  # exits 2, and `set -e` aborts the script before the "NO BACKUP FOUND"
  # branch below can report it — the empty case would exit silently, which
  # is exactly the failure this mode exists to make loud.
  newest=$(ls -1t "$BACKUP_DIR"/mimi-*.sql.gz 2>/dev/null | head -1 || true)
  if [ -z "$newest" ]; then
    echo "[$(date -Iseconds)] NO BACKUP FOUND in $BACKUP_DIR" >&2
    exit 1
  fi
  age_hours=$(( ( $(date +%s) - $(stat -c %Y "$newest") ) / 3600 ))
  if [ "$age_hours" -gt "$MAX_AGE_HOURS" ]; then
    echo "[$(date -Iseconds)] STALE BACKUP: newest is ${age_hours}h old (max ${MAX_AGE_HOURS}h) — $newest" >&2
    exit 1
  fi
  echo "[$(date -Iseconds)] OK — newest backup is ${age_hours}h old: $newest"
  exit 0
fi

# Remove a partial dump if anything below fails. `set -e` aborts mid-pipeline
# and would otherwise leave a truncated .sql.gz with a FRESH timestamp — the
# most dangerous artifact here, because retention and the verify check above
# would both count it as a real backup.
cleanup_partial() {
  code=$?
  if [ "$code" -ne 0 ] && [ -f "$DUMP_FILE" ]; then
    echo "[$(date -Iseconds)] FAILED (exit $code) — removing partial $DUMP_FILE" >&2
    rm -f "$DUMP_FILE"
  fi
  exit "$code"
}
trap cleanup_partial EXIT

echo "[$(date -Iseconds)] Starting backup of ${POSTGRES_DB} from ${CONTAINER_NAME}..."

# pg_dump runs INSIDE the container against its own local socket — no
# credentials cross the network, and the container's PGTZ/TZ (Asia/Makassar)
# is what timestamps the dump.
docker exec -e PGPASSWORD="${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set}" \
  "$CONTAINER_NAME" \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=plain --no-owner --no-privileges \
  | gzip -9 > "$DUMP_FILE"


# Integrity + plausibility, because "the file exists" is not evidence of a
# backup. `gzip -t` catches truncation; the size floor catches a dump that
# succeeded structurally but holds nothing — a gzip of zero bytes is about 20
# bytes and passes every other check here.
#
# `pipefail` (set at the top) is what makes the pipeline above safe at all:
# without it the exit status would be gzip's, and gzip succeeds perfectly well
# at compressing the empty output of a pg_dump that failed.
gzip -t "$DUMP_FILE"
dump_bytes=$(stat -c %s "$DUMP_FILE")
MIN_DUMP_BYTES="${MIN_DUMP_BYTES:-102400}"
if [ "$dump_bytes" -lt "$MIN_DUMP_BYTES" ]; then
  echo "[$(date -Iseconds)] IMPLAUSIBLE DUMP: ${dump_bytes} bytes (< ${MIN_DUMP_BYTES}) — treating as failure" >&2
  exit 1
fi
echo "[$(date -Iseconds)] Wrote $DUMP_FILE ($(du -h "$DUMP_FILE" | cut -f1))"

# ---- Local retention -------------------------------------------------------
find "$BACKUP_DIR" -name 'mimi-*.sql.gz' -mtime "+${RETENTION_DAYS}" -print -delete

# ---- Offsite copy -----------------------------------------------------------
if [ -n "$OFFSITE_REMOTE_CMD" ]; then
  echo "[$(date -Iseconds)] Copying offsite..."
  eval "$OFFSITE_REMOTE_CMD"
  echo "[$(date -Iseconds)] Offsite copy complete."
else
  echo "[$(date -Iseconds)] OFFSITE_REMOTE_CMD not set — skipping offsite copy. Set it before go-live (NFR-06)."
fi

echo "[$(date -Iseconds)] Backup complete."
