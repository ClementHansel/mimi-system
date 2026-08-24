# Postgres backup & restore (SCOPE-IN-11, NFR-06)

## What ships here

- `backup.sh` — nightly `pg_dump` (plain SQL, gzip'd), local rolling
  retention (`RETENTION_DAYS`, default 14), optional offsite copy hook.
  Not wired into cron yet — that's a W7-01 (VPS provisioning) ticket; this
  script is the artifact that ticket installs.

## Setup (done once, on the VPS, by W7-01)

```bash
crontab -e
# add — note `bash <script>`, not `<script>`:
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

**Nothing alerts on failure.** The log recorded five consecutive failures and
was not read, because reading it is a thing a person has to remember to do. A
dump that is not verified to exist is not a backup; see NFR-06 and the note
below on `drill:restore`.

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
