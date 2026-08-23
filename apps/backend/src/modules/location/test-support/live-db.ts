import { Pool, type PoolClient } from 'pg';
import { RoleKey } from '@mimi/shared';

/**
 * Live-DB test harness for M03/M04/M05's integration suites (BUILD-PLAN §7
 * ticket brief: "Copy `kernel/approvals/test-support/live-db.ts`"). Shared
 * across `modules/location`, `modules/item`, `modules/product` — all three
 * are this agent's (W3-02) own directories, so importing this one copy from
 * the other two modules' spec files stays inside the ticket's ownership
 * boundary; it is not a cross-team module dependency.
 *
 * TWO POOLS, DELIBERATELY (mirrors `kernel/approvals`/`kernel/sync`'s own
 * harnesses — not a pattern invented here): `getOwnerPool()` uses
 * `DATABASE_MIGRATION_URL` (Postgres superuser, `BYPASSRLS`) for fixture
 * setup/teardown ONLY; `getAppPool()` uses `DATABASE_URL` (the runtime
 * `mimi_app` role — the SAME connection identity `DATABASE_POOL` uses in
 * production). Every service call under test runs on a `PoolClient` from
 * `withRollback`, which issues the identical `SET LOCAL ROLE app_user` +
 * `set_config(...)` sequence `RlsContextGuard` issues per real request —
 * reproducing production's session setup, not a superuser shortcut around
 * `locations`/`storage_areas`'s `FORCE`d RLS.
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

/** Fixture setup/teardown ONLY — never construct a service under test against this pool. */
export function getOwnerPool(): Pool {
  ownerPool ??= new Pool({ connectionString: OWNER_URL, max: 5 });
  return ownerPool;
}

/** The pool the code under test runs against — same identity (`mimi_app`) as production `DATABASE_POOL`. */
export function getAppPool(): Pool {
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

/**
 * Runs `fn` against a fresh `mimi_app` connection, inside a transaction that
 * is ALWAYS rolled back — the code under test's own writes never persist.
 * Asserts the SAME session context `RlsContextGuard` asserts per real
 * request. `roleKey` defaults to `'owner'` (central, unrestricted — matches
 * `kernel/approvals`'s own harness default) so cross-location fixtures are
 * visible in one test run; pass a scoped role + `locationIds` to exercise
 * `storage_areas`'s `LOC` RLS predicate specifically.
 */
export async function withRollback<T>(
  fn: (client: PoolClient) => Promise<T>,
  opts: { roleKey?: string; userId?: string; locationIds?: string[] } = {},
): Promise<T> {
  const client = await getAppPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [
      opts.userId ?? SYSTEM_CONTEXT_USER_ID,
    ]);
    await client.query(`SELECT set_config('app.role', $1, true)`, [opts.roleKey ?? 'owner']);
    await client.query(`SELECT set_config('app.location_ids', $1, true)`, [
      (opts.locationIds ?? []).join(','),
    ]);
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

export interface Fixtures {
  warehouseId: string;
  outletId: string;
  storageAreaOutlet: string;
  storageAreaWarehouse: string;
  itemId: string;
  itemId2: string;
  baseUnitId: string;
  altUnitId: string;
  categoryId: string;
  usersByRole: Record<RoleKey, string>;
}

/** Reads real seeded rows over the OWNER pool — never inserts master data this agent's tests don't own. */
export async function loadFixtures(): Promise<Fixtures> {
  const pool = getOwnerPool();
  const warehouse = await pool.query<{ id: string }>(
    `SELECT id FROM locations WHERE type = 'warehouse' LIMIT 1`,
  );
  const outlet = await pool.query<{ id: string }>(
    `SELECT id FROM locations WHERE type = 'outlet' LIMIT 1`,
  );
  const items = await pool.query<{ id: string }>(`SELECT id FROM items ORDER BY id LIMIT 2`);
  const units = await pool.query<{ id: string }>(`SELECT id FROM units ORDER BY code LIMIT 2`);
  const category = await pool.query<{ id: string }>(`SELECT id FROM item_categories LIMIT 1`);
  const storageOutlet = await pool.query<{ id: string }>(
    `SELECT id FROM storage_areas WHERE location_id = $1 LIMIT 1`,
    [outlet.rows[0]!.id],
  );
  const storageWarehouse = await pool.query<{ id: string }>(
    `SELECT id FROM storage_areas WHERE location_id = $1 LIMIT 1`,
    [warehouse.rows[0]!.id],
  );

  const usersByRole = {} as Record<RoleKey, string>;
  for (const roleKey of Object.values(RoleKey)) {
    const res = await pool.query<{ id: string }>(
      `SELECT u.id FROM users u
         JOIN roles r ON r.id = u.role_id
        WHERE r.key = ANY($1::text[])
        ORDER BY array_position($1::text[], r.key), u.username
        LIMIT 1`,
      [roleKey === 'leader_outlet' ? ['leader_outlet', 'koki', 'kasir'] : [roleKey]],
    );
    // A role with NOBODY IN IT is skipped rather than fatal. This used to throw,
    // which made every fixture here depend on the seed staffing all eleven
    // roles — and that broke the moment the org became the crews the business
    // actually runs (supervisor + cashier + 2 cooks), because no employee holds
    // `leader_outlet` any more. Eighteen spec files failed in `beforeAll`
    // against a database that was entirely valid. A spec that genuinely needs a
    // role now fails at the point of USE, naming the role it wanted.
    if (!res.rows[0]) continue;
    usersByRole[roleKey] = res.rows[0].id;
  }

  return {
    warehouseId: warehouse.rows[0]!.id,
    outletId: outlet.rows[0]!.id,
    storageAreaOutlet: storageOutlet.rows[0]!.id,
    storageAreaWarehouse: storageWarehouse.rows[0]!.id,
    itemId: items.rows[0]!.id,
    itemId2: items.rows[1]!.id,
    baseUnitId: units.rows[0]!.id,
    altUnitId: units.rows[1]!.id,
    categoryId: category.rows[0]!.id,
    usersByRole,
  };
}

let seq = 0;
export function nextCode(prefix: string): string {
  seq += 1;
  return `${prefix}${Date.now()}${seq}`;
}

/**
 * `LocationService`/`ProductService`/etc. self-commit within their own
 * mutating methods (the "AIRE/inventory convention" `RlsCleanupInterceptor`
 * documents — matches production: one HTTP request, one COMMIT). That means
 * `withRollback`'s own ROLLBACK is a no-op the moment a test calls one of
 * those methods — the row is REALLY there. Tests that create throwaway rows
 * (as opposed to reading seeded fixtures) MUST clean them up explicitly, in
 * FK-safe order: `sync_events` (references `locations`/`storage_areas` via
 * `location_id`) → `storage_areas` (references `locations`, `ON DELETE
 * RESTRICT`) → `locations`. Runs over the OWNER pool (superuser, bypasses
 * RLS) so cleanup never depends on the session context a given test used.
 */
export async function cleanupLocations(locationIds: string[]): Promise<void> {
  if (locationIds.length === 0) return;
  const pool = getOwnerPool();
  await pool.query(
    `DELETE FROM sync_events WHERE location_id = ANY($1::uuid[]) OR entity_id = ANY(
       SELECT id FROM storage_areas WHERE location_id = ANY($1::uuid[])
     )`,
    [locationIds],
  );
  await pool.query(`DELETE FROM sync_events WHERE entity_id = ANY($1::uuid[])`, [locationIds]);
  await pool.query(`DELETE FROM stock_balances WHERE location_id = ANY($1::uuid[])`, [locationIds]);
  await pool.query(`DELETE FROM storage_areas WHERE location_id = ANY($1::uuid[])`, [locationIds]);
  await pool.query(`DELETE FROM locations WHERE id = ANY($1::uuid[])`, [locationIds]);
}
