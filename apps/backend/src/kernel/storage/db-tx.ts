import type { PoolClient } from 'pg';

/**
 * Explicit BEGIN/COMMIT wrapper for mutating service methods — see
 * `modules/location/db-tx.ts`'s doc comment for the full rationale. Local copy
 * per BUILD-PLAN §6 rule 1.
 *
 * Storage needed this later than everyone else and for a worse reason: nothing
 * here looks like a business transaction, so `presign` and `confirm` were
 * written as plain queries and the missing COMMIT went unnoticed until a day
 * simulation tried to check a cook in. `RlsCleanupInterceptor` rolls back every
 * request that does not commit, which silently discarded the `attachments` row
 * `presign` had just inserted — the caller still got a 200 and an upload URL,
 * the bytes still reached MinIO, and `confirm` then failed with "attachment not
 * found". Selfies are mandatory on attendance (FR-HR-01) and photos on waste
 * (FR-WST-01), so that one missing COMMIT made both unusable.
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
