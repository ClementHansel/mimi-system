import type { PoolClient } from 'pg';

/**
 * Explicit BEGIN/COMMIT wrapper for the dashboard's few writes (marking an
 * anomaly reviewed, saving its thresholds) — local copy of the convention
 * every mutating module carries (`modules/settings/db-tx.ts` has the full
 * rationale).
 *
 * `RlsCleanupInterceptor` issues an unconditional ROLLBACK on the request's
 * client after every request, so a write that is not committed HERE returns
 * 200 and saves nothing. Build the whole response before this returns: the
 * COMMIT also ends the guard's transaction, taking `SET LOCAL ROLE app_user`
 * and the `app.*` session variables with it, so a read on the same client
 * afterwards sees nothing.
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
