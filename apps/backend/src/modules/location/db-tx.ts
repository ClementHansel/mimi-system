import type { PoolClient } from 'pg';

/**
 * Explicit BEGIN/COMMIT wrapper for mutating service methods.
 *
 * `RlsContextGuard` already issues a `BEGIN` on `request.dbClient` before any
 * handler runs, and `RlsCleanupInterceptor` always finishes the request with
 * a `ROLLBACK` — that `ROLLBACK` is a harmless no-op ONLY if the transaction
 * was already closed by the time it runs (see that interceptor's own doc
 * comment: "a module service may already have run its own BEGIN…COMMIT on
 * this same client — the AIRE/inventory convention this repo's Wave 3/4
 * modules copy"). Postgres treats a second `BEGIN` on an already-open
 * transaction as a no-op warning, so this `BEGIN` doesn't start a NEW
 * transaction — it is the `COMMIT` below that actually persists the guard's
 * outer transaction. Every mutating method in this module MUST wrap its
 * writes in this (or an equivalent explicit BEGIN…COMMIT) — a service that
 * only ever queries without ever committing has every one of its "writes"
 * silently rolled back by the cleanup interceptor.
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
