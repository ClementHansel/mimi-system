# Perf suite — W6-05

Ticket: **Perf (NFR-01: 150 concurrent, <3s) with k6; N+1 hunt; index review;
PWA Lighthouse; sync throughput at 20 outlets × 1 day backlog** (BUILD-PLAN.md
Wave 6). Evidences `docs/ACCEPTANCE.md` §7, NFR-01, which today reads `NONE`.

**The only performance target that exists anywhere in this repo is NFR-01:
"150 concurrent users, < 3s."** Every threshold below either applies that
number directly or is explicitly marked as unset pending an owner-supplied
target — nothing here invents a second number and calls it a requirement.

## What's in this directory

```
perf/
├─ README.md                          this file
├─ k6/
│  ├─ lib/                            config.js, auth.js, uuid.js — shared by every script
│  ├─ smoke.js                        1-VU sanity check — run this first
│  ├─ nfr01-150-concurrent.js         THE GATE SCRIPT — splits 150 VUs across a realistic traffic mix
│  └─ scenarios/                      one script per endpoint, each run at the full 150 VUs in isolation
│     ├─ pos-catalog-read.js
│     ├─ pos-sale-create.js
│     ├─ dashboard-overview.js
│     ├─ delivery-list.js             exercises N+1 finding #1 (below)
│     └─ driver-my-jobs.js            exercises N+1 finding #1's worst case
└─ sync-throughput/
   └─ sync-backlog-20outlets.js       20 outlets' simulated 1-day backlog through /sync/v1/push
```

## How to run

k6 is **not installed in this environment** — these scripts were authored and
reviewed for correctness but **not executed**. Install and run:

```bash
# install (not done here — pick whichever fits your machine)
choco install k6          # Windows
brew install k6           # macOS
# or download a binary: https://k6.io/docs/get-started/installation/

# 1. sanity check first — confirms seed + demo creds + base URL are good
k6 run perf/k6/smoke.js

# 2. the NFR-01 gate itself
k6 run perf/k6/nfr01-150-concurrent.js

# 3. per-endpoint isolation (optional, for narrowing down a gate failure)
k6 run perf/k6/scenarios/pos-sale-create.js
k6 run perf/k6/scenarios/delivery-list.js
# ...etc

# 4. sync throughput
k6 run perf/sync-throughput/sync-backlog-20outlets.js
```

Every script reads `BASE_URL` (default `http://localhost:4000`, matching
`apps/backend/src/main.ts`'s default port and `/api` global prefix). **Do
not** set `BASE_URL` to the production VPS (`http://150.109.15.108:8080`) —
that host runs seven other projects and a 150-VU run against it would be a
real incident, not a test. Point it at a local `docker compose` stack only,
and only one that is already running (this ticket did not start one — see
"What was NOT run" below).

All scripts assume `database/seed.ts`'s demo data (`password123` for every
seeded user, the 20-outlet/4-city fleet, `owner`/`gudang1`/`driver1`/
`kasir_<code>_<shift>` usernames). If the seed shape changes, these are the first
places to update.

## What was NOT run, and why

Per this ticket's hard constraints:

- **No load test was executed against the live VPS.** Confirmed via `docker
ps` that no `mimi-backend` container is running locally either (only
  `mimi-postgres`, `mimi-redis`, `mimi-minio` were up) — so even a tiny local
  smoke run was not attempted; there is no backend to point it at right now.
- **No `pnpm db:reset`/`db:seed`/full `pnpm test` was run** — other agents
  share this database.
- **Nothing was committed.**

This means **NFR-01's ACCEPTANCE.md row is still not evidenced by a real
number** — it is now evidenced by a _runnable, reviewed_ script instead of
nothing, which is the honest state of this ticket at handoff. Whoever next
has a free local stack (or a staging environment that isn't the shared VPS)
should run `k6 run perf/k6/nfr01-150-concurrent.js` and paste the summary
into ACCEPTANCE.md §7.

## Threshold policy

Every scenario applies `p(95) < 3000ms` (NFR-01's literal number) and
`http_req_failed rate < 1%`. Where a script measures something NFR-01 was
never written to cover (sync throughput; driver `my-jobs`, whose real
concurrency is a handful of trucks, not 150 tablets), the script says so in
its own header and either reuses NFR-01's number as a ceiling only, or
leaves the number unset entirely (`sync-backlog-20outlets.js` — see its
header for exactly why a p95 threshold there would be asserting something
nobody has stated).

---

## N+1 findings

Two real ones, found by reading every service in `apps/backend/src/modules/**`
that backs a listed hot endpoint (POS sale creation/list, catalog read,
dashboard, delivery list, driver jobs) and checking for a per-row query
inside a loop over a paginated result. Everything else read (inventory,
dashboard, tracking, route planning) batches correctly — see "clean" section
below.

### Finding 1 (the significant one): Surat Jalan list and driver my-jobs, 2-5 queries per row

- `apps/backend/src/modules/delivery/services/surat-jalan.service.ts:100-111`
  (`SuratJalanService.list`, backing `GET /api/delivery/surat-jalan` — the
  dispatcher's list) pages `surat_jalan.id`s with one query, then **for each
  id** calls `selectSuratJalanHeader` (1 query) then `buildSuratJalanSummary`
  (1 more query, for that SJ's drops) —
  `apps/backend/src/modules/delivery/queries.ts:345-370`. That's **2 queries
  per row**, on top of the id-paging query and a `COUNT(*)`. At the DTO's
  default `pageSize` of 50 (`ListSuratJalanQueryDto`), one list call is up to
  ~101 queries.

- `apps/backend/src/modules/delivery/services/surat-jalan.service.ts:119-142`
  (`SuratJalanService.myJobs`, backing `GET /api/delivery/my-jobs` — F13's
  driver pre-departure cache) is **worse per row**: for each assigned SJ it
  calls `selectSuratJalanHeader` (1 query) then `buildSuratJalanFull`
  (`queries.ts:306-315`), which fires **four more queries in parallel**
  (`selectDropsForSj`, `selectLinesForSj`, `selectTempLogsForSj`,
  `selectSealsForSj`) — **5 queries per Surat Jalan**. A driver with even a
  modest multi-drop day turns one app-open into 20-30+ queries.

  Both call sites reuse the same well-written batched helpers
  (`buildSuratJalanFull`/`buildSuratJalanSummary` themselves are fine — they
  `Promise.all` their own sub-queries rather than looping) — the N+1 is
  purely in the **outer** loop over the page of SJ ids, not inside those
  helpers.

  **Fix shape** (for whichever tier picks this up — `senior-be`, this is a
  service-layer rewrite, no schema change needed): batch-select drops/lines/
  temp-logs/seals for the WHOLE page of ids in one query each (`WHERE sj_id =
ANY($1::uuid[])`), group in memory by `sj_id`, same pattern
  `pos-sale.service.ts`'s `hydrateRows` already uses correctly for kasir
  names (see Finding 2's contrast) via `resolveUserNames(pool, ids)`. The
  existing per-`sj_id` helper functions in `queries.ts` would need `ForIds`
  siblings; the row→DTO mappers (`mapDropBase`, `mapTempLog`, `mapSeal`)
  don't need to change at all.

  `k6/scenarios/delivery-list.js` and `k6/scenarios/driver-my-jobs.js` in
  this suite exercise exactly these two call sites — watch query count (via
  `pg_stat_statements` or a query logger) scale linearly with `pageSize`/SJ
  count as the concrete evidence for whoever picks up the fix.

### Finding 2 (minor, same shape, smaller blast radius): POS sale list, 2 queries per row

- `apps/backend/src/modules/pos/services/pos-sale.service.ts:488-511`
  (`hydrateRows`/`hydrate`, backing `GET /api/pos/sales` — receipt history)
  batches the one thing that's easy to get wrong (kasir name resolution,
  `resolveUserNames(this.pool, rows.map(r => r.kasir_id))` — a single query
  for the whole page) but then loops `for (const row of rows)` and calls
  `hydrate()` per row, which itself runs **two more queries** (`sale_lines
JOIN products`, `sale_payments`) per sale. Same fix shape as Finding 1:
  batch both by `sale_id = ANY($1::uuid[])` and group in memory.

  Lower priority than Finding 1 — sales lists are typically filtered to one
  shift/day (bounded row count), where the SJ list has no such natural
  bound.

### Smaller, non-blocking observations (not filed as findings, noted for completeness)

- `apps/backend/src/modules/pos/services/pos-sale.service.ts:266-272` and
  `:274-316` — `sale_lines`/`sale_payments` inserts loop one `INSERT` per
  line/payment inside `applySaleFact`. Bounded by a human's cart size (a few
  lines), not by pagination, so this does not scale with data volume the way
  Findings 1-2 do. Multi-row `INSERT ... VALUES (...),(...)` would still be
  marginally cheaper per sale but is not worth the risk of touching the
  hottest write path for a ticket scoped to _finding_, not fixing.
- `apps/backend/src/modules/inventory/inventory.repository.ts:445-469`
  (`upsertMinStockRules`) — one `INSERT ... ON CONFLICT` per rule, in a loop.
  Same shape, same non-issue: an admin form submission, not a paginated read.
- `apps/backend/src/modules/delivery/services/tracking.service.ts:88-108`
  (`recordPositions`) — one `INSERT` per GPS breadcrumb in a batch. The
  batch is capped by how many fixes a phone queues in a dead zone (tens, not
  thousands per call); not filed as a finding, but worth a multi-row insert
  if this ever needs to absorb the full sync-throughput volume this ticket
  also asks about.
- `apps/backend/src/modules/report/services/delivery-report.service.ts:95+`
  loops per-city (bounded to 4 cities) to run one extra query each — negligible
  fan-out, not filed.

### What's clean (checked, not a finding)

- `apps/backend/src/modules/pos/services/pos-catalog.service.ts` — 2 queries
  total regardless of catalog size (products, then all recipe lines in one
  query), joined in memory. Textbook.
- `apps/backend/src/modules/dashboard/services/overview.service.ts` and
  `staff-kpi.service.ts` — matview-backed single aggregate queries, no loop.
- `apps/backend/src/modules/delivery/services/tracking.service.ts`'s
  `getLiveBoard` — one query with a `LATERAL JOIN` for "latest position per
  trip," not a per-truck round trip.
- `apps/backend/src/modules/inventory/inventory.repository.ts` — every list/
  summary query is a single batched SQL statement with CTEs; the only loops
  found are the two admin-form ones noted above.
- `apps/backend/src/common/scope/scope.service.ts` (`ScopeService`, runs once
  per request in `RlsContextGuard`, not per row) — 1-2 queries depending on
  role, `Promise.all`'d where there are two. Not free, but it's per-REQUEST
  overhead, not per-row, and is unavoidable given RLS needs `app.location_ids`
  resolved before any query runs. Worth remembering as background load when
  reading the k6 numbers: every one of the 150 concurrent requests pays this
  cost once, on top of whatever the endpoint itself does.

---

## Index findings

Migrations read: `033_surat_jalan.sql`, `034_sj_drops_lines.sql`,
`037_indexes_rls_030.sql`, `050_pos_shifts.sql`, `051_sales.sql`,
`055_indexes_rls_050.sql`, `221_w5_01_delivery_route_instructions_and_tracking.sql`.

### Finding 1: `sales` has no index usable by the day-filter the sales list actually runs

`PosSaleService.list` (`apps/backend/src/modules/pos/services/pos-sale.service.ts:357-360`)
filters a day with:

```sql
AND (s.occurred_at AT TIME ZONE 'Asia/Makassar')::date = $N::date
```

`055_indexes_rls_050.sql:21` only creates `idx_sales_occurred_at ON
sales(occurred_at DESC)` — a plain-column index. Postgres cannot use a
plain-column btree to satisfy an equality predicate wrapped in an
`AT TIME ZONE ... ::date` expression; that requires either an **expression
index** on the same expression, or rewriting the query to a `>= / <` range
over the raw `occurred_at` column (which the plain index WOULD serve). Either
fix is small; today, a location's "sales today" query — almost certainly the
single most common POS list call — falls back to a wider scan than the
existing index would suggest is covered. Motivating query: the one above,
called from the `GET /api/pos/sales?date=...` list endpoint.

### Finding 2: `surat_jalan` has single-column indexes on `status` and `planned_date` but the list query filters/sorts on both together

`SuratJalanService.list` (`apps/backend/src/modules/delivery/services/surat-jalan.service.ts:75-98`)
builds `WHERE sj.status = $$ AND sj.planned_date = $$::date` (both optional,
independently supplied) and always `ORDER BY sj.planned_date DESC, sj.created_at
DESC` (line 101). `037_indexes_rls_030.sql:23-24` gives `status` and
`planned_date` each their own single-column index. Postgres can bitmap-AND
two single-column indexes, but a composite `(status, planned_date DESC)` (or
`(planned_date DESC, status)`, depending on which predicate is more
selective in practice — worth checking against real seeded row counts before
picking the column order) would serve both the common "today's ready SJs"
filter and the default sort in one index scan, with no bitmap merge step.
Not urgent at current data volume (a few thousand SJs) but worth pairing
with the N+1 fix above, since both land in the same service.

### What's already right (checked, not a finding)

- `sj_positions` (migration 221) — `(sj_id, recorded_at DESC)` and `(driver_id,
recorded_at DESC)` composite indexes were added deliberately for exactly the
  two queries that read this table (`getTrail`, `getLiveBoard`'s `LATERAL
JOIN`), and the migration's own header explains the growth-without-bound
  reasoning. This is the pattern Finding 2 above is asking `surat_jalan` to
  copy.
- `sale_lines`/`sale_payments`/`sj_lines`/`sj_temperature_logs`/`sj_seals` —
  every parent-scoped table has an index on its FK to the parent
  (`idx_sale_lines_sale`, `idx_sj_lines_sj`, etc.), which is exactly what
  Finding 1's N+1 fix (batch `WHERE sale_id = ANY($1)`) would need to stay
  fast at scale — the missing piece there is the N+1 in the application
  code, not a missing index.
- `stock_balances`/`stock_movements`/`min_stock_rules` (block 020-029) —
  every filtered/grouped column used by `inventory.repository.ts`'s queries
  has a supporting index or is covered by a CTE over an already-indexed join.

---

## PWA Lighthouse

**Not run.** This requires a running frontend (`apps/frontend`, Next 15) and
either a headless Chrome + `lighthouse`/`lighthouse-ci` CLI or the Chrome
DevTools "Lighthouse" panel against a served build — neither is available in
this environment (no frontend container is running; see "What was NOT run"),
and starting one was out of scope per this ticket's constraints (no starting
a stack that wasn't already up).

**What to run once a frontend is up** (`apps/frontend`, `pnpm build && pnpm
start`, or the dev server):

```bash
npx lighthouse http://localhost:3000/pos --view --preset=desktop
npx lighthouse http://localhost:3000/dashboard --view --preset=desktop
# repeat per route surface (F01-F13, docs/BUILD-PLAN.md §4.3)
```

Two PWA-specific things worth checking once it runs, both already flagged
elsewhere in the repo and directly relevant to a Lighthouse PWA score:

- `docs/ACCEPTANCE.md` NFR-07's own row: **service workers cannot register
  over HTTP (B-14, no HTTPS)** — Lighthouse's installability/PWA checks will
  fail on this alone, independent of anything the frontend code does
  correctly. Not a perf regression to chase; it's the same B-14 gap the
  offline suite (F4, W6-02) already hits.
- `apps/frontend/public/sw.js`/`manifest.json` (W2-E) exist and are the right
  files to point Lighthouse's PWA audit at once B-14 is resolved or the audit
  is run against `localhost` (which Chrome treats as a secure context even
  over plain HTTP, so a **local** Lighthouse run is not blocked by B-14 the
  way a VPS one would be — worth doing locally now rather than waiting).

---

## Sync throughput at 20 outlets × 1 day backlog

Script: `perf/sync-throughput/sync-backlog-20outlets.js`. Mints a pairing
token and registers a real device per outlet (the genuine CONTRACTS §4.21
flow, not a shortcut), then pushes each outlet's simulated day of events
through `POST /sync/v1/push` in ≤200-event batches (`SyncPushBatch`'s own
documented cap) and logs events/sec per outlet.

**Read the script's own header before trusting its numbers** — the honest
summary: no written NFR covers sync throughput, and synthesizing a
schema-valid payload for every entity a real day would push (sales,
attendance, stock_opname, ...) is out of this ticket's scope, so the script
uses `attendance.checked_in`/`checked_out` (the simplest device-originatable,
schema-registered entity) as a same-order-of-magnitude volume stand-in, with
`EVENTS_PER_OUTLET` (default 40, **invented**, override via env) as the one
number in this whole suite that isn't sourced from a doc. If the owner
states a real per-outlet daily event count, replace it.

Not run, for the same reason nothing else was: no local backend was up, and
the live VPS is off-limits.

---

## Summary for the owner — what needs a number from you

1. **NFR-01's actual pass/fail**: run `perf/k6/nfr01-150-concurrent.js`
   against a real stack (local or a non-shared staging env) and record the
   p95/error-rate in `docs/ACCEPTANCE.md` §7. This is the one row this whole
   ticket exists to fill in.
2. **A real per-outlet daily sync event count**, to replace
   `EVENTS_PER_OUTLET`'s invented default of 40 in
   `sync-throughput/sync-backlog-20outlets.js`.
3. **Whether `driver-my-jobs.js`'s 5-VU assumption is right** — it assumes
   "a handful of trucks on the road at once," not 150; correct it if the
   real fleet size differs.
4. **Whether the N+1 fixes (above) are worth a ticket now or after go-live**
   — both are correctness-preserving performance fixes (no behavior change),
   sized as: Finding 1 (SJ list + my-jobs) is a service-layer rewrite in one
   file plus new batched query helpers in `queries.ts`; Finding 2 (sales
   list) is the same shape, smaller. Neither needs a schema change.
