#!/usr/bin/env bash
# =============================================================================
# Mimi Chicken OS — bring the local stack up cleanly on a fresh machine.
# =============================================================================
# Usage: bash scripts/dev.sh
#
# Idempotent: safe to re-run. Does NOT reset the database if one already
# exists — use `pnpm db:reset` explicitly for that (destructive).
# =============================================================================
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "==> Checking prerequisites..."
command -v docker >/dev/null || { echo "docker is required"; exit 1; }
docker compose version >/dev/null || { echo "docker compose v2 is required"; exit 1; }
command -v pnpm >/dev/null || { echo "pnpm is required (npm install -g pnpm@9)"; exit 1; }
command -v node >/dev/null || { echo "node >= 22 is required"; exit 1; }

if [ ! -f .env ]; then
  echo "==> No .env found, copying .env.example"
  cp .env.example .env
fi

echo "==> Installing workspace dependencies..."
pnpm install --frozen-lockfile

echo "==> Starting data-layer + app containers (dev overlay)..."
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build postgres redis minio n8n backend frontend

echo "==> Waiting for postgres to report healthy..."
for _ in $(seq 1 30); do
  status="$(docker inspect -f '{{.State.Health.Status}}' mimi-postgres 2>/dev/null || echo starting)"
  if [ "$status" = "healthy" ]; then break; fi
  sleep 2
done

echo "==> Running migrations (no-op until database/migrations has files)..."
# @mimi/database's migrate/seed/reset scripts read DATABASE_MIGRATION_URL —
# the OWNER connection — never DATABASE_URL, which is the backend's
# non-superuser runtime connection (D-21/D-22: the app must never connect as
# a table owner, or RLS is silently bypassed). Export .env explicitly here
# rather than relying on any in-script fallback default staying in sync.
if [ -n "$(find database/migrations -maxdepth 1 -name '*.sql' 2>/dev/null)" ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
  pnpm db:migrate
  echo "==> Seeding realistic demo data..."
  pnpm db:seed
else
  echo "    database/migrations is still empty — skipping migrate+seed."
fi

echo "==> Stack status:"
docker compose ps

cat <<'EOF'

==> Done.
    Frontend:      http://localhost:3000
    Backend API:   http://localhost:4000/health
    MinIO console: http://localhost:9001
    n8n:           http://localhost:5678

    Optional Tier-2 branch-node (hardware-free, SIMULATE=true):
      docker compose -f docker-compose.yml -f docker-compose.dev.yml --profile branch-node up -d branch-node

    Tear down:
      docker compose -f docker-compose.yml -f docker-compose.dev.yml down
EOF
