import type { PoolClient } from 'pg';

/**
 * Explicit BEGIN/COMMIT wrapper for mutating service methods — see
 * `modules/location/db-tx.ts`'s doc comment for the full rationale. Local
 * copy per BUILD-PLAN §6 rule 1.
 *
 * BE-TXN-ROLLBACK: this file did not exist before that ticket. Every
 * request-scoped mutating route in `devices.controller.ts`
 * (`mintPairingToken`, `update`, `unpair`, `retire`) ran its writes directly
 * on `req.dbClient` with no `COMMIT` anywhere — `RlsCleanupInterceptor`'s
 * unconditional post-request `ROLLBACK` therefore discarded every one of
 * them silently (a 201/200 response with a full body, immediately followed
 * by a 404/stale read on the same row). Fixed by wrapping each of those
 * methods' writes in `withWrite`, matching `stock-opname`/`waste-return`/
 * `delivery`/`asset`/`item`/`location`/`product`/`purchasing`'s existing
 * convention exactly — never a second pattern.
 *
 * `register`/`heartbeat` on the same controller, and every write in
 * `staleness-sweep.service.ts`, are NOT touched here — they have no
 * `req.dbClient` to borrow at all (public/device-token routes, and a
 * background sweep respectively) and already commit for real via
 * `kernel/sync/system-rls-context.ts`'s `withSystemContext` (its own
 * BEGIN...COMMIT on a connection it owns) — that is the CORRECT pattern for
 * that shape of caller, not a second bug.
 */
export async function withWrite<T>(client: PoolClient, fn: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    const result = await fn();
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}
