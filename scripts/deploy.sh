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
  docker compose "${COMPOSE[@]}" up -d --no-build --no-deps frontend backend
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

log "building and starting: ${SERVICES[*]}"
# `--no-deps` is load-bearing. Without it compose also RECREATES postgres, redis
# and minio on every deploy, because their running config was written under a
# different overlay and no longer matches. Restarting the database to ship a
# frontend change is both needless downtime and the churn that produced the
# orphans above. The data survives (named volumes), but nothing about it is
# wanted: infra is brought up deliberately, not as a side effect of a deploy.
docker compose "${COMPOSE[@]}" up -d --build --no-deps "${SERVICES[@]}"

# ---------------------------------------------------------------------------
# Verify — a deploy that is not checked is a deploy you are guessing about
# ---------------------------------------------------------------------------
# BOTH entrances, because checking only one is how a deploy that had already
# removed :8080 reported itself healthy: the HTTPS origin is served by the
# separate `mimitls` project and keeps working even when the app's own published
# port has gone.
PUBLIC_URL="${VPS_PUBLIC_URL:-https://150-109-15-108.sslip.io}"
DIRECT_URL="${VPS_DIRECT_URL:-http://150.109.15.108:${FRONTEND_PUBLIC_PORT:-8080}}"
log "waiting for $PUBLIC_URL/login and $DIRECT_URL/login"
for attempt in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$PUBLIC_URL/login" || echo 000)
  direct=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$DIRECT_URL/login" || echo 000)
  if [ "$code" = "200" ] && [ "$direct" = "200" ]; then
    log "OK — both entrances returned 200 after ${attempt} attempt(s)"
    log "previous images kept as :previous — ./scripts/deploy.sh --rollback"
    exit 0
  fi
  sleep 5
done

echo "" >&2
echo "DEPLOY UNVERIFIED: $PUBLIC_URL/login=$code  $DIRECT_URL/login=$direct (want 200/200)." >&2
echo "The new containers ARE running. To go back:" >&2
echo "    ./scripts/deploy.sh --rollback" >&2
exit 1
