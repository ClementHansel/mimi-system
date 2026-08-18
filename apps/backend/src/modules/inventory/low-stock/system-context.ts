/**
 * System-level RLS context for `LowStockDetectorService`'s background checks
 * (D-21/D-22). `DATABASE_POOL` connects as `mimi_app` — non-superuser,
 * `NOINHERIT` into `app_user` (migrations 203/205) — so a bare query on a
 * fresh connection has NO table privileges at all until `SET LOCAL ROLE
 * app_user` runs. A normal HTTP request gets that from `RlsContextGuard`; the
 * low-stock detector reacts to `stock.moved` events published from ANY
 * location's request, off its own timer, with no per-request user context to
 * borrow — it needs the same central-role bypass `kernel/sync`'s
 * `system-rls-context.ts` asserts for its own cross-location background work
 * (device-token routes, reconciliation sweeps), for the identical reason:
 * `app_has_location()` (the predicate behind `stock_balances`/
 * `min_stock_rules`'s RLS policies, migration 026) already special-cases
 * `app_is_central()` roles as unrestricted, so asserting `app.role = 'owner'`
 * here grants this component exactly what a real Owner already has — not a
 * new hole. Duplicated here (rather than importing `kernel/sync`'s copy)
 * because this module owns nothing outside `modules/inventory` and
 * `kernel/sync`'s file is that module's internal implementation detail, not
 * a published export — the same reasoning that file's own header gives for
 * why it exists as a small, load-bearing duplication rather than a shared
 * util two unrelated modules would otherwise have to coordinate changes to.
 *
 * DELIBERATE DIVERGENCE from `kernel/sync`'s copy — found the hard way, by
 * this module's own integration suite failing intermittently on a pooled
 * connection: that file leaves `app.user_id` unset on the theory that
 * `app_is_self(owner_user_id)` (migration 001) — `users`/`user_locations`'
 * RLS fallback clause — degrades to `false` via its own
 * `current_setting(...) IS NOT NULL` guard when the GUC was never set.
 * That reasoning holds on a BRAND NEW connection, but not on a REUSED pooled
 * one: Postgres custom GUC placeholders, once touched ANYWHERE in a
 * session's lifetime (even by a `SET LOCAL` that later rolled back), report
 * `current_setting(name, true)` as an EMPTY STRING from then on for the rest
 * of that physical connection — never NULL again. `app_is_self`'s guard
 * checks `IS NOT NULL`, which an empty string satisfies, so it proceeds to
 * `''::uuid`, which throws `22P02 invalid input syntax for type uuid`.
 * Verified directly against this stack's Postgres 16 (`BEGIN; SET LOCAL
 * app.x = 'y'; ROLLBACK; SELECT current_setting('app.x', true);` → `''`,
 * not NULL) — this is standard placeholder-GUC behavior, not a
 * misconfiguration. `DATABASE_POOL` is a shared, long-lived connection pool
 * (`common/database/database-pool.provider.ts`) whose connections are reused
 * across many requests over the app's lifetime, and `RlsContextGuard` sets
 * `app.user_id` on every one of them — so by the time this detector's
 * background check lands on a connection ANY real request has ever used,
 * the "leave it unset" assumption is already false. Setting a fixed,
 * syntactically-valid sentinel UUID here (never a real `users.id`, and never
 * read back as one — the queries this context guards don't key off identity,
 * only off the central-role bypass) sidesteps the whole class of failure
 * rather than depending on connection-reuse history.
 */
import type { Pool, PoolClient } from 'pg';

const SYSTEM_ROLE = 'owner';
/** Syntactically valid, deliberately never a real `users.id` — see the file header's placeholder-GUC note. */
const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

/** Runs `fn` inside a fresh transaction with the central-role RLS bypass asserted, committing on success (read-only callers may also just let this commit — a plain SELECT has nothing to lose by committing an empty write set). */
export async function withSystemContext<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await client.query(`SELECT set_config('app.role', $1, true)`, [SYSTEM_ROLE]);
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [SYSTEM_USER_ID]);
    await client.query(`SELECT set_config('app.location_ids', '', true)`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
