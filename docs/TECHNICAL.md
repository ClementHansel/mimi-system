# Mimi Chicken OS — Technical Handover

**W7-02.** For the engineer who inherits this system. It assumes you can read TypeScript and SQL, and
explains the things the code cannot tell you on its own: why the layers are drawn where they are, which
rules are load-bearing, and where the sharp edges are.

Three companion documents carry detail this one deliberately does not duplicate:

| Document                | What it owns                                                            |
| ----------------------- | ----------------------------------------------------------------------- |
| `docs/CONTRACTS.md`     | Every endpoint, table, permission key, approval chain and posting rule  |
| `docs/SYNC-PROTOCOL.md` | The offline/sync wire format, conflict rules and the degradation matrix |
| `docs/LINEAR.md`        | How progress is tracked — Linear team `MA`, branch naming, the QA flow |
| `docs/PROGRESS.md`      | **Frozen 2026-08-24.** Historical record of the build and its blockers |

If this document and `CONTRACTS.md` ever disagree, **CONTRACTS.md is the contract** and this one is stale.

---

## 1. What the system is

One central warehouse in Balikpapan supplies 15–20 fried-chicken outlets across four Kalimantan cities.
Goods flow **Supplier → Gudang Pusat → Surat Jalan → Outlet Storage → POS**; money and accountability flow
back the other way.

The single hardest requirement, and the one that shapes the whole architecture: **every outlet must keep
selling when its internet dies.** Branch connectivity is genuinely unreliable (RISK-02), so the system is
offline-first at the till and at the outlet, not merely "resilient".

---

## 2. Shape of the repository

```
apps/
  backend/      NestJS API — the only writer of the database
  frontend/     Next.js app — seven interfaces (see §6)
  branch-node/  Optional per-outlet LAN relay (Tier 2, D-26) — not required to run
packages/
  shared/         Types, enums, RBAC matrix, money/qty decimals, GL posting rules
  sync-protocol/  Wire envelope, authority matrix, payload schema registry
database/
  migrations/   Numbered, forward-only SQL. The runner keys on FILENAME
  seed.ts       A realistic demo dataset (20 outlets, real recipes, real payroll)
e2e/            Playwright, run against a deployed box
perf/           k6 load suite (see §11 — never yet run for real)
```

`pnpm` workspaces. `packages/shared` must be **built** (`pnpm --filter @mimi/shared build`) before the
backend typechecks, because the backend resolves it through `dist`.

---

## 3. The layering rule that matters most

```
apps/backend/src/
  kernel/     approvals, audit, auth-lockout, events, notification,
              stock-ledger, storage, sync
  modules/    the 24 domain modules
  common/     guards, decorators, database helpers, JWT
```

**A kernel never imports a domain module.** This is not style; it is what keeps the dependency graph
acyclic. Where the kernel needs domain behaviour, the domain module _registers itself_ with the kernel —
see `SyncProjectorRegistry` (§7) for the canonical example.

Domain modules may import other domain modules read-only, and several do (`purchasing` uses
`accounting`'s `PaymentVerificationsService`). Writing another module's tables from outside it is the line
nobody crosses.

---

## 4. The database, and the four rules you must not break

Postgres 16. 114 migrations, ~111 tables, row-level security on nearly all of them.

**4.1 — The app connects as `mimi_app`, which owns nothing.** `mimi_app` is `NOINHERIT` into `app_user` and
holds no table grants of its own. Every request does `SET LOCAL ROLE app_user` plus three session GUCs
(`app.user_id`, `app.role`, `app.location_ids`), which is what the RLS policies read. A service that
queries a raw pool connection instead of `request.dbClient` gets `permission denied` — deliberately, and
several real bugs were caught only because of it. Boot refuses outright if the connection is a superuser.

**4.2 — Every mutating request must COMMIT its own transaction.** `RlsCleanupInterceptor` issues an
unconditional `ROLLBACK` after each request, on the assumption the module already committed. Ten modules
once did not, and returned `201` for writes that silently vanished. The interceptor now detects an
uncommitted write on a successful mutating response and throws outside production. **When you add a
mutating endpoint, commit — and assert the read-back on a separate connection, because a 2xx body is not
evidence of persistence.**

**4.3 — `SET LOCAL ROLE` is reset by COMMIT.** A test or service that commits mid-transaction and then
queries again on the same connection is suddenly bare `mimi_app`. The symptom is `permission denied` that
looks like an RLS bug and is not one.

**4.4 — `stock_balances` is written by exactly one thing.** `kernel/stock-ledger` is the sole writer; every
movement goes through it. Writing that table directly desynchronises it from `fold(stock_movements)`, which
is a checked invariant. Posting from a projector uses `mode: 'fact'`, never `'strict'` — the chicken really
did move, and a strict-mode rejection would silently drop a real fact.

Migrations are **forward-only** and the runner keys on the full filename, so two files sharing a number
both apply, in arbitrary string order. Numbers have collided before under concurrent work; check
`ls database/migrations | tail` before choosing one.

---

## 5. Authentication, authorization and money

Four independent layers, each of which can refuse:

1. **`JwtAuthGuard`** — is there a valid session?
2. **`PermissionsGuard`** — does this role hold the route's key? The matrix is
   `packages/shared/src/rbac.ts`, 147 keys × 10 roles, and it is the authority; the `permissions` table is
   a display cache kept in step by hand.
3. **RLS** — may this role see _these rows_? Location scope lives here, not in application code.
4. **The approval state machine** (`packages/shared/src/approvals/state-machine.ts`) — may this role take
   _this transition_ on _this document_? Twelve chains, with a `ROLE_RANK` override so a manager can act on
   a step below them.

**Approvals never get hand-rolled.** A domain module owns its own `status` column; who may change it and
whether a reason is required belongs to `kernel/approvals`.

**One-time approval codes (B-15).** There is no endpoint that verifies a standing PIN, and there must never
be one again. When an action needs a supervisor's authorisation, the approver mints a single-use six-digit
code from their own session (`POST /api/approvals/:documentType/:documentId/code`); whoever is holding the
document redeems it. Wrong codes lock the _caller_, never the approver. See `kernel/approvals/
approval-code.service.ts`.

**Money and quantities are decimal STRINGS, end to end.** `Money` is `NUMERIC(18,2)`, `Qty` is
`NUMERIC(14,3)`, and both arrive from `pg` as strings. Do not route them through a JavaScript number
anywhere — not in a report, not in an export, not "just for a comparison". Use the helpers in
`packages/shared/src/money.ts` and `qty.ts`.

**Dates are WITA (`Asia/Makassar`, UTC+8).** The business day is not UTC. A Postgres `DATE` read as a JS
`Date` lands on the previous day for the first eight hours of every day here; this has bitten the project
three separate times. Use `businessDateOf` and `common/wita-occurred-at.util.ts`.

---

## 6. The frontend

Next.js App Router. The owner's ruling (2026-08-21) is that the system has **seven interfaces**, not
fourteen destinations: `dashboard`, `pos`, `outlet`, `warehouse`, `driver`, `docs`, `employee`. Everything
else — `/approvals`, `/delivery`, `/purchasing`, `/chat`, `/finance`, `/hr`, `/assets`, `/me`, `/admin`,
`/topology` — is a **section inside the dashboard**, and appears only in the dashboard's sidebar.
`lib/nav.ts` encodes both levels and is the single source; the hub derives from it rather than listing
routes of its own.

`AppShell` renders nothing until the session store has hydrated, so no control is clickable before its
handler is attached. `/login` is the only public route and guards itself separately.

All user-facing copy is Bahasa Indonesia and lives in `lib/i18n/id.ts` on the frontend and
`kernel/notification/i18n/id-ID.ts` on the backend. **Indonesian strings do not belong anywhere else.**

---

## 7. Offline-first: how a fact travels

This is the part most likely to surprise you.

A device (a POS tablet, an outlet phone) holds an **IndexedDB outbox**. Acting offline writes a _fact_ —
past tense, immutable — into that outbox with a client-minted UUIDv7 and a gapless per-origin `clientSeq`.
When connectivity returns, facts push to `/sync/v1/push`.

Server-side, ingest is **two stages, deliberately**:

1. **Log** — `SyncIngestService` durably records the event, dedupes by `event_id`, and runs conflict
   detection. This stage never rejects a fact for a domain reason.
2. **Project** — `SyncProjectorRegistry` looks up a `SyncProjector` for `"<entity>.<op>"` and, inside a
   `SAVEPOINT`, turns the fact into domain rows. A projector that throws rolls back only its own writes and
   raises a `sync_conflicts` exception; the fact itself is still recorded.

**The trap to know about:** an `(entity, op)` with no registered projector is treated as SUCCESS. That is
right for the many pull-only and logged-only entities, and it is a silent data-loss trap for anything that
is genuinely captured offline. B-11 was exactly this — four outlet flows pushed successfully for waves and
never became rows. **If you add a pushable op, register a projector for it, and write a test that asserts
`registry.isRegistered(entity, op)`.**

Three more rules for projectors:

- **Call the owning module's service, never its tables.** That keeps the offline path on the same
  validation, numbering and approval flow as the REST path.
- **Idempotency uses the DEVICE's document id**, never `event.eventId` — a retried push carries a new
  event id and the same document id.
- **Document numbers are always re-issued server-side.** Two devices offline mint the same one and those
  columns are UNIQUE.

Offline _approvals_ (D-17) are separate: a supervisor's provisional approval carries an HMAC binding
computed from a cached credential, and the cloud **re-verifies** all of it at apply time (§7.4). The
device's verdict is advisory UX.

---

## 8. Running it locally

```bash
docker compose up -d postgres redis minio
pnpm install
pnpm --filter @mimi/shared build     # required before anything typechecks
pnpm db:migrate && pnpm db:seed
pnpm dev
```

Seeded logins: any seeded username (`owner`, `manager1`, `spv_bpp01`, …) with password `password123`.
Seeded PIN for approver roles: `123456`.

**Test on Linux, not on Windows** (owner's standing rule, 2026-08-23). The server is Linux and the
divergence is real. The established loop is in `docs/PROGRESS.md` §1a-0: push a branch, check it out into a
separate git worktree on the VPS, run the suite in a `node:22-alpine` container against a **throwaway**
Postgres on the compose network, build the production images under a different compose project name, and
only then merge.

---

## 9. Deployment

`main` auto-deploys via `.github/workflows/deploy-vps.yml`: fetch, hard reset, **run migrations**, then
`compose up -d --build`. The migration step runs before the rebuild on purpose — shipping code whose
migration has not applied produces a stack that comes up "healthy" and quietly behaves as though the fix
were not there.

The box hosts **seven unrelated compose projects**. Every command is scoped `-p mimi` and to
`/home/ubuntu/mimi`. Nothing prunes images, prunes volumes or restarts the Docker daemon — all three would
hit the neighbours. `.env.vps` holds production secrets, lives only on the server, and never travels
through CI.

A post-deploy `e2e-smoke` job runs three Playwright specs against the box that was just deployed. It cannot
fail the deploy (the stack is already live) but it fails the run loudly. It caught a stale assertion on its
very first execution.

Backups: nightly `pg_dump` at 02:00 via cron, restore-drilled. **`OFFSITE_REMOTE_CMD` is unset**, so dumps
sit on the same disk as the database — protection against a bad `DELETE`, not against losing the host.

---

## 10. Testing

| Suite             | Command                             | Notes                                               |
| ----------------- | ----------------------------------- | --------------------------------------------------- |
| Backend           | `pnpm --filter @mimi/backend test`  | Needs `DATABASE_URL`; live-DB specs skip without it |
| Frontend          | `pnpm --filter @mimi/frontend test` | jsdom, no database                                  |
| Shared / protocol | `pnpm --filter @mimi/shared test`   | Pure                                                |
| E2E               | `pnpm e2e`                          | Real browser against a deployed box                 |

Live-DB specs are **serialized** into their own vitest project; parallel ones race over shared seed data.
If you add a spec that touches Postgres and it does not match `INTEGRATION_GLOBS`, add it to
`EXTRA_LIVE_DB_SPECS` in `apps/backend/vitest.config.ts` — a missing entry means it silently runs in the
parallel project and produces flakes that look like product bugs.

Conventions worth keeping:

- Assert a read-back on a **separate connection**; a 2xx is not persistence.
- A test whose harness runs as `owner` cannot detect an RLS defect. Use the real role.
- Two-tier code (anything computed on both device and server) gets a **known-answer fixture both sides**
  assert against. A previous two-tier HMAC agreed in prose, disagreed in bytes, and broke every offline
  approval silently.

---

## 11. Known sharp edges

- **No HTTPS on the demo box (B-14).** Plain HTTP means no secure context: geolocation and service workers
  are unavailable, so live truck tracking cannot function and the offline _shell_ cannot be exercised
  there. IndexedDB still works. `:80`/`:443` are held by a restart-looping neighbour container (`aire-nginx`), which reserves them without listening — see B-14 in PROGRESS.md.
- **NFR-01 has never been measured.** `perf/` holds a complete k6 suite that has never been executed;
  running it needs k6 plus a representative target, not a laptop.
- **Offline PIN guessing.** Someone holding a tablet can grind the cached `pin_verifier` outside the app.
  Accepted (physical possession required); mitigated by a backoff ladder, an attempt cap and a 24-hour
  credential TTL. See B-17.
- **`mv_delivery_recap_daily` cannot be aggregated** — its per-item grain double-counts when summed. Two
  agents independently found this and both routed around it.
- **The seed has no batch recipe** (`yield_qty` is 1 everywhere), so the yield-division path is unexercised
  by shared fixtures. That gap once hid a real bug for waves (D-28).

The technical-debt register (`D-01`…`D-30`) and the owed list now live in Linear team `MA` —
filter by the `debt` label. `docs/PROGRESS.md` §5 and §1a hold the frozen 2026-08-24 snapshot
they were migrated from.
