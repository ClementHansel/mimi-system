import { Pool, type PoolClient } from 'pg';
import { RoleKey } from '@mimi/shared';

/**
 * Live-DB test harness for M17 `accounting`'s integration suite — copied
 * from `kernel/approvals/test-support/live-db.ts` per this agent's brief
 * ("copy this fixture harness"), trimmed to the generic pool/session
 * mechanics (no opname/waste/return-specific fixture writers — this
 * module's own fixtures are plain reads of already-seeded rows, see
 * `loadFixtures` below).
 *
 * TWO POOLS, DELIBERATELY (D-21/D-22, see the approvals harness's own doc
 * comment for the full incident writeup): `getOwnerPool()` is
 * `DATABASE_MIGRATION_URL` (superuser/`BYPASSRLS`), fixture setup/teardown
 * ONLY; `getAppPool()` is `DATABASE_URL` (the runtime `mimi_app` role) —
 * every service call under test runs on a `PoolClient` from THIS pool, so
 * the suite exercises the REAL RLS-enforced path, never a superuser bypass
 * wearing a test's clothing.
 */

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

function getOwnerPool(): Pool {
  ownerPool ??= new Pool({ connectionString: OWNER_URL, max: 5 });
  return ownerPool;
}

/** The pool the code under test runs against — same identity (`mimi_app`) as production `DATABASE_POOL`; also what `PostingEngineService`'s `withSystemContext` calls open a connection from in these tests. */
export function appPoolForDi(): Pool {
  return getAppPool();
}

function getAppPool(): Pool {
  appPool ??= new Pool({ connectionString: APP_URL, max: 5 });
  return appPool;
}

export async function closePool(): Promise<void> {
  await ownerPool?.end();
  await appPool?.end();
  ownerPool = undefined;
  appPool = undefined;
}

const SYSTEM_CONTEXT_USER_ID = '00000000-0000-0000-0000-0000000000aa';

/** Central-role ('owner') session — see `withRollbackAs`'s doc comment for when NOT to use this (any assertion about what a scoped role's OWN RLS-restricted session can/cannot see). */
export async function withRollback<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return withRollbackAs({ role: 'owner', userId: SYSTEM_CONTEXT_USER_ID, locationIds: [] }, fn);
}

export interface RlsSessionContext {
  role: string;
  userId: string;
  locationIds: readonly string[];
}

/**
 * Same rolled-back-transaction contract as `withRollback`, but with a
 * CALLER-CHOSEN `app.role`/`app.user_id`/`app.location_ids` — the only way
 * to exercise a scoped role's real RLS-restricted session (a `finance`
 * verifying/paying a PV, an `owner` closing a period, a `kasir` who must be
 * DENIED by `payment_verifications`' central-role-only RLS on a direct
 * write — CONTRACTS.md §0/§3's "permission denied" pin, real role, not
 * `'owner'`).
 */
export async function withRollbackAs<T>(
  ctx: RlsSessionContext,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getAppPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [ctx.userId]);
    await client.query(`SELECT set_config('app.role', $1, true)`, [ctx.role]);
    await client.query(`SELECT set_config('app.location_ids', $1, true)`, [
      ctx.locationIds.join(','),
    ]);
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

/**
 * BE-TXN-ROLLBACK: an explicit alias for `withRollbackAs`, used ONLY to mark
 * "this call is standing in for one real HTTP request" at call sites below —
 * mechanically identical (own connection, `BEGIN` + `SET LOCAL ROLE` +
 * session GUCs, run `fn`, always `ROLLBACK` + release on the way out). Now
 * that every mutating method this module's services expose really commits
 * (`db-tx.ts`'s `withWrite`), a real `COMMIT` inside `fn` ends THIS
 * connection's transaction and reverts `SET LOCAL ROLE`/the `app.*` GUCs —
 * anything run afterward on the SAME client (even a plain read) then fails
 * with `permission denied for table ...`. THE RULE (mirrored from
 * `stock-opname`'s harness, the reference fix for this exact bug class): a
 * `withRollbackAs`/`asRequest` block may contain AT MOST ONE call into a
 * `withWrite`-wrapped service method, and nothing on that same client may run
 * after it. A write-then-read-back assertion is therefore always TWO calls —
 * one `asRequest` for the mutation, a SEPARATE one for the verifying read —
 * which is also the only shape that can catch a service that silently never
 * commits.
 */
export const asRequest = withRollbackAs;

/**
 * For TEST-ONLY seed writes that must be visible to a LATER, separate
 * `asRequest`/`withRollbackAs` connection (e.g. hand-inserting an
 * `offline_credentials`/`offline_authorizations`/`sync_conflicts` trio to
 * simulate an already-open D-17 exception case before exercising
 * `recordVerdict`) — opens its own connection, asserts context, runs `fn`,
 * and actually `COMMIT`s (never rolls back). Use ONLY for fixture setup that
 * isn't itself the behavior under test; anything that IS the behavior under
 * test should go through the real service (and `withWrite`), not this.
 */
export async function asCommittedRequest<T>(
  ctx: RlsSessionContext,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getAppPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [ctx.userId]);
    await client.query(`SELECT set_config('app.role', $1, true)`, [ctx.role]);
    await client.query(`SELECT set_config('app.location_ids', $1, true)`, [
      ctx.locationIds.join(','),
    ]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } finally {
    client.release();
  }
}

export interface Fixtures {
  warehouseId: string;
  outletId: string;
  itemId: string;
  usersByRole: Record<RoleKey, string>;
}

/** Reads real seeded rows over the OWNER pool — never inserts (this module's fixtures are all pre-existing seed rows: locations, users, chart_of_accounts, fiscal_periods, posting_rules). */
export async function loadFixtures(): Promise<Fixtures> {
  const pool = getOwnerPool();
  const warehouse = await pool.query<{ id: string }>(
    `SELECT id FROM locations WHERE type = 'warehouse' LIMIT 1`,
  );
  const outlet = await pool.query<{ id: string }>(
    `SELECT id FROM locations WHERE type = 'outlet' LIMIT 1`,
  );
  const item = await pool.query<{ id: string }>(`SELECT id FROM items LIMIT 1`);

  const usersByRole = {} as Record<RoleKey, string>;
  for (const roleKey of Object.values(RoleKey)) {
    const res = await pool.query<{ id: string }>(
      `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.key = $1 LIMIT 1`,
      [roleKey],
    );
    if (!res.rows[0])
      throw new Error(
        `Seed data is missing a user with role '${roleKey}' — fixtures require the full seed to have run.`,
      );
    usersByRole[roleKey] = res.rows[0].id;
  }

  return {
    warehouseId: warehouse.rows[0]!.id,
    outletId: outlet.rows[0]!.id,
    itemId: item.rows[0]!.id,
    usersByRole,
  };
}
