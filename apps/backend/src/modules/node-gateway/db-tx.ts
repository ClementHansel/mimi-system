import type { PoolClient } from 'pg';

/**
 * Explicit BEGIN/COMMIT wrapper for mutating service methods — see
 * `modules/location/db-tx.ts`'s doc comment for the full rationale. Local
 * copy per BUILD-PLAN §6 rule 1.
 *
 * BE-TXN-ROLLBACK: this file did not exist before that ticket. Every
 * request-scoped mutating route across `nodes.controller.ts`
 * (`mintPairingToken`, `update`, `unpair`, `discovered/:id/confirm`,
 * `discovered/:id/ignore`) and `outlet-node-setting.controller.ts`
 * (`setEnabled`) ran its writes directly on `req.dbClient` with no `COMMIT`
 * anywhere — `RlsCleanupInterceptor`'s unconditional post-request `ROLLBACK`
 * therefore discarded every one of them silently. Fixed by wrapping each of
 * those methods' writes in `withWrite`, matching `stock-opname`/
 * `device-registry`/`waste-return`/`delivery`/`asset`/`item`/`location`/
 * `product`/`purchasing`'s existing convention exactly — never a second
 * pattern.
 *
 * `register` on `NodesController`, and `sendCommand` (which touches no
 * database row at all — it only relays over `/bridge`), are NOT touched here.
 * `register` has no `req.dbClient` to borrow (public/node-token route) and
 * already commits for real via `kernel/sync/system-rls-context.ts`'s
 * `withSystemContext` — the correct pattern for that shape of caller, not a
 * second bug.
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
