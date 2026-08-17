/**
 * Live-DB test harness for M01/M02/M20 (auth/users/settings) integration
 * suites — copied from `kernel/approvals/test-support/live-db.ts` per
 * BUILD-PLAN's instruction to this agent ("Copy
 * kernel/approvals/test-support/live-db.ts").
 *
 * TWO POOLS, DELIBERATELY (D-21/D-22 — the incident this whole pattern
 * exists to never reproduce: a single shared superuser connection string is
 * exactly how RLS got silently bypassed once):
 *  - `getOwnerPool()` — `DATABASE_MIGRATION_URL` (Postgres superuser,
 *    `BYPASSRLS`). FIXTURE SETUP/TEARDOWN ONLY.
 *  - `getAppPool()` — `DATABASE_URL` (the runtime `mimi_app` role — the SAME
 *    connection identity `DATABASE_POOL` uses in production). Every
 *    service-under-test in these suites is constructed against THIS pool.
 *
 * `mimi_app` holds ZERO direct table grants (migration 203/205 — `NOINHERIT`
 * membership in `app_user`); every privilege requires `SET LOCAL ROLE
 * app_user` first. `withRollback` issues that + the same
 * `app.user_id`/`app.role`/`app.location_ids` session vars
 * `RlsContextGuard` sets for a real request, so the suite exercises the REAL
 * RLS-enforced path. `withRawAppConnection` deliberately does NOT do any of
 * that — it exists for exactly one purpose: proving the failure mode a
 * service that forgets `SET LOCAL ROLE app_user` hits in production
 * (`permission denied`), the same class of defect found live in the
 * supplier module.
 */
import { Pool, type PoolClient } from 'pg';
import { SYSTEM_CENTRAL_ROLE, SYSTEM_SENTINEL_USER_ID } from '../../../common/database/system-context';

const OWNER_URL =
  process.env.DATABASE_MIGRATION_URL ??
  `postgres://${process.env.POSTGRES_USER ?? 'mimi'}:${process.env.POSTGRES_PASSWORD ?? 'mimi_secret'}@localhost:${
    process.env.POSTGRES_PORT ?? '55433'
  }/${process.env.POSTGRES_DB ?? 'mimi'}`;

const APP_URL =
  process.env.DATABASE_URL ??
  `postgres://mimi_app:${process.env.DB_APP_PASSWORD ?? 'mimi_app_secret'}@localhost:${
    process.env.POSTGRES_PORT ?? '55433'
  }/${process.env.POSTGRES_DB ?? 'mimi'}`;

let ownerPool: Pool | undefined;
let appPool: Pool | undefined;

/** Fixture setup/teardown ONLY — never construct a service-under-test against this pool. */
export function getOwnerPool(): Pool {
  ownerPool ??= new Pool({ connectionString: OWNER_URL, max: 5 });
  return ownerPool;
}

/** The pool every service-under-test is constructed against — same identity (`mimi_app`) as production `DATABASE_POOL`. */
export function getAppPool(): Pool {
  appPool ??= new Pool({ connectionString: APP_URL, max: 5 });
  return appPool;
}

export async function closeTestPool(): Promise<void> {
  await ownerPool?.end();
  await appPool?.end();
  ownerPool = undefined;
  appPool = undefined;
}

/**
 * Runs `fn` against a fresh `mimi_app` connection inside a transaction that
 * is ALWAYS rolled back. Asserts the SAME session context `RlsContextGuard`
 * asserts per real request.
 *
 * DEFAULTS TO THE CENTRAL-ROLE BYPASS (`SYSTEM_CENTRAL_ROLE` = `'owner'`,
 * `common/database/system-context.ts`'s own convention) when `roleKey` is
 * omitted — convenient for fixture setup spanning multiple locations, but an
 * owner session satisfies essentially every RLS policy in CONTRACTS.md
 * §1.14 unconditionally. **A test asserting RBAC/RLS behavior (who can see
 * or do what) MUST pass an explicit, real, non-central `roleKey` — relying
 * on this default in that kind of test proves nothing and has already hidden
 * genuine bugs in two other modules this campaign.** The default belongs to
 * plain CRUD/business-logic fixture setup, never to a visibility assertion.
 */
export async function withRollback<T>(
  fn: (client: PoolClient) => Promise<T>,
  ctx: { userId?: string; roleKey?: string; locationIds?: string[] } = {},
): Promise<T> {
  const client = await getAppPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [ctx.userId ?? SYSTEM_SENTINEL_USER_ID]);
    await client.query(`SELECT set_config('app.role', $1, true)`, [ctx.roleKey ?? SYSTEM_CENTRAL_ROLE]);
    await client.query(`SELECT set_config('app.location_ids', $1, true)`, [(ctx.locationIds ?? []).join(',')]);
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

/**
 * THE regression test's own helper: a raw `mimi_app` connection with NO `SET
 * LOCAL ROLE app_user` and NO session vars — reproduces exactly what a
 * service that injects `DATABASE_POOL` and calls `this.pool.query()`
 * directly (instead of `request.dbClient` or a `system-rls-context.ts`
 * helper) actually gets in production. Expected outcome: every query
 * against an RLS-`FORCE`d OR merely privilege-gated table throws
 * `permission denied` — `mimi_app` itself holds zero direct grants
 * (migration 203/205).
 */
export async function withRawAppConnection<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getAppPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function fetchOneUserId(roleKey: string): Promise<{ id: string; username: string }> {
  const res = await getOwnerPool().query<{ id: string; username: string }>(
    `SELECT u.id, u.username FROM users u JOIN roles r ON r.id = u.role_id WHERE r.key = $1 ORDER BY u.username LIMIT 1`,
    [roleKey],
  );
  if (!res.rows[0]) throw new Error(`Test fixture requires a seeded user with role '${roleKey}'`);
  return res.rows[0];
}

export async function fetchOneLocationId(type: 'warehouse' | 'outlet' = 'outlet'): Promise<string> {
  const res = await getOwnerPool().query<{ id: string }>(`SELECT id FROM locations WHERE type = $1 ORDER BY id LIMIT 1`, [type]);
  if (!res.rows[0]) throw new Error(`Test fixture requires at least one seeded '${type}' location`);
  return res.rows[0].id;
}

/** Inserts a throwaway test user (owner pool — fixture setup) with a KNOWN plaintext password, hashed the same way `UsersService.create`/seed data would. Cleaned up by `deleteTestUser`. */
export async function insertTestUser(row: {
  username: string;
  name: string;
  roleKey: string;
  passwordHash: string;
  pinHash?: string | null;
}): Promise<string> {
  const pool = getOwnerPool();
  const roleRes = await pool.query<{ id: string }>(`SELECT id FROM roles WHERE key = $1`, [row.roleKey]);
  if (!roleRes.rows[0]) throw new Error(`Unknown role '${row.roleKey}'`);
  const res = await pool.query<{ id: string }>(
    `INSERT INTO users (username, name, role_id, password_hash, pin_hash) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [row.username, row.name, roleRes.rows[0].id, row.passwordHash, row.pinHash ?? null],
  );
  return res.rows[0]!.id;
}

export async function assignUserToLocation(userId: string, locationId: string): Promise<void> {
  await getOwnerPool().query(`INSERT INTO user_locations (user_id, location_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [userId, locationId]);
}

export async function insertTestDevice(locationId: string): Promise<string> {
  const res = await getOwnerPool().query<{ id: string }>(
    `INSERT INTO devices (location_id, category, name, status) VALUES ($1, 'tablet', 'W3-01 test device', 'unpaired') RETURNING id`,
    [locationId],
  );
  return res.rows[0]!.id;
}

export async function deleteTestDevice(deviceId: string): Promise<void> {
  await getOwnerPool().query(`DELETE FROM sessions WHERE device_id = $1`, [deviceId]);
  await getOwnerPool().query(`DELETE FROM devices WHERE id = $1`, [deviceId]);
}

export async function deleteTestUser(userId: string): Promise<void> {
  const pool = getOwnerPool();
  await pool.query(`DELETE FROM offline_authorizations WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM offline_credentials WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM user_locations WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
}

export async function setSettingValue(client: PoolClient, key: string, value: unknown): Promise<void> {
  await client.query(`UPDATE settings SET value = $2::jsonb WHERE key = $1`, [key, JSON.stringify(value)]);
}

export async function resetSettingValue(key: string, value: unknown): Promise<void> {
  await getOwnerPool().query(`UPDATE settings SET value = $2::jsonb, updated_by = NULL WHERE key = $1`, [key, JSON.stringify(value)]);
}

/**
 * BE-TXN-ROLLBACK: an explicit alias for `withRollback` used ONLY to mark
 * "this call is standing in for one real HTTP request" at call sites in
 * `settings`/`statutory`/`users` integration specs — mechanically identical
 * (own connection, `BEGIN` + `SET LOCAL ROLE` + session GUCs, run `fn`,
 * always `ROLLBACK` + release on the way out, exactly `RlsContextGuard` +
 * `RlsCleanupInterceptor`'s own lifecycle).
 *
 * THE GOTCHA THAT MATTERS (read before writing a multi-step live-DB test
 * against `settings`/`statutory`/`users`): once a service method correctly
 * wraps its writes in `withWrite` (`BEGIN` — a no-op on an already-open
 * transaction — ... `COMMIT`), that `COMMIT` is REAL: it ends the
 * transaction `withRollback` opened, and `SET LOCAL ROLE`/the `app.*` session
 * GUCs revert with it (Postgres reverts ALL transaction-local state at
 * COMMIT, not only at ROLLBACK). Anything run later on that SAME `client` —
 * even a plain read — executes with no role and no session context, and
 * fails with `permission denied for table ...` (`mimi_app` itself has zero
 * direct grants; every grant lives behind `app_user`).
 *
 * THE RULE: an `asRequest`/`withRollback` block may contain AT MOST ONE call
 * into a `withWrite`-wrapped service method, and nothing on that same
 * `client` may run after it (not even a read) — matching `waste-return`'s
 * established convention ("each step of a flow opens its OWN
 * `withRollbackAs`", see that module's integration spec header) and
 * `stock-opname/test-support/live-db.ts`'s identical doc comment. A
 * write-then-read-back assertion is therefore always TWO calls: one
 * `asRequest`/`withRollback` for the mutation, a SEPARATE one for the
 * verifying read.
 *
 * Data written this way is a REAL commit — like production, it survives this
 * process's own `ROLLBACK` (there is nothing left to roll back by the time
 * it runs). Tests using this rely on the standing `pnpm --filter
 * @mimi/database reset` between runs, same as every other live-DB write path
 * in this repo — any test committing non-settings domain rows (e.g.
 * statutory brackets) MUST clean up its own rows via the owner pool in a
 * `finally` block, and any test committing a shared settings row MUST
 * restore the original value in a `finally` block (see this ticket's
 * SETTINGS-LEAK warning).
 */
export const asRequest = withRollback;

/**
 * For TEST-ONLY seed writes that must be visible to a LATER, separate
 * `asRequest`/`withRollback` connection — opens its own connection, asserts
 * context, runs `fn`, and actually `COMMIT`s (never rolls back). Use ONLY for
 * fixture setup that isn't itself the behavior under test; anything that IS
 * the behavior under test should go through the real service (and
 * `withWrite`), not this.
 */
export async function asCommittedRequest<T>(
  fn: (client: PoolClient) => Promise<T>,
  ctx: { userId?: string; roleKey?: string; locationIds?: string[] } = {},
): Promise<T> {
  const client = await getAppPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [ctx.userId ?? SYSTEM_SENTINEL_USER_ID]);
    await client.query(`SELECT set_config('app.role', $1, true)`, [ctx.roleKey ?? SYSTEM_CENTRAL_ROLE]);
    await client.query(`SELECT set_config('app.location_ids', $1, true)`, [(ctx.locationIds ?? []).join(',')]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } finally {
    client.release();
  }
}
