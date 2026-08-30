import type { Pool, PoolClient } from 'pg';
import type { UUID } from '@mimi/shared';

/**
 * Two narrow read-only helpers that both need the SAME escape hatch:
 * `findUsersByRoleAtLocation` (who to notify) and `resolveUserNames`
 * (display names for `kasirName`/`requestedBy`/`decidedBy`/`openedBy`-style
 * fields across this module's read endpoints).
 *
 * WHY THESE NEED THEIR OWN CONNECTION, NOT `req.dbClient`: `users_select`
 * (migration 009) is `app_is_central() OR app_is_self(id)` — a Kasir's own
 * RLS context can see exactly their own `users` row. Two failure modes
 * follow from that if these helpers ran on the caller's own scoped client:
 *
 *  1. Fan-out lookups (`findUsersByRoleAtLocation`) would silently return
 *     ZERO rows for a non-central caller — a Kasir requesting a void, or
 *     closing a shift into a cash-variance proposal, could never discover
 *     "which supervisors cover this outlet".
 *  2. Name-resolution JOINs would silently DROP ENTIRE ROWS, not just null
 *     out a name: `SELECT ... FROM cash_variance_proposals cvp JOIN users ku
 *     ON ku.id = cvp.kasir_user_id` run as a Supervisor viewing shifts
 *     THEY did not close would inner-join against a `users` row RLS hides,
 *     eliminating the whole proposal from the result — `GET
 *     /api/pos/cash-variances` would appear to return fewer rows than
 *     exist, exactly the kind of gap invisible in a same-user happy-path
 *     test (this module's own integration suite caught it: a Supervisor
 *     deciding a proposal opened by "their own" test fixture kasir
 *     happened to satisfy `app_is_self()` by coincidence, masking the bug,
 *     until a list/read path with a DIFFERENT kasir was exercised).
 *
 * The fix in both cases is the same central-role bypass
 * `kernel/sync`'s internal `system-rls-context.ts` uses for its own
 * cross-tenant sweeps (R1/R2/R7, `assertSystemContext`) — re-implemented
 * here, minimally, rather than importing that file directly: it is
 * `kernel/sync`'s private internal, not part of `SyncEngineModule`'s
 * exported surface, and this need (recipients + display names, never
 * writing or authorizing business data) is narrow enough not to warrant a
 * cross-module dependency on another agent's internals.
 *
 * Never use these for an AUTHORIZATION decision — only for "who to notify"
 * and "what name to print next to an id already visible under the CALLER's
 * own RLS". `PosVoidRefundService.verifyPin`, by contrast, deliberately does
 * NOT use this helper: verifying a PIN is an identity check that must run as
 * the ACTING user's own session (`app_is_self`), not a central bypass — see
 * that method and the test suites' `switchActor` helper.
 */
async function withCentralContext<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await client.query(`SELECT set_config('app.role', 'owner', true)`);
    await client.query(`SELECT set_config('app.tenant_id', app_the_only_tenant()::text, true)`);
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

export async function findUsersByRoleAtLocation(
  pool: Pool,
  roleKeys: readonly string[],
  locationId: UUID,
): Promise<UUID[]> {
  return withCentralContext(pool, async (client) => {
    const res = await client.query<{ id: UUID }>(
      `SELECT u.id FROM users u
         JOIN roles r ON r.id = u.role_id
         JOIN user_locations ul ON ul.user_id = u.id
        WHERE r.key = ANY($1::text[]) AND ul.location_id = $2 AND u.is_active`,
      [roleKeys, locationId],
    );
    return res.rows.map((r) => r.id);
  });
}

/**
 * Resolves `{id -> name}` for a set of user ids — display enrichment only,
 * never an authorization input. Missing/duplicate ids are simply absent from
 * the returned map.
 *
 * D-03 (2026-08-29): goes through `app_user_display()` (migration 212), the
 * one display-name mechanism in this codebase, rather than reading `users`
 * under a borrowed central role. Three solutions to "print a name next to an
 * id" had grown independently — `kernel/approvals` on the helper,
 * `stock-opname` on its own join, and this module on an `app.role = 'owner'`
 * escalation — which is how the `users_select` gap the helper exists to close
 * kept being rediscovered module by module.
 *
 * The escalation is what actually mattered here. Reading `users` directly
 * requires a session RLS lets through, so this claimed to BE the owner for the
 * duration of the query — over a connection that could then read `email`,
 * `phone`, `password_hash`, `pin_hash` and `last_login_at` for every user in
 * the system, to print a display name. `app_user_display()` is `SECURITY
 * DEFINER` and returns `id`, `name`, `role_key` and nothing else, so no role
 * has to be borrowed and the blast radius is the three columns actually
 * needed. `SET LOCAL ROLE app_user` remains, purely because `DATABASE_POOL`
 * connects as `mimi_app`, which is `NOINHERIT` and holds no EXECUTE grant of
 * its own (migrations 203/205).
 *
 * `findUsersByRoleAtLocation` above still needs `withCentralContext`: it is a
 * fan-out across `roles` and `user_locations` to discover recipients, which is
 * a different question from "what is this id's name" and not something
 * `app_user_display()` answers.
 */
export async function resolveUserNames(
  pool: Pool,
  userIds: readonly (UUID | null | undefined)[],
): Promise<Map<UUID, string>> {
  const ids = [...new Set(userIds.filter((id): id is UUID => Boolean(id)))];
  if (ids.length === 0) return new Map();
  const client = await pool.connect();
  try {
    // Wrapped in a transaction because `SET LOCAL` is scoped to one — outside
    // a transaction block Postgres warns and the role change does not stick,
    // which would fail on the EXECUTE grant (`mimi_app` is NOINHERIT).
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    const res = await client.query<{ id: UUID; name: string }>(
      `SELECT id, name FROM app_user_display($1::uuid[])`,
      [ids],
    );
    await client.query('COMMIT');
    return new Map(res.rows.map((r) => [r.id, r.name]));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
