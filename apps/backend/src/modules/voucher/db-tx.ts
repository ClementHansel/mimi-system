import type { PoolClient } from 'pg';

/**
 * Explicit BEGIN/COMMIT wrapper for mutating service methods — see
 * `modules/location/db-tx.ts`'s doc comment for the full rationale. Local
 * copy per BUILD-PLAN §6 rule 1.
 *
 * BE-TXN-ROLLBACK, restated because this module is the one where getting it
 * wrong costs actual money: `RlsCleanupInterceptor` issues an UNCONDITIONAL
 * `ROLLBACK` after every request. A service method that writes on
 * `req.dbClient` without an explicit `COMMIT` therefore has its write silently
 * discarded — no error, no log, a 200 response and nothing in the table. That
 * bug has already shipped once in this repo (`settings.service.ts` and
 * `statutory.service.ts`; see `modules/settings/db-tx.ts`'s header for the
 * post-mortem). Here it would mean minting a print run of coupons that the
 * owner then prints onto card stock while the database holds none of them:
 * every one of those codes would be "not found" at the till.
 *
 * So EVERY mutating method in `voucher.service.ts` is wrapped in `withWrite`.
 *
 * ONE DELIBERATE EXCEPTION, and it is not an exception to the rule so much as
 * a different caller: `voucher-redemption.service.ts` does NOT wrap anything.
 * It is called from inside `PosSaleService.applySaleFact`, which already runs
 * inside a transaction its own caller owns — the POS controller issues the
 * `COMMIT` itself (`pos.controller.ts`'s header), and the sync path runs under
 * `SyncEventsRepository.withTransaction`. Opening a nested `BEGIN` there would
 * be a no-op warning at best; committing there would break the atomicity that
 * makes "the sale and its redemption land together or not at all" true, which
 * is the entire point of doing the redemption on the sale's own connection.
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
