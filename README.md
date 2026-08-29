# Mimi Chicken Operational System

Single-tenant POS, logistics (Surat Jalan + cold chain), HR/payroll, full
double-entry GL, and a three-tier offline-first sync protocol for one
central warehouse (Balikpapan) supplying 15–20 fried-chicken outlets across
4 Kalimantan cities.

See `docs/BUILD-PLAN.md` for the full architecture, decisions, and build
partition. This README only covers running the stack.

## Stack

pnpm 9 workspaces · Node 22 · TypeScript 6 · NestJS 11 (raw `pg`, no ORM) ·
Postgres 16 + RLS · Redis 7 · MinIO · Next 15 / React 19 / Tailwind 4 ·
socket.io · n8n · Docker Compose + Traefik. Timezone is fixed **WITA**
(`Asia/Makassar`) app-wide (decision D-11).

## Prerequisites

- Docker + Docker Compose v2
- Node.js >= 22
- pnpm >= 9 (`npm install -g pnpm@9`)

### On Windows: `pnpm build` needs symlink permission

`apps/frontend` builds with Next's `output: 'standalone'`, which symlinks its
traced dependencies. Windows refuses that by default, so `pnpm build` ends with:

```
Error: EPERM: operation not permitted, symlink '...node_modules/react' -> '....next/standalone/...'
```

**This is a Windows permission setting, not a broken build.** The same commit
builds cleanly in CI and in the deploy container (both Linux). Verified
2026-08-29: CI reported `✓ Compiled successfully` and `✓ Generating static pages
(48/48)` for the commit that fails locally.

Fix it by enabling **Developer Mode** (Settings → System → For developers), or
run the build from an elevated shell. Everything else — `pnpm lint`, the
typechecks, every test suite, `pnpm db:*` — works unelevated, so this only bites
when you build the frontend locally, which you rarely need to: `pnpm dev` does
not use standalone output.

## First run

```bash
cp .env.example .env
pnpm install
bash scripts/dev.sh
```

`scripts/dev.sh` installs dependencies, brings up postgres/redis/minio/n8n/
backend/frontend, waits for postgres to report healthy, and runs migrations

- seed once `database/migrations` has files in it (it is empty until
  `senior-db` / Wave 1-C lands the schema — this is expected early in the
  build).

Or step by step:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
pnpm db:migrate
pnpm db:seed
```

Services:

| Service       | URL                          |
| ------------- | ---------------------------- |
| Frontend      | http://localhost:3000        |
| Backend API   | http://localhost:4000/health |
| MinIO console | http://localhost:9001        |
| n8n           | http://localhost:5678        |

## Optional: branch-node (Tier 2, hardware-free)

The default deployment needs zero on-prem hardware. To exercise the
optional Tier-2 branch-node locally (`SIMULATE=true`, no real LAN/hardware):

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml --profile branch-node up -d branch-node
curl -sf http://localhost:4010/health
```

## Scripts

| Command                        | Description                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------ |
| `pnpm dev`                     | Start backend + frontend in watch mode (outside Docker)                        |
| `pnpm build`                   | Build every workspace package                                                  |
| `pnpm lint`                    | Lint every workspace package                                                   |
| `pnpm format` / `format:check` | Prettier write / check                                                         |
| `pnpm test`                    | Run every workspace's test suite (Vitest)                                      |
| `pnpm db:migrate`              | Apply pending SQL migrations                                                   |
| `pnpm db:migrate:status`       | Show migration status                                                          |
| `pnpm db:seed`                 | Load the realistic seed (1 gudang, 20 outlets, ~120 items, 130 employees, ...) |
| `pnpm db:reset`                | **Destructive** — drop and rebuild the database                                |
| `pnpm e2e`                     | Run the Playwright E2E suite (`e2e/`)                                          |

## Database — two connection identities (D-21 / D-22)

The stack deliberately uses **two separate DB connection strings**, never
one — see `docs/BUILD-PLAN.md` D-21/D-22 for the full incident writeup (a
shared/superuser connection let a Kasir see all 418 sales instead of 64,
because Postgres skips RLS for a superuser regardless of `FORCE ROW LEVEL
SECURITY`):

- **`DATABASE_URL`** — the backend's runtime connection. Authenticates as
  `mimi_app`, a dedicated non-superuser `LOGIN` role with no `BYPASSRLS`,
  owning nothing, granted membership in `app_user`.
- **`DATABASE_MIGRATION_URL`** — the owner/superuser connection.
  `@mimi/database`'s `migrate`/`seed`/`reset` scripts use this one, since
  they must create and own schema objects.

Never collapse these back into one variable. See the comments in
`.env.example` / `.env.prod.example` for the full rationale, and
`database/README.md`'s RLS section (owned by senior-db) for how `app_user`
and `mimi_app` fit together on the schema side.

## Production deploy

See `infrastructure/traefik/README.md` and `infrastructure/backup/README.md`.
Short version:

```bash
cp .env.prod.example .env   # fill every CHANGE_ME
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

## Repository layout

See `docs/BUILD-PLAN.md` §3 for the full annotated tree and §6 for file
ownership / collision rules — this is a multi-agent build; do not add files
outside your assigned paths.
