/**
 * System-level RLS context for `ColdChainService.resolveBreachRecipients`
 * (D-21/D-22). `DATABASE_POOL` connects as `mimi_app` — non-superuser,
 * `NOINHERIT` into `app_user` (migrations 203/205) — so a bare query on a
 * fresh connection has NO table privileges at all until `SET LOCAL ROLE
 * app_user` runs, and even then `users`/`roles`/`user_locations`'s SELECT
 * policy (migration 009) is `ROLE(owner,manager,hr_admin,finance) OR self` —
 * the acting user on a real request is usually a driver or Kepala Gudang
 * (the ones who actually log temperatures), who would see only their OWN row
 * under their own session's RLS context. Resolving "who do we notify on a
 * cold-chain breach" is a cross-cutting, system-level lookup independent of
 * the acting user's own visibility — the identical class of problem
 * `kernel/sync`'s `system-rls-context.ts` and `modules/inventory/low-stock`'s
 * copy both solve for their own background/cross-location work.
 *
 * Duplicated here rather than importing either of those — this module owns
 * nothing outside `modules/delivery` (BUILD-PLAN §6 rule 1), and both of
 * those files are their own module's internal implementation detail, not a
 * published export. See `modules/inventory/low-stock/system-context.ts`'s
 * header for the fuller rationale this file mirrors.
 */
import type { Pool, PoolClient } from 'pg';

const SYSTEM_ROLE = 'owner';

/** Runs `fn` inside a fresh transaction with the central-role RLS bypass asserted, committing on success. */
export async function withSystemContext<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await client.query(`SELECT set_config('app.role', $1, true)`, [SYSTEM_ROLE]);
    await client.query(`SELECT set_config('app.location_ids', '', true)`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
