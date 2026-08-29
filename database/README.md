# @mimi/database

Custom SQL migration runner (ported from AIRE), the full Mimi Chicken schema
(migration blocks `001`–`129`, plus `2xx` fixes), and a realistic Indonesian
seed data set. Owned exclusively by W1-C — see `docs/BUILD-PLAN.md` §6 and
`docs/CONTRACTS.md` §8.1 for the collision rules.

## Quick start

```bash
# from the repo root, with postgres reachable at $DATABASE_URL
pnpm db:migrate          # apply pending migrations
pnpm db:migrate:status   # show what's applied vs pending
pnpm db:seed             # load demo data (idempotent, safe to re-run)
pnpm db:reset            # DROP SCHEMA public + migrate + seed, in one shot (dev only)
```

Or directly inside `database/`:

```bash
DATABASE_URL=postgresql://mimi:mimi_secret@localhost:5432/mimi npx tsx migrate.ts
npx tsx migrate.ts --status
npx tsx seed.ts
npx tsx reset.ts
```

`DATABASE_URL` defaults to `postgresql://mimi:mimi_secret@localhost:5432/mimi`
(the `docker-compose.yml` defaults) when unset. If port 5432 is already taken
on your machine by an unrelated container, start Postgres with an overridden
port (`POSTGRES_PORT=55433 docker compose up -d postgres`) and point
`DATABASE_URL` at that port instead — do not change the compose defaults,
those belong to the devops (W1-A) owner.

## Rules

- **Applied migrations are never edited, and files are never renumbered.**
  If a defect is found in an already-authored migration, the fix goes in a
  new `2NN_<agent-id>_<slug>.sql` file (block `2xx`), never a change to the
  original file. Three such fixes already exist from this agent's own build
  (see `2xx` below) — treat that as the pattern, not an exception.
- Every migration file is wrapped in `BEGIN;` / `COMMIT;`.
- Every table with an `updated_at` column gets the shared `set_updated_at()`
  trigger (defined once, in `001_extensions_and_functions.sql`).
- `database/package.json` may be edited to add **scripts**, never new
  dependencies — dependency requests go to the devops owner (W1-A).

## Migration block allocation

Mirrors `docs/CONTRACTS.md` §8.1 / `docs/BUILD-PLAN.md` §4.1. Within a block,
files are grouped by table family, with one final `NNN_indexes_rls_*.sql`
file per block carrying that block's indexes, RLS policies, and any config
seed data (RBAC, chart of accounts, posting rules, approval chains, shipment
types, settings defaults) — demo _business_ data lives only in `seed.ts`.

| Block     | Contents                                                                                                                                                                                                                                                                                                                                         | Files       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| `001–009` | extensions, `set_updated_at()`, RLS helper functions, `locations`, `storage_areas`, identity/RBAC (`roles`, `permissions`, `role_permissions`, `users`, `user_locations`, `sessions`), `audit_log`, `attachments`, `notifications`(+outbox), `settings`(+doc counters), approval engine, `app_user` role + RLS + RBAC seed (137 permission keys) | `001`–`009` |
| `010–019` | item categories/units, items, unit conversions, products, recipes, suppliers (+ D-20/Amendment-3 `outlet_visible` split)                                                                                                                                                                                                                         | `010`–`014` |
| `020–029` | `stock_balances`, `stock_movements`, min-stock rules, stock opname, adjustments, reconciliations                                                                                                                                                                                                                                                 | `020`–`026` |
| `030–039` | replenishment requests, drivers/vehicles, shipment types, Surat Jalan + drops/lines/temperature/seals, goods receipts                                                                                                                                                                                                                            | `030`–`037` |
| `040–049` | purchase requests/orders, PO receipts, petty cash                                                                                                                                                                                                                                                                                                | `040`–`044` |
| `050–059` | POS shifts, sales, void/refund, online orders, **cash variance proposals (Amendment 2 / D-19)**                                                                                                                                                                                                                                                  | `050`–`055` |
| `060–069` | employees, work shifts, attendance, leave, salary components (incl. statutory codes), employee loans, payroll periods/runs/lines, **statutory payroll config (Amendment 1 / D-18): `bpjs_configs`, `pph21_ter_rates`, `pph21_ptkp`, `employee_tax_profiles`**                                                                                    | `060`–`069` |
| `070–079` | assets, maintenance schedules/jobs, service history                                                                                                                                                                                                                                                                                              | `070`–`074` |
| `080–089` | waste records, returns (both directions)                                                                                                                                                                                                                                                                                                         | `080`–`082` |
| `090–099` | chart of accounts (incl. Amendment 1 BPJS/PPh21 accounts), fiscal periods, journal, posting rules (seeded), payment verifications                                                                                                                                                                                                                | `090`–`095` |
| `100–109` | 3 materialized views: `mv_sales_daily`, `mv_item_usage_daily`, `mv_employee_kpi_daily` (`mv_delivery_recap_daily` was dropped by `261`, D-21)                                                                                                                                                                                                    | `100`       |
| `110–119` | branch nodes, devices, heartbeats, device events, pairing tokens, discovered devices                                                                                                                                                                                                                                                             | `110`–`116` |
| `120–129` | sync events/batches/cursors/conflicts, offline credentials/authorizations                                                                                                                                                                                                                                                                        | `120`–`126` |
| `2xx`     | post-authoring fixes. Per BUILD-PLAN §6 rule 3, any agent may file its own `2NN_<agent-id>_<slug>.sql` for a defect it finds — `210_w2d_*`, `211_w3_09_*`, and `212_w1c_*` (this agent's own, see below) are examples already in the tree alongside this agent's other fixes.                                                                    | `200`–`214` |

### `2xx` fixes authored during this build

| File                                                   | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `200_w1c_pph21_article17_brackets.sql`                 | Coordinator-directed addition: the December Article-17 true-up (statutory payroll, D-18) had no rate table; added with the same shape as its `pph21_ter_rates`/`pph21_ptkp` siblings, seeded with Indonesia's 2022 schedule (5/15/25/30/35%).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `201_w1c_fix_surat_jalan_rls_recursion.sql`            | **Real bug, found by role-switched testing, not by reading the policy text.** `surat_jalan`'s RLS policy queried `sj_drops` to check "any drop LOC"; `sj_drops`'s policy queried `surat_jalan` right back to check "origin LOC". Postgres raises `infinite recursion detected in policy for relation "surat_jalan"` the moment either table is queried by a non-owner role — this would have blocked every driver, warehouse, and outlet user from ever reading a Surat Jalan or its drops. Fixed with a `SECURITY DEFINER` helper (`app_sj_locations`) that resolves the relevant location set once, bypassing RLS internally, so neither table's policy needs to walk back through the other's.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `202_w1c_approval_chain_steps_document_type_check.sql` | Architect amendment: constrains `approval_chain_steps.document_type` to exactly the 12 `ApprovalDocumentType` enum values (was previously an unconstrained `VARCHAR(40)`, which is how `'waste'` briefly went unconstrained in an earlier version of the contract).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `203_w1c_app_login_role.sql`                           | **SECURITY-CRITICAL — D-22.** Creates the `mimi_app` runtime LOGIN role. See "RLS: the two-identity model" below — this is the actual fix for RLS having been bypassed entirely in the running app.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `204_w1c_stock_movements_natural_key.sql`              | Requested by W2-A: a composite `UNIQUE` index on `stock_movements(ref_type, ref_id, item_id, storage_area_id, movement_type)`, letting Postgres enforce the same natural-key idempotency guarantee W2-A's application code already serializes with an advisory lock (the single-column `sync_event_id UNIQUE` can't do this — one synced fact routinely produces several movement rows, e.g. one sale's several recipe ingredients, and only the first could ever satisfy a single-column unique constraint on the shared event id).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `205_w1c_mimi_app_noinherit.sql`                       | **Found by W1-A, confirmed by the coordinator.** `203`'s header claimed the `app_user` membership was `NOINHERIT` by design, but the migration never set it — `GRANT app_user TO mimi_app;` with no `WITH INHERIT` clause defaults to the grantee's `rolinherit` at grant time, and `mimi_app` was plain `CREATE ROLE ... LOGIN` (defaults to `INHERIT`). Not an active data leak — RLS + `FORCE` still applied, so a bare `mimi_app` connection with no `SET ROLE` returned 0 rows, not real data — but the wrong _failure mode_: a forgotten `SET LOCAL ROLE app_user` read as "no data" instead of "you are holding this wrong". Fixed with both `ALTER ROLE mimi_app NOINHERIT` (the role's default for any future grants) and `GRANT app_user TO mimi_app WITH INHERIT FALSE` (PG16 re-grants an existing membership in place, which is the only way to flip an _already-recorded_ `pg_auth_members.inherit_option` — `ALTER ROLE` alone does not retroactively touch it).                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `206_w1c_offline_credential_verification_lookup.sql`   | **Genuine blocker found live by W2-D.** `offline_credentials`' RLS is SELF-only with no central-role bypass, but SYNC-PROTOCOL §7.4 re-verification is a cross-user SYSTEM read (the cloud must look up the credential minted for the _approver_, not whoever's session is processing the sync batch) — without a fix, D-17's entire offline-authorization mechanism could not work over the `mimi_app`/`app_user` connection. Fixed with a `SECURITY DEFINER` function, **not** an `app_is_central()` policy arm — see "Offline credential re-verification (D-17 / SYNC-PROTOCOL §7.4)" below for the reasoning and exactly what is now readable by whom.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `207_w1c_fix_empty_string_uuid_cast.sql`               | **P0 found by W3-01, reproduced by the coordinator.** `SET LOCAL app.user_id = ...` reverts to `''` (not `NULL`) once its transaction ends, so a POOLED connection reused for a later request had `current_setting('app.user_id', true)` return `''`. `app_is_self()`'s guard was `... IS NOT NULL AND owner_user_id = current_setting(...)::uuid` — `'' IS NOT NULL` is true, so it proceeded to `''::uuid`, raising `invalid input syntax for type uuid` instead of evaluating to false. Every policy calling `app_is_self()`, plus five hand-written driver-assignment clauses using the identical unguarded pattern (`surat_jalan`, `sj_drops`, `sj_temperature_logs`, `sj_seals`, `sj_lines`), was exposed. Fixed by applying `NULLIF(current_setting(...), '')` before every `::uuid` cast — the same idiom `app_has_location()` already used for `app.location_ids`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `208_w1c_app_is_self_strict_boolean.sql`               | Self-caught refinement of 207 before reporting it: the NULLIF fix made `app_is_self()` return SQL `NULL` (not a strict `false`) when the GUC is absent — harmless inside an RLS `USING` clause, but not literally "false", and `NOT NULL` is `NULL` not `TRUE` for any future caller composing this function with negation. Wrapped in `COALESCE(..., false)` for a guaranteed strict boolean.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `209_w1c_kepala_gudang_fulfilment_visibility.sql`      | RLS gap found by W3-06: `kepala_gudang` (the FR-LOG-10 chain's step-2 approver/fulfiller) couldn't see or act on any outlet-authored `replenishment_requests` row, since those rows are scoped by the _requesting outlet's_ location and `kepala_gudang` isn't central. Added a new `app_is_fulfilment_role()` helper (currently just `kepala_gudang`) rather than folding it into `app_is_central()`, which would have also handed it payroll/other-outlet-sales visibility it has no business reading. Also fixed the identical bug class in `returns` (outlet→gudang direction) — but generally, via `app_has_location(from_location_id) OR app_has_location(to_location_id)`, not the role helper, since `to_location_id` already _is_ the warehouse for that leg. Audited (and found NOT broken, documented in the migration) `goods_receipts`, `waste_records`, and `stock_opname` — all three are correctly single-location-scoped, matching `supervisor`/`leader_outlet`'s identical scoping for the same permission keys. Also hardened `app_is_central()`/`app_has_location()` to the same `COALESCE(..., false)` strict-boolean treatment as 208, found while touching this function family.                                                                                                                                                                                                                                                |
| `212_w1c_user_display_lookup.sql`                      | Confirmed live bug: `users_select` (009) is `ROLE(owner,manager,hr_admin,finance) OR SELF`, so any non-central role joining `users` to resolve another user's display name (kernel/approvals' pending-approvals inbox, replenishment's `requestedBy`, POS actor names) silently lost every row that wasn't the caller's own — the entire approval inbox read empty for Supervisor/Kepala Gudang approvers system-wide. Fixed with `app_user_display(uuid[])`, a `SECURITY DEFINER` function returning only `id, name, role_key` for any requested ids — never email/phone/password_hash/pin_hash/last_login_at, and the base table's RLS is unchanged. Same technique as 201/206.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `213_w1c_fix_sj_returning_rls_violation.sql`           | Subtle bug reproduced by W3-07: `INSERT ... RETURNING` on `surat_jalan`/`sj_drops` raised "new row violates row-level security policy" even though every predicate was independently true. Cause: for `RETURNING`, Postgres re-checks the row against the table's SELECT-side `USING` policy, and that policy resolved entirely through `app_sj_locations()` (201) — a `SECURITY DEFINER` function whose _own_ internal query cannot see a row inserted earlier in the same command. Fixed by giving each `USING` clause a first arm that reads the row's own location column directly (a correlated reference, not a separate query, so it has no snapshot blind spot), keeping `app_sj_locations()` only for the genuinely cross-table case — which is never blind, because the _other_ table's row it needs is always pre-existing by the time it's checked (a drop cannot be inserted before its SJ header exists).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `214_w1c_fix_sj_drops_with_check_regression.sql`       | Self-caught regression in 213, found while verifying it live rather than trusting the diff: 213's rewrite of `sj_drops_scope` accidentally dropped the "parent SJ's origin location" arm from `WITH CHECK` (present in the original 037), so a `kepala_gudang` populating drops at OUTLET locations they have no direct grant for — the entire point of building a multi-drop Surat Jalan — failed on a plain `INSERT`, with or without `RETURNING`. Restored the missing arm via a direct subquery into `surat_jalan` (safe: `surat_jalan_scope` no longer queries `sj_drops` under live RLS, only through the bypassing function, so this direction cannot reopen the 201 recursion).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `215_w1c_document_number_allocator.sql`                | Bug found by W3-07 (cost a full session, since it was first fixed data-only and so recurred on every `db:reset`): `seed.ts` hardcoded document numbers (`'SJ/202608/0001'`, etc.) without ever writing the matching `document_counters` row, so the first real allocation collided with the seed row. Added `allocate_document_number(doc_type, period)` — the one mechanism that may ever produce a document number — and rewired every hardcoded number in `seed.ts` (`SJ`, `PO`, `PC`, `WST`, `PRUN`, `RR`) to call it, each gated behind a proper natural-key idempotency check (`client_id`, `notes` marker, or `(period_id, run_seq)`) so re-seeding never burns a number it won't use.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `216_w1c_fix_surat_jalan_with_check_asymmetry.sql`     | **PRODUCTION-BLOCKING, found by the cross-kernel test.** `surat_jalan_scope`'s `USING` had three arms (origin LOC, any-destination LOC, driver) but `WITH CHECK` only ever had two — the destination-outlet arm was missing, so an outlet-scoped caller could **read** a Surat Jalan bound for them but never **write** to it. `drop.service.ts` sets `surat_jalan.status='completed'` when the last drop is received — a real `leader_outlet` completing an ordinary single-drop delivery hit `new row violates row-level security policy`, breaking the primary receiving flow for most deliveries. Fixed by adding the missing arm to `WITH CHECK`, identical to `USING`'s. Swept every policy in the schema for the same asymmetry (`pg_get_expr(polqual)` vs `pg_get_expr(polwithcheck)`); the only other asymmetries found are either identical-clause tables with no diff (`returns`, `replenishment_requests`, `goods_receipts` — nothing to fix) or intentional narrower-write-than-read role restrictions matching RBAC exactly (`employees`, `payroll_*`, `chart_of_accounts`, `posting_rules`, …) or the opposite, over-permissive shape on `sj_lines`/`sj_temperature_logs`/`sj_seals` (`WITH CHECK (true)`, documented, out of scope here since it never causes this failure).                                                                                                                                                           |
| `217_w1c_approvals_current_step_nullable.sql`          | Requested by kernel/approvals (W2-B): `approvals.current_step` (008) was `INTEGER NOT NULL DEFAULT 1`, but the approvals contract uses `current_step IS NULL` as the "chain is finalized" signal — the NOT NULL constraint made that impossible. Dropped `NOT NULL`; metadata-only change, no rewrite, no other column touched. Originally numbered 216; renumbered to 217 after a three-way collision was found on that number (216/217/218 were three independently-authored fixes that all landed on 216 in the same session) — 216 itself stayed with the `surat_jalan` fix above, since other agents already reference it by that number.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `218_w4_03_accounting_fiscal_periods_seed.sql`         | Requested by the accounting module owner (W4-03): `fiscal_periods` (091) seeded empty, unlike its siblings `chart_of_accounts`/`posting_rules` (090/093, both seeded by this agent) — not required for `JournalService` to function (it auto-opens periods on demand), but needed so G1 demo data and `GET /api/accounting/periods` aren't staring at an empty list on a fresh database. Seeds the trailing 3 months through the current demo month as `'open'` only — never `'closed'`/`'locked'`, since those states must only ever be reached by an explicit close decision, never implied by seed data. Also originally 216; renumbered alongside 217.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `219_w1c_matview_refresh_function.sql`                 | **Production blocker found live while building the dashboard.** All four materialized views (100) are owned by the migration/admin role, and `REFRESH MATERIALIZED VIEW` requires ownership (or superuser) — `app_user` got `must be owner of materialized view mv_sales_daily`. `MatviewRefreshService`'s 5-minute auto-refresh and its manual `POST /refresh` both catch the error per view and log rather than crash, so both paths were silently no-op-ing: every dashboard tile (revenue, top products, staff KPI, delivery recap) would freeze at whatever a migration last built, with nothing surfaced to anyone — the same failure shape as D-22. Fixed with `refresh_dashboard_matview(view_name)`, a `SECURITY DEFINER` function (not an ownership change, for the same DDL-off-the-runtime-role reason as 201/206/212) that validates the name against a fixed allow-list before running `REFRESH MATERIALIZED VIEW CONCURRENTLY` dynamically — one function so the caller's existing per-view loop and per-view error handling keep working unchanged. Confirmed `CONCURRENTLY` works when called this way, including from inside an explicit transaction (the pattern every request actually uses). Confirmed the ownership bug is a deterministic property of the schema, not an artifact of one database: reproduces on every fresh `db:reset`, since matviews are always created by whichever role runs migrations, never `app_user`. |

## RLS: the two-identity model (D-06 / D-21 / D-22)

**Two Postgres roles are involved, never one:**

| Role                                            | Kind                     | Used by                                                          | `rolsuper` / `rolbypassrls` | Purpose                                                                                                                                                |
| ----------------------------------------------- | ------------------------ | ---------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| the DB's admin/owner role (`mimi` in local dev) | LOGIN, superuser         | `migrate.ts`, `seed.ts`, `reset.ts` via `DATABASE_MIGRATION_URL` | true / true                 | owns every table; the only identity allowed to run DDL                                                                                                 |
| `mimi_app`                                      | LOGIN, **not** superuser | the backend, via `DATABASE_URL`                                  | **false / false**           | authenticates the runtime connection; holds **no direct table grants**                                                                                 |
| `app_user`                                      | **NOLOGIN**              | assumed via `SET LOCAL ROLE app_user` after `mimi_app` connects  | false / false               | the **only** role with table privileges (`GRANT SELECT/INSERT/UPDATE/DELETE ... TO app_user`, migration `009`); every RLS policy is written against it |

This is deliberately two roles, not one, and the naming of the two env vars
encodes _why_: **`DATABASE_MIGRATION_URL`** (owner) vs. **`DATABASE_URL`**
(runtime, `mimi_app`). Forgetting to set `DATABASE_MIGRATION_URL` fails
loudly — migrations simply cannot run without owner rights. Forgetting a
runtime var, by contrast, would have silently left the backend authenticating
as a role with DDL rights and no RLS enforcement — which is exactly the
incident this section exists to document (see D-22, `docs/BUILD-PLAN.md` §1.3):

> W2-A found, and the coordinator reproduced, that `DATABASE_URL` was
> pointed at `mimi` — a **superuser with `BYPASSRLS`** — so every
> `FORCE ROW LEVEL SECURITY` policy in this schema was silently doing
> nothing; Postgres exempts superusers from RLS unconditionally, `FORCE`
> or not. A Kasir session saw all 418 `sales` rows instead of 64, and all
> 324 `supplier_price_history` rows instead of 0. **`app_user` and its
> policies were correct the whole time** — the gap was that nothing ever
> switched to it. Fixed in `203_w1c_app_login_role.sql`: a dedicated
> non-superuser `LOGIN` role (`mimi_app`) for the runtime connection,
> granted membership in `app_user` and nothing else — no schema/table
> grants of its own, so a connection that ever forgets `SET LOCAL ROLE
app_user` can authenticate but cannot read or write a single application
> table. W1-D's request guard now issues that `SET LOCAL ROLE` as phase 0,
> before any session variable.

Practical detail for anyone wiring a connection string: `mimi_app`'s
dev-default password is `mimi_app_secret` (set directly in `203_w1c_app_login_role.sql`,
following this repo's existing `${POSTGRES_PASSWORD:-mimi_secret}`-style
convention); the suggested env var is `MIMI_APP_PASSWORD`. Rotate it in any
real deployment with `ALTER ROLE mimi_app WITH PASSWORD '<new-secret>';` run
directly against the database — not via a further migration, since
migrations are checked-in and should never carry a live, rotating secret.

**`mimi_app`'s membership in `app_user` is `NOINHERIT`** (fixed in
`205_w1c_mimi_app_noinherit.sql`, after W1-A found `203`'s header claimed
this but the migration never actually set it). This was never an active
data leak — `FORCE ROW LEVEL SECURITY` still applied, so a bare `mimi_app`
connection with no `SET ROLE` returned 0 rows, not real data — but it was
the wrong _failure mode_: a forgotten `SET LOCAL ROLE app_user` read as
"no data" instead of "you are holding this wrong." With `NOINHERIT`, the
identical mistake is now a hard `permission denied for table ...` at the
first query — verified directly: `pg_auth_members.inherit_option = false`
for the `app_user`→`mimi_app` grant, a bare `mimi_app` query against
`users` with no `SET ROLE` raises `permission denied for table users`, and
the normal path (`SET LOCAL ROLE app_user` + Kasir session vars) still
returns exactly 64 `sales`.

Everything below was true before D-22 and remains true — the fix only
changed _which role connects_, not the policies themselves:

- Every RLS-enabled table has **`FORCE ROW LEVEL SECURITY`** set (verified:
  zero tables have `relrowsecurity` true and `relforcerowsecurity` false),
  so even an owner-privileged connection would still get policies enforced
  — belt-and-braces on top of the `mimi_app`/`app_user` split, not a
  substitute for it. `FORCE` alone did **not** prevent the D-22 incident,
  because superusers bypass RLS regardless of `FORCE` — the fix had to be
  "stop connecting as a superuser," not "add more RLS."
- Session variables (set by `RlsContextGuard` after `SET LOCAL ROLE
app_user`, read by every policy via `current_setting(..., true)`):
  `app.user_id`, `app.role`, `app.location_ids` (CSV of granted location
  UUIDs).
- **Two-phase bootstrap**: `app.user_id`/`app.role` come straight off the
  verified JWT (no DB read needed) and are set first; `app.location_ids` is
  then resolved by a second lookup that itself runs _under_ RLS, as
  `app_user`. That lookup needs `user_locations`, `drivers`, and
  `surat_jalan`/`sj_drops` to be self-readable before `app.location_ids`
  exists — narrow self-scoped read policies exist on all of these
  specifically for that reason (see `009_rls_core_and_rbac_seed.sql` for
  `user_locations`, `037_indexes_rls_030.sql` for `drivers`, and
  `037_indexes_rls_030.sql` / `201_w1c_fix_surat_jalan_rls_recursion.sql`
  for `surat_jalan`/`sj_drops`'s driver-assigned clause).
- `audit_log` is append-only: `INSERT` is open to any authenticated session,
  `SELECT` is role-gated, and `UPDATE`/`DELETE` privileges are explicitly
  revoked from `app_user` (no policy can accidentally re-open them).
- **Verified against the real connection path**, not a hand-built
  approximation of it (that distinction is the whole lesson of D-22): connect
  as `mimi_app` with its own password over a real TCP connection, issue
  `SET LOCAL ROLE app_user` exactly as the request guard will, then set a
  Kasir's session vars. Confirmed `current_user` flips from `mimi_app` to
  `app_user` while `session_user` stays `mimi_app`; confirmed `sales` = 64
  (not 418) and `supplier_price_history` = 0 (not 324) — the exact numbers
  the bug produced, inverted. Plus the original 10-scenario transcript
  (central-role visibility, outlet scoping, driver bootstrap before
  `app.location_ids` exists, self-only payroll/employee reads, the D-20
  supplier column/row split, and `audit_log` immutability) — see this
  agent's final report for both transcripts in full.

## Offline credential re-verification (D-17 / SYNC-PROTOCOL §7.4)

`offline_credentials` is `SELF`-only (CONTRACTS.md §1.14) with no
central-role bypass — by itself that would make SYNC-PROTOCOL §7.4's
re-verification impossible: when the cloud re-verifies an offline-authorized
approval, it must look up the credential minted for _the approver_, not
whoever's session happens to be processing the sync batch. That's a
cross-user system read no ordinary RLS row policy grants.

**Fixed with a `SECURITY DEFINER` function, not an `app_is_central()` policy
arm** — the same technique already used for `surat_jalan`/`sj_drops` (`201`),
chosen deliberately over the simpler policy change:

- `offline_credentials` holds `pin_verifier` (an argon2id hash of a 6-digit
  PIN — only 1,000,000 possible values) and `binding_secret_enc` (the
  per-issuance HMAC key, encrypted at rest). SYNC-PROTOCOL §7.1's threat
  model assumes an adversary who controls a device; minimising which
  server-side contexts can even _read_ this material is the same "assume
  breach" posture, applied to the database layer.
- Re-verification (§7.4 checks 1–8) never needs `pin_verifier` at all — PIN
  verification happens locally on the device against the cached credential;
  the cloud never re-derives or re-checks a PIN at apply time. Widening the
  whole table to every central role would hand owner/manager/finance/hr_admin
  sessions blanket read access to every PIN verifier and binding secret in
  the database for a capability that only ever touches 13 of the table's 14
  columns, one row at a time.

**What is readable by whom, stated plainly:**

- The base table's RLS is **unchanged** — still `SELF`-only, no
  `app_is_central()` arm. A central role querying `offline_credentials`
  directly still sees only its own rows (verified live: `owner` reading a
  supervisor's credential by id returns 0 rows, same as any other role).
- `app_offline_credential_for_verification(credential_id)` is
  `SECURITY DEFINER` and returns a **narrower** row — every column §7.4
  actually checks (`credential_id`, `user_id`, `device_id`, `role_key`,
  `location_ids`, `scopes`, `binding_secret_enc`, `selfie_required_above`,
  `volume_cap`, `use_count`, `minted_at`, `expires_at`, `revoked_at`) for any
  credential id, regardless of the caller's `app.role`/`app.user_id`. It
  **excludes `pin_verifier` entirely** — no caller can reach a PIN verifier
  belonging to someone else through this function; the base table's `SELF`
  policy remains the only path to that column, for everyone, central roles
  included.
- `EXECUTE` is granted only to `app_user` (the sole runtime role) — the same
  boundary as everything else in this schema. The function isn't gated to a
  specific permission key because the re-verification service isn't acting
  as any one human role; it's acting as the system, which is exactly the
  case this function exists for.

Verified live: (1) `spv_bpp01` reading their own credential via the base
table — 1 row; (2) a different non-central role (`kasir`) reading the same
credential via the base table — 0 rows; (3) a central role (`owner`) reading
someone else's credential via the base table — 0 rows, confirming no table-
level widening; (4) the new function, called from a `kasir` session (standing
in for the sync path, which isn't any one human role) — returns the full
13-column row correctly; (5) `EXECUTE` on the function is granted to
`app_user` and not to `PUBLIC`.

## Running tests in parallel: per-agent databases (D-01)

Every integration suite talks to one database. That is fine for one developer
and actively misleading for several agents working at once: the suites share
seeded rows and a good number of them mutate shared state — closing shifts,
adjusting balances, flipping settings. When two runs overlap, tests fail in
files neither run touched, and those failures read as real regressions in
whatever the reader happens to be working on. Establishing otherwise once cost
a full stash/restore bisect over 19 failures that turned out to belong to
someone else's session.

```bash
pnpm db:test:template            # once, and after new migrations (~1 min)
pnpm db:test:clone my-agent      # ~3s, prints the four env vars to export
pnpm db:test:list                # what exists
pnpm db:test:drop my-agent       # tear down
```

**Databases, not schemas** (the debt register proposed schemas). RLS policies,
roles and the `SECURITY DEFINER` helpers are all written unqualified, so
per-schema isolation would mean every connection setting `search_path`
correctly, forever, across ~15 test-support files — and one missed call
silently reads the shared schema, which is the exact failure being fixed.
`CREATE DATABASE ... TEMPLATE` is also a file copy: about **3 seconds** per
agent, against minutes to replay every migration and the seed.

**No test code changes.** Every connection already resolves through
`POSTGRES_DB` / `DATABASE_URL` / `TEST_DATABASE_URL` /
`DATABASE_MIGRATION_URL`, so isolation is environment rather than code. Export
**all four** — the suites are not consistent about which they read, and one
missed variable points that connection back at the shared database, which is
worse than not isolating at all because it still looks isolated.

**Why the separate template.** `CREATE DATABASE ... TEMPLATE x` fails while
anything is connected to `x`, and a dev box normally has the app holding a pool
open against the working database. `mimi_test_template` exists so that nothing
but `db:test:template` ever connects to it.

Verified end to end: the full 672-test `integration-live-db` suite passes
against a clone, and the shared database's row counts are unchanged by that run.

## Known deviations from `docs/CONTRACTS.md` §1 (and why)

- **`sync_events` is not monthly-partitioned.** The contract's comment says
  "monthly partitions, kept forever"; the DDL sketch itself is a plain
  table. Implemented as a plain table — correct and fully functional at
  current volumes (3.2k rows / 3.8 MB as of 2026-08-29).

  **This note used to call the conversion "a straightforward `2xx` migration
  (create partitioned parent, attach existing data as the first partition)".
  That is wrong, and the correction matters more than the deferral.** Postgres
  requires every UNIQUE constraint on a partitioned table to include the
  partition key. Partitioning by time therefore breaks `sync_events_pkey` on
  `event_id` alone — and `event_id` is not an incidental surrogate, it is
  SYNC-PROTOCOL §2.1's client-minted UUIDv7 idempotency key, the thing the
  whole replay story rests on. Four foreign keys reference it
  (`sync_conflicts` × 3, `offline_authorizations` × 1), and
  `SyncEventsRepository.insertEvent` depends on `ON CONFLICT (event_id)`.

  **Verified against the live database on 2026-08-29** (rather than reasoned
  about), because the first two workarounds anyone reaches for both fail:

  - `CREATE TABLE ... (m date GENERATED ALWAYS AS (...) STORED) PARTITION BY
RANGE (m)` → **"cannot use generated column in partition key"**. A derived
    month column is a flat prohibition, not an immutability problem — it fails
    even for a trivially immutable expression.
  - A child table holding only `event_id` cannot reference a composite
    `(event_id, <partition key>)` unique constraint → **"there is no unique
    constraint matching given keys"**. So all four FKs must change or go.
  - `UNIQUE (event_id)` alone on a partitioned table → **"unique constraint on
    partitioned table must include all partitioning columns"**. This is the
    one that matters: `event_id` stops being globally unique _at the database
    level_, and it is the sync protocol's idempotency key.

  **There is also no good partition key.** `sync_events` has no `created_at`.
  The candidates are `occurred_at` — the ORIGIN's wall clock, which migration
  120 itself marks "ADVISORY only" and which an offline or hostile device
  controls — and `relay_received_at`, which is nullable. `server_seq` is
  assigned at insert, so it is not deterministic on a retry, and monthly ranges
  are not expressible in sequence space.

  That last point is what breaks `ON CONFLICT (event_id)`. With a composite
  key the guard becomes `ON CONFLICT (event_id, <partition key>)`, which is
  only safe if the partition key is **deterministic from the event**. If it is
  `now()`-derived, a retried push lands in a different partition, does not
  conflict, and inserts a DUPLICATE — silently destroying the replay
  convergence the whole protocol rests on.

  **A design that does preserve every guarantee**, if partitioning is wanted:
  keep an unpartitioned `sync_event_ids (event_id uuid PRIMARY KEY)` written in
  the same transaction. It restores global uniqueness, gives the four FKs a
  target that does not move, and makes `ON CONFLICT` exact again — at the cost
  of one extra tiny row per event. The bulk table can then be partitioned by a
  server-side `created_at` freely, because it no longer carries the uniqueness
  burden. Monthly partitions would also need something to create them ahead of
  time, or a DEFAULT partition so an insert never fails on a missing range.

  So the real choice is an architecture decision, not a migration:

  1. **Range-partition by time and make every unique key composite.** Gets the
     actual benefit — pruning and cheap retention — at the cost of changing
     four FKs and the `ON CONFLICT` idempotency guard. That guard is load-
     bearing; touching it needs care.
  2. **Hash-partition on `event_id`.** Keeps every constraint valid with no
     application change, but buys only write distribution: it cannot prune by
     time and cannot drop an old partition, which is most of why one
     partitions an append-only log.
  3. **Do not partition; add retention/archival instead.** "Kept forever"
     makes this the weakest option, but it should be rejected deliberately
     rather than by omission.

  Still flagged for before go-live traffic. See the D-07 issue for the
  decision.

- **`mv_employee_kpi_daily`'s SELECT body** is this agent's own design — the
  contract explicitly leaves the exact query bodies to W1-C ("grains and column
  names... are contract"). Grain: `(employee_id, kpi_date)`. See
  `100_reporting_matviews.sql` for the reasoning.
- **`mv_delivery_recap_daily` was dropped by migration `261`** (D-21). Its
  grain `(planned_date, city, shipment_type, item_id)` mixed per-item
  quantities with per-day counts, so its `sj_count`/`drop_count` were correct
  within a row and over-counted the moment anyone summed across items. Both
  would-be consumers had independently written themselves notes to avoid it,
  leaving a view that was refreshed every five minutes and never read.
  FR-LOG-04 is served by `RecapService.dailyRecap()` off the base tables. If a
  future workload wants the precomputation back, add TWO views at their own
  grains rather than one at both.
- **`posting_rules` seed data for multi-leg events** (`payroll_accrual`,
  `outlet_sales`, `sale_void_reversal`) is a best-effort declarative
  approximation. The contract describes these in prose as needing more than
  one Dr/Cr pair to balance a single business event; the schema supports
  that (multiple `rule_seq` rows per `event_type`), but combining them into
  one balanced `journal_entry` is the posting engine's (M17/W4-03)
  responsibility — treat the seeded rows as a verified starting point, not
  a finished spec. See the header comment in `093_posting_rules.sql`.
- **Three approval chains have a role selection the schema literally cannot
  encode**: `stock_opname` and `return` pick their step-1 approver by
  _location type_ (supervisor at an outlet, kepala_gudang at the warehouse),
  and `return` additionally varies by _direction_; `waste` has the same
  location-type split; `leave_request` is approvable by any of
  SPV/HRA/MGR interchangeably. `approval_chain_steps` is `(document_type,
step_no) → one role`, so each was seeded with its most representative
  role (outlet-side for opname/return/waste, supervisor for leave) — the
  kernel approvals engine (W2-B) needs runtime branching for the other
  cases. Documented in `069_indexes_rls_060.sql`'s header comment.
- **`packages/shared`-facing enum gaps this agent noticed but cannot fix**
  (no CONTRACTS.md or `packages/*` write access): `posting_rules` seeds two
  event types (`petty_cash_topup`, `employee_loan_disbursement`) that
  CONTRACTS.md §6.3 describes only in prose, not in the `JournalEventType`/
  `JournalSystemEventType` enums — flagged for whoever owns those enums to
  add matching members.
- **`@mimi/shared`'s COA/posting-rules data and money helpers were not used
  in `seed.ts`.** `database/package.json` may only gain scripts, not
  dependencies, so adding a workspace dependency on `@mimi/shared` was out
  of scope for this agent; the seed is plain parameterized SQL via `pg`
  instead, per the coordinator's explicit "a plain SQL seed is perfectly
  acceptable" allowance.

## Seed data (`seed.ts`)

Idempotent — every insert upserts on a natural key (or a `stableUuid()`
helper for UUID-typed idempotency keys like `client_id`), so `pnpm db:seed`
can be run against an already-seeded database without erroring or growing
without bound. What it loads:

- 1 gudang pusat (Balikpapan) + 20 outlets across 4 Kalimantan cities
  (Balikpapan, Samarinda, Banjarmasin, Pontianak), each with typed storage
  areas.
- 97 login users across all 9 roles + 33 additional staff-only employees
  (130 employees total). Demo login: any seeded username (e.g. `owner`,
  `manager1`, `spv_bpp01`, `driver1`) / password `password123`; PIN `123456`
  for roles that hold one (owner, manager, kepala_gudang, supervisor).
- ~90 items across 6 categories, ~40 menu products with recipes/BOM.
- 15 suppliers with items and price history (5 flagged `outlet_visible` per
  D-20).
- 8 drivers, 10 vehicles, ~30 devices in mixed online/stale/offline/unpaired
  states.
- Opening stock balances + movements for the core item set across every
  location, POS shifts and sales for the last 7 days at 6 outlets, a
  replenishment request in each of its 9 states, one in-flight Surat Jalan
  with 3 drops (completed / arrived / en_route) plus its temperature log and
  seal, 90 attendance rows, a cash-variance proposal, a calculated payroll
  run covering all 130 employees, and a sample PO/petty-cash/waste record
  for report screens to have something real to render.

## Verification performed

Real `pnpm db:migrate` / `pnpm db:seed` / `pnpm db:reset` runs against the
`docker-compose.yml` Postgres (see this agent's final report for full
transcripts), plus role-switched RLS verification (`SET ROLE app_user` +
session variables) covering central-role visibility, outlet location
scoping, the driver two-phase bootstrap, self-only payroll/employee reads,
the D-20 supplier split, and `audit_log` immutability.
