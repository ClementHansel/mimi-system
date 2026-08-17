import type { PoolClient } from 'pg';

/**
 * Explicit BEGIN/COMMIT wrapper for mutating service methods — see
 * `modules/location/db-tx.ts`'s doc comment for the full rationale. Local
 * copy per BUILD-PLAN §6 rule 1.
 *
 * BE-TXN-ROLLBACK: this file did not exist before that ticket. Every
 * mutating method in `stock-opname.service.ts` (`create`, `upsertLines`,
 * `resolveLine`, `submit`, `approve`, `reject`, `cancel`) ran its writes
 * directly on `req.dbClient` with no `COMMIT` anywhere in the module —
 * `RlsCleanupInterceptor`'s unconditional post-request `ROLLBACK` therefore
 * discarded every one of them silently. `POST /api/stock-opname` returned
 * 201 with a full body; a follow-up `GET` on that id 404'd. Fixed by
 * wrapping every mutating method's body in `withWrite`, matching
 * `waste-return`/`delivery`/`asset`/`item`/`location`/`product`/
 * `purchasing`'s existing convention exactly — never a second pattern.
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
