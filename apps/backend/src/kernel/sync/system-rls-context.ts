/**
 * System-level RLS context for kernel/sync's cross-tenant queries (D-21/D-22).
 *
 * BACKGROUND: `DATABASE_POOL` now connects as `mimi_app` — a non-superuser,
 * non-`BYPASSRLS` login role (D-22 fixed the incident where a superuser
 * connection made every `FORCE ROW LEVEL SECURITY` policy inert). For a
 * normal user request, `RlsContextGuard` sets `app.user_id`/`app.role`/
 * `app.location_ids` from the verified JWT before any query runs.
 *
 * `kernel/sync`'s device-token routes (`/sync/v1/*`) are `@Public()` —
 * there is no user JWT, so `RlsContextGuard` never runs for them, and no
 * `app.*` session var is ever set. Several tables this engine legitimately
 * needs to read/write ACROSS every location — `devices` (§1.3 device-token
 * auth needs to find ANY device by its token hash, not one caller's own),
 * `stock_balances`/`stock_movements`/`stock_reconciliations` (R1/R2/R9's
 * reconciliation sweeps run system-wide), `cash_variance_proposals` (R7
 * creates one after ANY shift's close) — are `LOC`-scoped RLS tables
 * (CONTRACTS.md §1.14). Their policies read `app_has_location()`, which
 * bypasses to unrestricted for `app_is_central()` roles
 * (`current_setting('app.role') IN ('owner','manager','finance','hr_admin')`)
 * — exactly the same bypass a real Owner/Manager gets. Asserting
 * `app.role = 'owner'` here is that same legitimate central-role bypass,
 * not a new hole: it grants this system component precisely what an Owner
 * already has, scoped to ONE transaction (`is_local => true`, and `SET
 * LOCAL ROLE` reverts at COMMIT/ROLLBACK), never touching another
 * connection's or request's session state.
 *
 * KNOWN GAP — do not paper over it: `offline_credentials`' RLS policy is
 * `SELF`-only (`app_is_self(user_id)`, no central-role bypass at all — see
 * CONTRACTS.md §1.14: `sessions, offline_credentials | yes | SELF`). This
 * helper CANNOT unlock it (setting `app.role='owner'` does nothing for a
 * `SELF`-only predicate, and `app.user_id` can't be pre-set to "whoever
 * turns out to own this row" before the row is found — that's the whole
 * point of the lookup). `OfflineCredentialsRepository`'s §7.4 credential
 * lookup is consequently BLOCKED under the current policy for this
 * system-level flow. This is flagged in the W2-D report as a decision for
 * senior-db/the architect (add an `app_is_central()` arm to that one
 * policy, or a `SECURITY DEFINER` lookup function) — NOT something this
 * file works around, per the explicit instruction not to weaken any policy.
 *
 * FIXED (live-DB-verified defect, reported independently by M01/auth and
 * W3-07/delivery): `set_config('app.user_id', v, true)` ("local to
 * transaction") does NOT revert the GUC to a true NULL/unset state on a
 * POOLED connection that has EVER had `app.user_id` set before (every real
 * deployment — `RlsContextGuard` sets it on every authenticated request,
 * and the SAME physical connection is later handed to a device-token route
 * that opens a transaction here) — it reverts to an EMPTY STRING instead,
 * on both COMMIT and ROLLBACK:
 *
 *   BEGIN; SELECT set_config('app.user_id', 'aaaa...', true); COMMIT;
 *   SELECT current_setting('app.user_id', true);   -- '' (NOT NULL)
 *
 * The ORIGINAL version of this function reasoned that leaving `app.user_id`
 * untouched lets `app_is_self()` "correctly evaluate false via its own `IS
 * NOT NULL` guard" — true only on a connection that has NEVER set it, which
 * a pooled connection cannot promise. `app_is_self()` (migration 001) guards
 * only `IS NOT NULL` (true for `''`), so `owner_user_id = ''::uuid` THROWS
 * `invalid input syntax for type uuid` rather than safely evaluating false
 * — and Postgres does not short-circuit an `OR`'s second operand, so ANY
 * policy combining a central-role check with `app_is_self` (e.g. `users`'
 * own SELECT policy) can crash mid-query even though `app.role='owner'`
 * alone would have been sufficient.
 *
 * THE FIX (here): explicitly set `app.user_id` to a syntactically-valid,
 * semantically-inert sentinel UUID (the all-zero UUID — `gen_random_uuid()`
 * never produces it, and no seeded/real row uses it) so every comparison
 * against it is a normal, safe boolean check that can never accidentally
 * match a real user. THE PROPER FIX (not this file's to make — flagged to
 * senior-db): `app_is_self()` should guard `NULLIF(current_setting(
 * 'app.user_id', true), '') IS NOT NULL`, matching `app_has_location()`'s
 * OWN `NULLIF(..., '')` guard on `app.location_ids` two lines away in the
 * same migration — `app_is_self` is the one of the three RLS helper
 * functions missing it. Once that lands, this sentinel becomes redundant
 * but harmless; do not remove it preemptively.
 */
import type { Pool, PoolClient } from 'pg';
import {
  SYSTEM_CENTRAL_ROLE,
  SYSTEM_SENTINEL_USER_ID,
  assertSystemContext as assertCanonicalSystemContext,
  withSystemContext as withCanonicalSystemContext,
} from '../../common/database/system-context';
import type { DbClient } from './sync-events.repository';

/**
 * Never a real row's id (`gen_random_uuid()` cannot produce it) — see the
 * FIXED note above.
 *
 * D-02 (2026-08-28): re-exported from `common/database/system-context.ts`
 * rather than re-declared. The two constants were already the same UUID under
 * different names, which is precisely the shape a duplication drifts out of.
 */
export const INERT_SENTINEL_USER_ID = SYSTEM_SENTINEL_USER_ID;

/**
 * Asserts the central-role bypass on the CURRENT transaction only. Must run
 * after `BEGIN` and before any RLS-guarded query in that same transaction.
 * Safe to call even if the connection is (in some environment) still a
 * superuser — `SET LOCAL ROLE app_user` only ever narrows privilege, never
 * widens it, matching `RlsContextGuard`'s own defensive pattern.
 *
 * D-02: delegates to the canonical implementation. The GUCs set are identical
 * to what this function set itself — role `owner`, empty `app.location_ids`,
 * the sentinel `app.user_id` — so the sentinel reasoning documented above is
 * preserved rather than dropped.
 */
export async function assertSystemContext(client: PoolClient): Promise<void> {
  await assertCanonicalSystemContext(client, { role: SYSTEM_CENTRAL_ROLE });
}

/** Runs `fn` inside a fresh transaction with the system context asserted, committing on success. For ad-hoc single-shot reads/writes that aren't already inside an ingest transaction. */
export async function withSystemContext<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withCanonicalSystemContext(pool, { role: SYSTEM_CENTRAL_ROLE }, fn);
}

/** `true` if `client` is a `PoolClient` (has its own transaction to assert context on) rather than a bare `Pool`. */
export function isPoolClient(client: DbClient): client is PoolClient {
  return typeof (client as PoolClient).release === 'function';
}
