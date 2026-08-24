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
#   ./scripts/deploy.sh                 # migrate, build + deploy everything
#   ./scripts/deploy.sh frontend        # one service
#   ./scripts/deploy.sh --no-migrate    # skip migrations (they are idempotent;
#                                       #   skip only if you just ran them)
#   ./scripts/deploy.sh --rollback      # restore the previous images and restart
#
# Run it from the repo root on the VPS. It sources `.env.vps` itself.

set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$PWD"

# The two files, together, always. This pairing is the whole point of the
# script — `docker-compose.yml` on its own is the dev variant.
COMPOSE=(-p mimi -f docker-compose.yml -f docker-compose.prod.yml)

ENV_FILE="${ENV_FILE:-$REPO_ROOT/.env.vps}"
if [ ! -f "$ENV_FILE" ]; then
  echo "FATAL: $ENV_FILE not found. Deploys read their secrets from it." >&2
  exit 1
fi
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

# `docker-compose.prod.yml` declares a Traefik whose command interpolates
# ACME_EMAIL. TLS actually runs as a separate compose project (`mimitls`, see
# infrastructure/tls/), so that service is never started here — but compose
# interpolates the WHOLE file before it decides what to start, so the variable
# still has to resolve or nothing runs at all.
export ACME_EMAIL="${ACME_EMAIL:-hansel@gaiada.com}"

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
log "building and starting${SERVICES[*]:+ (${SERVICES[*]})}"
docker compose "${COMPOSE[@]}" up -d --build ${SERVICES[@]+"${SERVICES[@]}"}

# ---------------------------------------------------------------------------
# Verify — a deploy that is not checked is a deploy you are guessing about
# ---------------------------------------------------------------------------
PUBLIC_URL="${VPS_PUBLIC_URL:-https://150-109-15-108.sslip.io}"
log "waiting for $PUBLIC_URL/login"
for attempt in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$PUBLIC_URL/login" || echo 000)
  if [ "$code" = "200" ]; then
    log "OK — $PUBLIC_URL/login returned 200 after ${attempt} attempt(s)"
    log "previous images kept as :previous — ./scripts/deploy.sh --rollback"
    exit 0
  fi
  sleep 5
done

echo "" >&2
echo "DEPLOY UNVERIFIED: $PUBLIC_URL/login never returned 200 (last: $code)." >&2
echo "The new containers ARE running. To go back:" >&2
echo "    ./scripts/deploy.sh --rollback" >&2
exit 1
