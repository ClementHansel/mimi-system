import type { PoolClient } from 'pg';

/**
 * Explicit BEGIN/COMMIT wrapper for mutating service methods — see
 * `modules/location/db-tx.ts`'s doc comment for the full rationale. Local
 * copy per BUILD-PLAN §6 rule 1.
 *
 * BE-TXN-ROLLBACK: this file did not exist before that ticket. Every
 * mutating method across `accounting`'s services (`chart-of-accounts.service
 * .ts`'s `create`/`update`, `journal.service.ts`'s `postManual`/`reverse`,
 * `fiscal-periods.service.ts`'s `close`/`reopen`,
 * `payment-verifications.service.ts`'s `create`/`uploadProof`/`verify`/
 * `pay`/`reject`, `exceptions.service.ts`'s `recordVerdict`) ran its 19 raw
 * `INSERT INTO`/`UPDATE ... SET` writes directly on `req.dbClient` with no
 * `COMMIT` anywhere in the module — `RlsCleanupInterceptor`'s unconditional
 * post-request `ROLLBACK` therefore discarded every one of them silently.
 * `POST /api/:tenantId/accounting/payments` (real money) returned 201 with a
 * full body; a follow-up `GET` on that id 404'd. Fixed by wrapping every
 * mutating method's body (from its first actual write onward) in
 * `withWrite`, matching `waste-return`/`stock-opname`/`delivery`/`asset`/
 * `item`/`location`/`product`/`purchasing`'s existing convention exactly —
 * never a second pattern. `journal.service.ts`'s `postSystemEntry` is
 * deliberately NOT wrapped here — it runs exclusively inside
 * `posting-engine.service.ts`'s `postForEvent`, itself always called inside
 * `withSystemContext(this.pool, ...)`, a DIFFERENT, already-correct commit
 * mechanism for that background event-driven path.
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
