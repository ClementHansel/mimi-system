# Postgres backup & restore (SCOPE-IN-11, NFR-06)

## What ships here

- `backup.sh` — nightly `pg_dump` (plain SQL, gzip'd), local rolling
  retention (`RETENTION_DAYS`, default 14), optional offsite copy hook.
  **Installed automatically by `scripts/deploy.sh`** as of 2026-08-29 — it is
  no longer something a person has to remember to wire up.
- `backup.sh verify` — "is there a dump newer than `BACKUP_MAX_AGE_HOURS`
  (default 36)?", exiting non-zero if not. The deploy runs it and warns.

## Setup

Nothing to do — `scripts/deploy.sh` installs the cron entry on every deploy,
idempotently. It keys off a marker comment rather than matching the command
line, so a reformatted command can never install a second nightly job.

The entry it installs, for reference:

```bash
# mimi-chicken nightly backup (NFR-06)
0 2 * * * cd /home/ubuntu/mimi && set -a && . ./.env.vps && set +a \
  && bash ./infrastructure/backup/backup.sh >> /home/ubuntu/mimi-backup.log 2>&1
```

**Invoke it as `bash ./backup.sh`, not `./backup.sh`.** This is not style. The
script was committed mode `100644` and the cron entry ran it directly, so from
the day it was installed every single nightly run died with

```
/bin/sh: 1: ./infrastructure/backup/backup.sh: Permission denied
```

The two dumps sitting in `dumps/` were made by hand, which is exactly why nobody
noticed: the directory looked like a working backup. The mode is now `100755` in
git, so the direct form works too — but `bash` in front means a lost executable
bit can never silently disable backups again, and an executable bit is easy to
lose (a `zip` round-trip, a checkout on Windows, a `cp` from a container).

**Failure used to be silent.** The log recorded five consecutive failures and
was not read, because reading a log is a thing a person has to remember to do.
Three changes make that specific failure impossible to repeat:

1. `scripts/deploy.sh` runs `backup.sh verify` and prints a loud warning when
   the newest dump is missing or stale. It warns rather than fails — a freshly
   provisioned box legitimately has no dump yet, and refusing to deploy over
   that would be worse than saying so.
2. A failed run no longer leaves a **partial** `.sql.gz` behind. `set -e`
   aborts mid-pipeline, and the truncated file it used to leave carried a
   FRESH timestamp — so retention and the verify check would both have counted
   it as real. An `EXIT` trap now deletes it.
3. Every dump is checked with `gzip -t` and against a size floor
   (`MIN_DUMP_BYTES`, default 100 KiB). `pipefail` catches a failed `pg_dump`,
   but a gzip of zero bytes is about 20 bytes and passes every other check —
   only the size floor catches a dump that "succeeded" with nothing in it.

Still true: nothing _pages_ anyone. The deploy warning is the alerting
mechanism, so a long gap between deploys is a long gap between checks.

Set `OFFSITE_REMOTE_CMD` to whatever offsite tool is chosen (rclone to
S3/B2/Drive, `aws s3 cp`, `scp` to a second host, etc.) — the script no-ops
the offsite step until this is set, so it's safe to enable local backups
immediately and wire offsite storage separately.

## Manual backup (any time)

```bash
POSTGRES_PASSWORD=mimi_secret ./infrastructure/backup/backup.sh
```

Dumps land in `infrastructure/backup/dumps/mimi-<timestamp>.sql.gz` (never
committed — see root `.gitignore`).

## Restore procedure

**Destructive — this overwrites the target database.** Only run against a
throwaway/staging DB unless you are deliberately performing disaster
recovery, and confirm with the orchestrator/owner first per the state-
destroying-operations rule.

```bash
# 1. Stop the app services so nothing writes during restore (data layer can stay up):
docker compose stop backend frontend

# 2. Decompress the chosen dump:
gunzip -k infrastructure/backup/dumps/mimi-<timestamp>.sql.gz

# 3. Drop and recreate the target database (DESTRUCTIVE):
docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" mimi-postgres \
  dropdb -U mimi --if-exists mimi
docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" mimi-postgres \
  createdb -U mimi -O mimi mimi

# 4. Load the dump:
docker exec -i -e PGPASSWORD="$POSTGRES_PASSWORD" mimi-postgres \
  psql -U mimi -d mimi < infrastructure/backup/dumps/mimi-<timestamp>.sql

# 5. Bring the app back up and verify:
docker compose start backend frontend
docker compose ps
curl -sf http://127.0.0.1:${BACKEND_PORT:-4000}/health
```

## Restore drill

Run the restore procedure against a scratch database/container at least
once before go-live (W7-01's "restore drill" deliverable) — a backup nobody
has ever restored from is not a backup.
