import type { PoolClient } from 'pg';

/**
 * Explicit BEGIN/COMMIT wrapper for mutating service methods — see
 * `modules/location/db-tx.ts` for the full rationale (`RlsCleanupInterceptor`
 * always finishes with a `ROLLBACK`; a mutation only persists if the module
 * service itself commits the guard's outer transaction first). Copied here
 * (rather than imported from `modules/product`) to keep `modules/asset/**`
 * self-contained per this ticket's file-ownership boundary.
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
