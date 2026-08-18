/**
 * The canonical "system context" primitive — the pattern five modules
 * independently reinvented (`kernel/sync`, `kernel/notification`,
 * `modules/auth`, `modules/delivery`, `modules/inventory/low-stock`) before
 * the coordinator asked for one home. `common/` is that home: it already
 * owns `RlsContextGuard`, `ScopeService`, and `DATABASE_POOL`, every
 * consumer is backend-only, and — unlike `packages/shared` — it is allowed
 * to do I/O (open connections), which a helper like this fundamentally must.
 *
 * ## What this is for
 *
 * `DATABASE_POOL` connects as `mimi_app`: a non-superuser LOGIN role,
 * `NOINHERIT` into `app_user`, with NO table grants of its own (migrations
 * 203/205, D-21/D-22). Every table grant and every RLS policy is reached
 * ONLY via `SET LOCAL ROLE app_user` plus the `app.*` session GUCs the
 * policies read. For a normal HTTP request, `RlsContextGuard` does exactly
 * this from the verified JWT, once, and hands the resulting client to the
 * route via `request.dbClient`.
 *
 * This helper is for the requests that have NO such client to borrow:
 *
 *  - **Pre-session** — there is no authenticated user yet at all (login,
 *    before a session exists to derive `app.user_id`/`app.role` from).
 *  - **Background / event-driven** — a cron sweep (the low-stock detector
 *    reacting to a `stock.moved` event off its own timer), a device-token
 *    route with no user JWT (`kernel/sync`'s `/sync/v1/*`), fan-out to an
 *    arbitrary set of recipients (`kernel/notification` resolving contact
 *    info for a notification's audience) — none of these run "as" one
 *    request's acting user, and borrowing that user's narrow RLS scope
 *    would usually be the wrong scope anyway, not just an unavailable one.
 *
 * **If you have a `request.dbClient` (you're behind `RlsContextGuard`), use
 * that client. Do not call this instead.** Two independent reasons: (1) it
 * would open a SECOND pooled connection for no reason when one already
 * exists for this request, and (2) `withSystemContext`'s default shape
 * grants the CENTRAL-ROLE bypass (`app.role = 'owner'`) — deliberately
 * wider than almost any real acting user's own scope. Using it inside a
 * guarded route would silently widen that route's effective authorization
 * beyond what the caller's own role grants, which is a privilege-escalation
 * shaped mistake even though nothing hostile is going on.
 *
 * ## The empty-string GUC sentinel (read this before touching `userId`)
 *
 * `set_config(name, value, is_local => true)` reverts the GUC at
 * COMMIT/ROLLBACK — but reverts it to an EMPTY STRING, not a true SQL NULL,
 * once that placeholder GUC has been set at least once on a given physical
 * connection. Verified directly against this stack's Postgres 16:
 *
 *   BEGIN; SELECT set_config('app.user_id', '<uuid>', true); COMMIT;
 *   SELECT current_setting('app.user_id', true);   -- '' (NOT NULL)
 *
 * Every `DATABASE_POOL` connection that has EVER served an authenticated
 * request (i.e. every connection, in any real deployment — `RlsContextGuard`
 * sets `app.user_id` on every request) is in this state for the rest of its
 * life. `app_is_self()` (migration 001) guards `current_setting(...) IS NOT
 * NULL`, which an empty string satisfies, so leaving `app.user_id` "unset"
 * on a call that doesn't otherwise care about identity does NOT make
 * `app_is_self()` evaluate false — it makes `owner_user_id = ''::uuid`
 * THROW `22P02 invalid input syntax for type uuid`. Postgres does not
 * guarantee short-circuiting an `OR`'s second operand, so any policy that
 * combines a central-role check with `app_is_self` (`users_select` chief
 * among them: `role IN (...) OR app_is_self(id)`) can crash on this path
 * even when the central-role check alone would have been sufficient.
 *
 * THE FIX: always set `app.user_id` to a syntactically-valid, semantically
 * inert sentinel (`SYSTEM_SENTINEL_USER_ID`, the all-zero UUID —
 * `gen_random_uuid()` never produces it, no seeded/real row ever uses it)
 * unless the caller is deliberately impersonating a specific real user
 * (see `withRecipientContext`-shaped calls below). `owner_user_id =
 * '00000000-...'::uuid` is then a normal, safe, always-false comparison.
 *
 * W1-C is separately fixing `app_is_self()` itself to guard
 * `NULLIF(current_setting('app.user_id', true), '') IS NOT NULL` (matching
 * `app_has_location()`'s own `NULLIF(..., '')` guard two lines above it in
 * the same migration). Once that lands, this sentinel becomes belt-and-braces
 * rather than load-bearing — keep it anyway; defence in depth is right here,
 * and a helper this security-relevant should not depend on exactly one
 * migration staying correct forever.
 *
 * ## Two shapes, one mechanism
 *
 * - **Central-role bypass** (`{ role: SYSTEM_CENTRAL_ROLE }`, the default
 *   `userId`): for reads/writes that are legitimately cross-user/
 *   cross-location — the low-stock detector reading `stock_balances`
 *   system-wide, `kernel/sync`'s device-token routes reading `devices`
 *   for ANY caller, resolving contact info for an arbitrary notification
 *   audience. `app.role = 'owner'` grants exactly what a real Owner
 *   already has (`app_is_central()`/`app_has_location()` special-case it) —
 *   not a new hole, the same bypass a real central-role user gets.
 * - **Recipient/self impersonation** (`{ role: '', userId: <real id> }`):
 *   for the narrower case where the ONLY correct authorization is "this
 *   transaction genuinely IS that specific user" — e.g. writing a
 *   `notifications` row, whose RLS (`notifications_self`) is `app_is_self
 *   (user_id)` ONLY, with no central-role arm at all. Setting
 *   `app.role = 'owner'` would do nothing there; the row's own `user_id`
 *   is the one identity capable of legitimately writing it. This is not a
 *   wider grant than the write already implies — the row being inserted
 *   already names that exact recipient as its subject.
 *
 * ## KNOWN GAP — do not paper over it
 *
 * `sessions`/`offline_credentials`' RLS is `SELF`-only (`app_is_self`,
 * CONTRACTS.md §1.14), with NO central-role arm. Neither shape above can
 * unlock a lookup by an unknown key on those tables (you cannot set
 * `app.user_id` to "whoever turns out to own this row" before you've found
 * it — that's the point of the lookup). This is a real, currently-unsolved
 * gap for any system-level offline-credential lookup, flagged for
 * senior-db/the architect (an `app_is_central()` arm on that one policy, or
 * a `SECURITY DEFINER` lookup function) — not something a caller should
 * work around by weakening a policy or reaching for a superuser connection.
 */
import type { Pool, PoolClient } from 'pg';

/** Never a real row's id (`gen_random_uuid()` cannot produce it) — see the GUC sentinel note above. */
export const SYSTEM_SENTINEL_USER_ID = '00000000-0000-0000-0000-000000000000';

/** The role every central-role-bypass caller has converged on (`app_is_central()` also accepts manager/finance/hr_admin — `owner` is simply the fixed convention). */
export const SYSTEM_CENTRAL_ROLE = 'owner';

export interface SystemContextOptions {
  /**
   * `app.role` to assert for this transaction. Use `SYSTEM_CENTRAL_ROLE`
   * for the cross-user/cross-location bypass shape; use `''` when
   * impersonating a specific `userId` under a SELF-only policy (setting a
   * role does nothing there and would be misleading to read at the call site).
   */
  role: string;
  /**
   * `app.user_id` to assert. Defaults to `SYSTEM_SENTINEL_USER_ID`. Pass a
   * real `users.id` ONLY when this transaction must genuinely BE that user
   * for a SELF-only policy (e.g. inserting a `notifications` row on that
   * recipient's behalf) — never as a shortcut to "impersonate" a user for
   * convenience.
   */
  userId?: string;
  /**
   * `app.location_ids` to assert (joined with `,`). Defaults to none. A
   * central-role bypass never needs this (`app_has_location()` bypasses to
   * unrestricted for central roles regardless of this value) — only set it
   * if a caller has a specific reason a `LOC`-scoped policy needs it.
   */
  locationIds?: readonly string[];
}

/**
 * Asserts the system context on the CURRENT transaction only — caller must
 * have already run `BEGIN` on `client`. Use this (instead of
 * `withSystemContext`) when the caller already owns the transaction (e.g.
 * an ingest pipeline that BEGINs once and asserts context as one step among
 * several before COMMITting itself).
 *
 * `SET LOCAL ROLE` only ever narrows privilege, never widens it — safe to
 * call even if a connection were, in some misconfigured environment, still
 * a superuser (matching `RlsContextGuard`'s own defensive posture).
 */
export async function assertSystemContext(
  client: PoolClient,
  options: SystemContextOptions,
): Promise<void> {
  await client.query('SET LOCAL ROLE app_user');
  await client.query(`SELECT set_config('app.role', $1, true)`, [options.role]);
  await client.query(`SELECT set_config('app.user_id', $1, true)`, [
    options.userId ?? SYSTEM_SENTINEL_USER_ID,
  ]);
  await client.query(`SELECT set_config('app.location_ids', $1, true)`, [
    (options.locationIds ?? []).join(','),
  ]);
}

/**
 * Opens a fresh transaction on a connection checked out from `pool`,
 * asserts the system context, runs `fn`, and commits on success / rolls
 * back and releases on any error (always releases). For the common
 * "ad-hoc single-shot system read or write" case — a background sweep, a
 * device-token route, resolving a notification's recipients — that isn't
 * already inside a transaction of its own.
 */
export async function withSystemContext<T>(
  pool: Pool,
  options: SystemContextOptions,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await assertSystemContext(client, options);
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
