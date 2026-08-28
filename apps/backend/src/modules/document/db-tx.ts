import type { PoolClient } from 'pg';

/**
 * Explicit BEGIN/COMMIT wrapper for mutating service methods — local copy per
 * BUILD-PLAN §6 rule 1 (every module owns its own `db-tx.ts` rather than
 * importing a sibling module's). See `modules/settings/db-tx.ts` and
 * `modules/location/db-tx.ts` for the two existing copies this is adapted
 * from; the body is byte-identical by design — the point is not to invent a
 * variant per module.
 *
 * `RlsContextGuard` opens a `BEGIN` on `request.dbClient` before any handler
 * runs, and `RlsCleanupInterceptor` unconditionally issues a `ROLLBACK` at
 * the end of every request. That `ROLLBACK` is a harmless no-op ONLY if the
 * transaction was already closed by an explicit `COMMIT` — otherwise a
 * mutating `doc-template.service.ts` method (`putTemplate`/`resetTemplate`)
 * that only ever queries without calling `COMMIT` has every one of its
 * writes silently discarded by the cleanup interceptor. `BE-TXN-ROLLBACK`
 * (see `modules/settings/db-tx.ts`'s header) is exactly this bug, caught
 * once already in this codebase; every mutating method in this module MUST
 * wrap its writes in `withWrite`.
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
