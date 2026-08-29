#!/usr/bin/env bash
#
# Deploy Mimi Chicken OS to the VPS — the ONLY supported way to do it.
#
# ## Why this script exists
#
# On 2026-08-24 the frontend was deployed with
#
#     docker compose -f docker-compose.yml build frontend
#
# which omits `docker-compose.prod.yml`. The base file alone is the DEVELOPMENT
# variant, so that command built a dev image and pushed it over the
# `mimi-frontend:latest` tag that production runs. The image had no Next.js
# build output, every request returned HTTP 500, and the site was down until it
# was rebuilt correctly.
#
# Two things turned a wrong command into an outage:
#
#   1. The correct invocation lived only in `docs/STAGING.md`. Documentation
#      cannot stop you typing something shorter that appears to work.
#   2. The build overwrote `:latest` in place, and nothing else referenced the
#      previous image, so Docker had already collected it. There was no rollback
#      — not even a dangling image. Recovery was only possible by rebuilding,
#      which is the slowest option at exactly the wrong moment.
#
# This script fixes both: one entry point that cannot be invoked with the wrong
# compose files, and a retained previous tag so rollback is a tag swap.
#
# ## Usage
#
#   ./scripts/deploy.sh                 # migrate, build + deploy backend+frontend
#   ./scripts/deploy.sh frontend        # one service
#   ./scripts/deploy.sh --no-migrate    # skip migrations (they are idempotent;
#                                       #   skip only if you just ran them)
#   ./scripts/deploy.sh --rollback      # restore the previous images and restart
#
# Run it from the repo root on the VPS. It sources `.env.vps` itself.

set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$PWD"

# The base file plus THIS BOX'S overlay, together, always.
#
# `docker-compose.yml` alone is the DEV variant — building with it produces an
# image with no Next build output. But the overlay matters just as much, and the
# first version of this script got it wrong by picking `prod.yml`:
#
#   prod.yml  — a dedicated host with a real DOMAIN. Runs its OWN Traefik on
#               :80/:443 and publishes the frontend to 127.0.0.1 only, because
#               that Traefik is meant to front it. Its own header says it
#               "cannot be used here" until a hostname exists.
#   vps.yml   — THIS box: shared with seven other compose projects, no domain,
#               no Traefik, frontend published on 0.0.0.0:${FRONTEND_PUBLIC_PORT}
#               (8080) as the single public entry point.
#
# Deploying with prod.yml did two kinds of damage: its Traefik collided with the
# separate `mimitls` project already holding :80, aborting the deploy mid-way;
# and by binding the frontend to loopback it silently REMOVED
# http://150.109.15.108:8080, the URL people actually use. HTTPS kept working
# through the TLS project, so every check I ran said the site was up while the
# owner was looking at a dead page.
#
# Overridable, because the day a domain exists prod.yml becomes correct:
#   COMPOSE_OVERLAY=docker-compose.prod.yml ./scripts/deploy.sh
COMPOSE_OVERLAY="${COMPOSE_OVERLAY:-docker-compose.vps.yml}"
COMPOSE=(-p mimi -f docker-compose.yml -f "$COMPOSE_OVERLAY")

ENV_FILE="${ENV_FILE:-$REPO_ROOT/.env.vps}"
if [ ! -f "$ENV_FILE" ]; then
  echo "FATAL: $ENV_FILE not found. Deploys read their secrets from it." >&2
  exit 1
fi
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

# Only `prod.yml` interpolates ACME_EMAIL (for its Traefik). vps.yml does not,
# but compose interpolates the WHOLE overlay before deciding what to start, so
# the variable must resolve whenever prod.yml is the chosen overlay.
export ACME_EMAIL="${ACME_EMAIL:-hansel@gaiada.com}"

# The services this box actually runs, and the DEFAULT when none are named.
#
# Not "everything in the compose files", which is what the first version did and
# why its first real run took the site down. `docker-compose.prod.yml` declares
# a Traefik, but TLS on this box is a SEPARATE compose project (`mimitls`, see
# infrastructure/tls/) holding :80 and :443 — so bringing up the bundled one
# aborts on "port is already allocated", and compose stops mid-sequence with
# backend and frontend recreated but never started. It also declares n8n, which
# is not part of a normal app deploy.
#
# Naming the services explicitly means a deploy can only ever touch the app.
DEFAULT_SERVICES=(backend frontend)

SERVICES=()
DO_MIGRATE=1
ROLLBACK=0
for arg in "$@"; do
  case "$arg" in
    --no-migrate) DO_MIGRATE=0 ;;
    --rollback) ROLLBACK=1 ;;
    -*) echo "Unknown flag: $arg" >&2; exit 2 ;;
    *) SERVICES+=("$arg") ;;
  esac
done

IMAGES=(mimi-frontend mimi-backend)

log() { echo "[$(date -Iseconds)] $*"; }

# ---------------------------------------------------------------------------
# Rollback
# ---------------------------------------------------------------------------
if [ "$ROLLBACK" = 1 ]; then
  missing=0
  for img in "${IMAGES[@]}"; do
    if ! docker image inspect "$img:previous" >/dev/null 2>&1; then
      echo "No $img:previous — nothing to roll back to." >&2
      missing=1
    fi
  done
  [ "$missing" = 1 ] && exit 1

  for img in "${IMAGES[@]}"; do
    log "restoring $img:previous -> :latest"
    docker tag "$img:previous" "$img:latest"
  done
  docker compose "${COMPOSE[@]}" up -d --no-build frontend backend
  log "rolled back. The database is NOT rolled back — migrations are forward-only."
  exit 0
fi

# ---------------------------------------------------------------------------
# Retain the current images before anything overwrites them
# ---------------------------------------------------------------------------
# Done BEFORE the build, not after: after is too late, because the build has
# already taken the tag. This is the single step whose absence turned a bad
# build into an outage with no way back.
for img in "${IMAGES[@]}"; do
  if docker image inspect "$img:latest" >/dev/null 2>&1; then
    docker tag "$img:latest" "$img:previous"
    log "retained $img:latest as :previous"
  else
    log "no existing $img:latest to retain (first deploy?)"
  fi
done

# ---------------------------------------------------------------------------
# Migrate before the new code runs
# ---------------------------------------------------------------------------
# Deliberately before the build: a migration that fails should stop the deploy
# while the OLD code is still serving, not after new code is already live
# against a schema it does not have.
if [ "$DO_MIGRATE" = 1 ]; then
  log "running migrations"
  docker run --rm --network mimi_mimi-network \
    -v "$REPO_ROOT:/app" -w /app/database \
    -e DATABASE_MIGRATION_URL="$DATABASE_MIGRATION_URL" \
    node:22-alpine npx tsx migrate.ts
fi

# ---------------------------------------------------------------------------
# Build and start
# ---------------------------------------------------------------------------
if [ ${#SERVICES[@]} -eq 0 ]; then
  SERVICES=("${DEFAULT_SERVICES[@]}")
fi
# Orphans from a previous half-finished recreate. Compose renames a container to
# `<hash>_<name>` while replacing it, and if that replacement dies partway — an
# SSH drop mid-build, a daemon hiccup — the renamed one is left holding the name
# and the published port. The next deploy then fails with "No such container" or
# "port is already allocated", and every subsequent one fails the same way until
# somebody clears it by hand. This happened four times in one afternoon.
for stale in $(docker ps -a --format '{{.ID}} {{.Names}}' | grep -E '_mimi-(backend|frontend)$' | awk '{print $1}'); do
  log "removing orphaned container $stale from an interrupted deploy"
  docker rm -f "$stale" >/dev/null 2>&1 || true
done

# Compose's replace dance is unreliable on this box: it renames the running
# container to `<hash>_<name>` before starting the replacement, and when that
# half-completes the rename is left holding the name. The next deploy then dies
# with "Conflict. The container name ... is already in use", leaves the real
# container in `Created`, and the site goes down — five times today.
#
# Sweeping beforehand is not enough, because the conflicting name is created
# DURING the up. So: try the up, and if it fails, clear every app container by
# name and recreate from scratch. Recreating is safe — all state is in named
# volumes and the database is not in this list.
compose_up() {
  if ! compose_up; then
  log "compose up failed — clearing app containers (including half-renamed ones) and retrying"
  for svc in "${DEFAULT_SERVICES[@]}"; do
    # Both the real name and any `<hash>_<name>` rename left behind.
    docker ps -aq --filter "name=mimi-$svc" | xargs -r docker rm -f >/dev/null 2>&1 || true
  done
  compose_up
fi
}

log "building and starting: ${SERVICES[*]}"
# NO `--no-deps` here, despite it looking like the right guard.
#
# It was added to stop deploys recreating postgres/redis/minio, and it did — by
# causing something worse. Compose still RECONCILES a dependency whose config has
# drifted, leaving it in `Created`, and `--no-deps` then declines to start it. So
# every `deploy.sh frontend` silently stopped the backend, and the site 502'd
# with a container that looked present in `docker ps -a`.
#
# The recreates were never really about the flag. They happened because the
# running containers had been created under `prod.yml` and no longer matched
# `vps.yml`, so compose wanted to replace them every time. Once the whole stack
# was brought up ONCE under this overlay the drift went away, and a
# frontend-only deploy now leaves the backend untouched. Pinning the overlay at
# the top of this script is what keeps it that way.
docker compose "${COMPOSE[@]}" up -d --build "${SERVICES[@]}"

# A container can be left in `Created` by an interrupted run. `docker ps` does
# not show it and the failure looks like a network or DNS problem three layers
# up, so check the state directly rather than inferring it from an HTTP probe.
for svc in "${DEFAULT_SERVICES[@]}"; do
  state=$(docker inspect "mimi-$svc" --format '{{.State.Status}}' 2>/dev/null || echo missing)
  if [ "$state" != "running" ]; then
    log "mimi-$svc is '$state' — starting it"
    docker start "mimi-$svc" >/dev/null 2>&1 || true
  fi
done

# ---------------------------------------------------------------------------
# Backups (NFR-06) — install the nightly job, then check it is actually working
# ---------------------------------------------------------------------------
# infrastructure/backup/backup.sh has existed since Wave 1 and was never
# scheduled: its README says "not wired into cron yet — that's a W7-01 ticket".
# A backup script nobody installed is not a backup, so the deploy installs it.
#
# Idempotent by marker comment, not by grepping for the command line: the
# command contains paths and redirections that are easy to reformat, and a
# near-match would silently install a SECOND nightly job.
CRON_MARKER="# mimi-chicken nightly backup (NFR-06)"
if ! crontab -l 2>/dev/null | grep -qF "$CRON_MARKER"; then
  log "installing nightly backup cron (02:00 WITA)"
  {
    crontab -l 2>/dev/null || true
    echo "$CRON_MARKER"
    # `bash <script>` deliberately, never `./<script>`: this job once died
    # every night for a week on a lost executable bit, and an executable bit
    # is easy to lose (a zip round-trip, a Windows checkout, a cp out of a
    # container). Invoking through bash makes that failure impossible.
    echo "0 2 * * * cd $PWD && set -a && . ./.env.vps && set +a && bash ./infrastructure/backup/backup.sh >> $HOME/mimi-backup.log 2>&1"
  } | crontab -
else
  log "nightly backup cron already installed"
fi

# Verify rather than assume. This is the check whose absence let five
# consecutive silent failures go unnoticed. A warning, not a failure: a
# freshly provisioned box legitimately has no dump yet, and refusing to deploy
# over that would be worse than saying so.
if bash ./infrastructure/backup/backup.sh verify; then
  :
else
  echo "" >&2
  echo "WARNING: no recent database backup (NFR-06). The cron job is installed;" >&2
  echo "if this persists past tomorrow, run it by hand and read the output:" >&2
  echo "    set -a && . ./.env.vps && set +a && bash ./infrastructure/backup/backup.sh" >&2
  echo "" >&2
fi

# ---------------------------------------------------------------------------
# Verify — a deploy that is not checked is a deploy you are guessing about
# ---------------------------------------------------------------------------
# BOTH entrances, because checking only one is how a deploy that had already
# removed :8080 reported itself healthy: the HTTPS origin is served by the
# separate `mimitls` project and keeps working even when the app's own published
# port has gone.
PUBLIC_URL="${VPS_PUBLIC_URL:-https://150-109-15-108.sslip.io}"
DIRECT_URL="${VPS_DIRECT_URL:-http://150.109.15.108:${FRONTEND_PUBLIC_PORT:-8080}}"
# THE API IS PROBED SEPARATELY FROM THE PAGE, and that is the whole point.
#
# This check used to be the two /login pages alone. On 2026-08-29 the deployed
# backend had leaked its entire connection pool (every HTTP 403 abandoned one —
# see app.module.ts's guard-order comment), so EVERY api call returned 500
# "timeout exceeded when trying to connect" and the system was unusable. This
# script reported the deploy healthy anyway, because /login is a rendered page
# and renders perfectly well with no database behind it.
#
# A deploy check that cannot tell a working system from a dead one is worse
# than none: it converts an outage into a green tick.
#
# The API probe is a login with DELIBERATELY BAD credentials. It needs no
# secrets, changes nothing, and is unambiguous: 401 means the request reached
# the handler, took a pooled connection, queried users and came back — the
# whole path. 500 means the pool is gone. A 200 would be alarming in its own
# right and is not treated as success either.
API_LOGIN="$PUBLIC_URL/api/auth/login"
log "waiting for $PUBLIC_URL/login, $DIRECT_URL/login and a live API on $API_LOGIN"
for attempt in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$PUBLIC_URL/login" || echo 000)
  direct=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$DIRECT_URL/login" || echo 000)
  api=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST "$API_LOGIN"     -H 'Content-Type: application/json'     -d '{"username":"deploy-healthcheck-not-a-user","password":"x"}' || echo 000)
  if [ "$code" = "200" ] && [ "$direct" = "200" ] && [ "$api" = "401" ]; then
    log "OK — both entrances 200 and the API answered 401 after ${attempt} attempt(s)"
    log "previous images kept as :previous — ./scripts/deploy.sh --rollback"
    exit 0
  fi
  sleep 5
done

echo "" >&2
echo "DEPLOY UNVERIFIED: $PUBLIC_URL/login=$code  $DIRECT_URL/login=$direct  api=$api (want 200/200/401)." >&2
if [ "$api" = "500" ]; then
  echo "api=500 usually means the database pool is exhausted — check:" >&2
  echo "    docker exec mimi-postgres psql -U mimi -d mimi -c \"SELECT count(*) FROM pg_stat_activity WHERE state='idle in transaction'\"" >&2
fi
echo "The new containers ARE running. To go back:" >&2
echo "    ./scripts/deploy.sh --rollback" >&2
exit 1
