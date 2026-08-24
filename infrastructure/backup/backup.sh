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

echo "[$(date -Iseconds)] Starting backup of ${POSTGRES_DB} from ${CONTAINER_NAME}..."

# pg_dump runs INSIDE the container against its own local socket — no
# credentials cross the network, and the container's PGTZ/TZ (Asia/Makassar)
# is what timestamps the dump.
docker exec -e PGPASSWORD="${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set}" \
  "$CONTAINER_NAME" \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=plain --no-owner --no-privileges \
  | gzip -9 > "$DUMP_FILE"

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
