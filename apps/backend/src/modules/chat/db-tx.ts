import type { PoolClient } from 'pg';

/**
 * Explicit BEGIN/COMMIT wrapper for mutating service methods — see
 * `modules/location/db-tx.ts`'s doc comment for the full rationale
 * (`RlsContextGuard`'s outer transaction + `RlsCleanupInterceptor`'s
 * always-ROLLBACK cleanup). Local copy per BUILD-PLAN §6 rule 1.
 *
 * Added 2026-09-07: NOTHING in either chat service committed, so every write
 * the messaging feature made — a staff member's Mail to head office, an
 * internal Chats message, opening a WhatsApp thread, marking one read — was
 * rolled back by the cleanup interceptor. The `BE-TXN-ROLLBACK` tripwire
 * turned each into a 500 rather than silent loss, which is how it was found:
 * driving `/me/chat` in the UI answered "Terjadi kesalahan" and the log named
 * the endpoint.
 *
 * NESTING IS THE TRAP HERE. A second `BEGIN` is a no-op warning but the FIRST
 * `COMMIT` ends the transaction, so a wrapped method calling another wrapped
 * method commits half the work early and leaves the outer `COMMIT` with
 * nothing to close. Every public method below therefore delegates to a
 * private `…Tx` sibling, and internal callers use that sibling directly.
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
