import type { PoolClient } from 'pg';

/**
 * Explicit BEGIN/COMMIT wrapper for mutating service methods — see
 * `modules/location/db-tx.ts`'s doc comment for the full rationale. Local
 * copy per BUILD-PLAN §6 rule 1.
 *
 * BE-TXN-ROLLBACK: `users.service.ts` (`create`, `update`, `assignRole`,
 * `assignLocations`, `resetPassword`, `deactivate`) ran its writes directly
 * on `req.dbClient` with no `COMMIT` anywhere in this module —
 * `RlsCleanupInterceptor`'s unconditional post-request `ROLLBACK` therefore
 * discarded every one of them silently. Fixed by wrapping every mutating
 * method's body in `withWrite`, matching
 * `waste-return`/`delivery`/`asset`/`item`/`location`/`product`/
 * `purchasing`/`stock-opname`'s existing convention exactly — never a second
 * pattern.
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
