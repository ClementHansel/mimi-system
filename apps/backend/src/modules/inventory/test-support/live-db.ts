import { Pool, type PoolClient } from 'pg';
import { RoleKey } from '@mimi/shared';
import { randomUUID } from 'node:crypto';

/**
 * Live-DB harness for M07 `inventory`'s integration/property suites — same
 * two-pool split as `kernel/approvals/test-support/live-db.ts` and
 * `kernel/stock-ledger/test-support/live-db.ts` (D-21/D-22: a single shared
 * superuser connection string is exactly how RLS got silently bypassed once).
 *
 *  - `getOwnerPool()` — `DATABASE_MIGRATION_URL` (Postgres superuser,
 *    `BYPASSRLS`). Fixture setup/teardown ONLY: reading seeded locations/
 *    users/items/storage-areas, inserting/deleting this suite's OWN
 *    `min_stock_rules` test rows (a table this module DOES own — CRUD via
 *    `PUT /api/inventory/min-stock` is this module's job, so writing a
 *    fixture row for it directly is writing in our own territory, unlike
 *    `approvals`' fixtures in tables it doesn't own).
 *  - `getAppPool()` — `DATABASE_URL` (the runtime `mimi_app` role — the SAME
 *    identity `DATABASE_POOL` uses in production). Every
 *    `InventoryService`/`InventoryRepository` call in the integration suite
 *    runs against a `PoolClient` from THIS pool, under the same
 *    `SET LOCAL ROLE app_user` + session-var sequence `RlsContextGuard`
 *    issues for a real request.
 *
 * `stock_balances`/`stock_movements` are NEVER touched by this file's own
 * inserts (D-07) — where a test needs a real balance to read, it goes
 * through `StockLedgerService.post(client, movements, mode)`, exactly like
 * production code would.
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

/** Fixture setup/teardown ONLY — never construct `InventoryService`/`InventoryRepository` against this pool. */
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

const SYSTEM_CONTEXT_USER_ID = '00000000-0000-0000-0000-0000000000ab';

/**
 * Runs `fn` against a fresh `mimi_app` connection inside a transaction that
 * is ALWAYS rolled back. Central ('owner') role by default so cross-location
 * fixtures (a warehouse vs. an outlet key in the same test) are visible in
 * one run without narrowing — same choice `stock-ledger`'s and `approvals`'
 * own harnesses make, for the identical reason. Pass `ctx` to exercise a
 * SCOPED role's real RLS visibility instead (the RBAC-negative tests do).
 */
export async function withRollback<T>(
  fn: (client: PoolClient) => Promise<T>,
  ctx: { role: string; userId: string; locationIds: readonly string[] | null } = {
    role: 'owner',
    userId: SYSTEM_CONTEXT_USER_ID,
    locationIds: null,
  },
): Promise<T> {
  const client = await getAppPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [ctx.userId]);
    await client.query(`SELECT set_config('app.role', $1, true)`, [ctx.role]);
    await client.query(`SELECT set_config('app.tenant_id', app_the_only_tenant()::text, true)`);
    await client.query(`SELECT set_config('app.location_ids', $1, true)`, [
      ctx.locationIds === null ? '' : ctx.locationIds.join(','),
    ]);
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

/**
 * Counterpart to `withRollback` for the two write endpoints
 * (`InventoryService.upsertMinStock`/`postAreaTransfer`) that COMMIT
 * internally on the SAME client `RlsContextGuard` opened (the Wave-3
 * mutation convention documented on `RlsCleanupInterceptor` — the module
 * service commits, the interceptor's own rollback is then a harmless
 * no-op). Testing that commit path for REAL means the write durably lands;
 * this helper doesn't try to hide that — callers are responsible for their
 * own cleanup afterward (see the integration suite's `finally` blocks).
 * `withRollback` remains correct and sufficient for every READ-only call and
 * for exercising `InventoryRepository`'s own methods directly (which never
 * commit) — this helper exists ONLY for the handful of tests that need to
 * prove the full service method (validation → ledger/repo write → sync-emit
 * → COMMIT) actually works end-to-end.
 */
export async function withCommit<T>(
  fn: (client: PoolClient) => Promise<T>,
  ctx: { role: string; userId: string; locationIds: readonly string[] | null } = {
    role: 'owner',
    userId: SYSTEM_CONTEXT_USER_ID,
    locationIds: null,
  },
): Promise<T> {
  const client = await getAppPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [ctx.userId]);
    await client.query(`SELECT set_config('app.role', $1, true)`, [ctx.role]);
    await client.query(`SELECT set_config('app.tenant_id', app_the_only_tenant()::text, true)`);
    await client.query(`SELECT set_config('app.location_ids', $1, true)`, [
      ctx.locationIds === null ? '' : ctx.locationIds.join(','),
    ]);
    const result = await fn(client);
    // If `fn` (the code under test) already COMMITted, this is a documented
    // no-op error Postgres reports as a NOTICE, not an exception — swallow it
    // the same way `RlsCleanupInterceptor` does for the real request path.
    await client.query('COMMIT').catch(() => {});
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Posts a movement via the REAL `StockLedgerService` (never a direct INSERT — D-07), committing in its own short transaction so a subsequent matview refresh / separate connection can see it. */
export async function seedMovementCommitted(
  post: (client: PoolClient) => Promise<unknown>,
): Promise<void> {
  const client = await getAppPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [SYSTEM_CONTEXT_USER_ID]);
    await client.query(`SELECT set_config('app.role', 'owner', true)`);
    await client.query(`SELECT set_config('app.tenant_id', app_the_only_tenant()::text, true)`);
    await client.query(`SELECT set_config('app.location_ids', '', true)`);
    await post(client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** `mv_item_usage_daily` is refreshed on a schedule in production (M18/M19); tests exercising the usage-pattern suggestion basis refresh it synchronously instead. Runs on the OWNER pool — refreshing a materialized view is DDL-adjacent, not a tenant-scoped operation. */
export async function refreshUsageMatview(): Promise<void> {
  await getOwnerPool().query(`REFRESH MATERIALIZED VIEW mv_item_usage_daily`);
}

/** `ref_type` values ONLY this suite's own fixtures ever use — never the seed's (`'seed'`) and never a real domain module's (`'sale'`, `'sj_drop'`, …). Safe to sweep unconditionally. */
const TEST_REF_TYPES = ['test', 'low_stock_test', 'property_test', 'area_transfer'] as const;

/**
 * SKU namespace for items minted by `pickUnusedItemInLocation`. `ZZ` sorts
 * last, so a fixture that picks `ORDER BY sku LIMIT n` keeps selecting the
 * same seeded items it always did and never accidentally grabs a test item.
 */
const TEST_ITEM_SKU_PREFIX = 'ZZTEST-';

/**
 * Deletes every `stock_movements`/now-orphaned `stock_balances` row this
 * suite's own fixtures could have left behind (via `seedMovementCommitted`/
 * `withCommit`, both of which commit for real — D-07 is honored throughout,
 * this only ever DELETEs rows this suite's OWN `StockLedgerService.post`
 * calls created, never hand-inserts). Idempotent and safe to call at the
 * START of a run (leftover state from an interrupted previous run — a killed
 * process, a debugger session — rather than mid-suite cleanup, which each
 * test still does itself in its own `finally`). Scoped to `ref_type IN
 * TEST_REF_TYPES` so the seed's 630 `'seed'`-typed rows are never touched.
 */
export async function purgeTestResidue(): Promise<void> {
  const pool = getOwnerPool();
  await pool.query(`DELETE FROM stock_movements WHERE ref_type = ANY($1::varchar[])`, [
    TEST_REF_TYPES,
  ]);
  await pool.query(
    `DELETE FROM stock_balances b
      WHERE NOT EXISTS (
              SELECT 1 FROM stock_movements m
               WHERE m.location_id = b.location_id AND m.storage_area_id = b.storage_area_id AND m.item_id = b.item_id
            )`,
  );
  // Items minted by `pickUnusedItemInLocation`.
  //
  // Deleted ONE AT A TIME inside a savepoint, skipping any that a foreign key
  // still holds down. The first version of this listed the referencing tables
  // by hand (`stock_movements`, `stock_balances`, `min_stock_rules`) and was
  // wrong within a day: `stock_opname_lines` also references `items`, so a
  // purge threw a foreign-key error and took the whole suite's `beforeAll`
  // with it. Enumerating referencing tables means this helper has to be
  // updated every time anyone adds an FK to `items` — a maintenance debt no
  // one will remember, in a file whose failures look like product bugs.
  //
  // Letting Postgres answer the question instead is both shorter and
  // total: if something still points at the row, it stays. A leftover costs
  // nothing (the minter no longer competes for a finite pool), whereas a
  // wrongly-deleted item would take somebody's audit trail with it.
  await pool.query(
    `DO $$
     DECLARE target RECORD;
     BEGIN
       FOR target IN SELECT id FROM items WHERE sku LIKE '${TEST_ITEM_SKU_PREFIX}%' LOOP
         BEGIN
           DELETE FROM items WHERE id = target.id;
         EXCEPTION WHEN foreign_key_violation THEN
           -- still referenced by a real document; leave it alone
         END;
       END LOOP;
     END $$;`,
  );
}

export interface Fixtures {
  warehouseId: string;
  outletId: string;
  otherOutletId: string;
  storageAreaOutlet: string;
  storageAreaOutletB: string;
  storageAreaWarehouse: string;
  itemId: string;
  itemId2: string;
  usersByRole: Record<RoleKey, string>;
  /** A user actually assigned to `outletId` via `user_locations` (not just any Kasir/Leader/Supervisor row) — needed for RLS-scope tests, which key off real assignment rows, not merely "a user with this role somewhere." */
  outletAssignedUserId: (roleKey: RoleKey) => Promise<string>;
}

/** Reads real seeded rows over the OWNER pool — never inserts master data (W1-C's territory); reads are harmless regardless of connection identity. */
export async function loadFixtures(): Promise<Fixtures> {
  const pool = getOwnerPool();
  const warehouse = await pool.query<{ id: string }>(
    `SELECT id FROM locations WHERE type = 'warehouse' LIMIT 1`,
  );
  const outlets = await pool.query<{ id: string }>(
    `SELECT id FROM locations WHERE type = 'outlet' ORDER BY code LIMIT 2`,
  );
  const items = await pool.query<{ id: string }>(`SELECT id FROM items ORDER BY sku LIMIT 2`);
  const storageOutlet = await pool.query<{ id: string; location_id: string }>(
    `SELECT id, location_id FROM storage_areas WHERE location_id = $1 ORDER BY sort_order LIMIT 2`,
    [outlets.rows[0]!.id],
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
      [roleKey === 'leader_outlet' ? ['koki', 'kasir'] : [roleKey]],
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

  const outletId = outlets.rows[0]!.id;
  const otherOutletId = outlets.rows[1]!.id;

  return {
    warehouseId: warehouse.rows[0]!.id,
    outletId,
    otherOutletId,
    storageAreaOutlet: storageOutlet.rows[0]!.id,
    storageAreaOutletB: storageOutlet.rows[1]!.id,
    storageAreaWarehouse: storageWarehouse.rows[0]!.id,
    itemId: items.rows[0]!.id,
    itemId2: items.rows[1]!.id,
    usersByRole,
    outletAssignedUserId: async (roleKey: RoleKey) => {
      // `leader_outlet` falls back to another OUTLET FLOOR role at the same
      // location. The owner's org has no leader — a shift is a supervisor, a
      // cashier and two cooks — so demanding one made these fixtures fail
      // against a valid database. It is a safe substitution because every
      // caller supplies the ACTING role separately (`callerFor(id, role, ...)`);
      // what it needs from here is a real user at this outlet.
      const wanted = roleKey === 'leader_outlet' ? ['koki', 'kasir'] : [roleKey];
      const res = await pool.query<{ id: string }>(
        `SELECT u.id FROM users u
           JOIN roles r ON r.id = u.role_id
           JOIN user_locations ul ON ul.user_id = u.id
          WHERE r.key = ANY($1::text[]) AND ul.location_id = $2
          -- Prefer a holder with NO location assignment. Since migration 235 a
          -- manager is confined to the branches given to them, so "a manager"
          -- for a fixture has to mean the head-office one: a regional manager
          -- cannot approve a document at an outlet outside their region, and a
          -- spec picking one at random would pass or fail depending on which
          -- outlet the fixture happened to choose. FALSE sorts before TRUE.
          ORDER BY array_position($1::text[], r.key), u.username
          LIMIT 1`,
        [wanted, outletId],
      );
      if (!res.rows[0])
        throw new Error(`No user with role '${roleKey}' assigned to outlet ${outletId}`);
      return res.rows[0].id;
    },
  };
}

export interface StockFixtureKey {
  locationId: string;
  storageAreaId: string;
  itemId: string;
}

/** A `(location, area, item)` triplet with NO existing `stock_balances` row — lets a test post movements starting from a known-zero balance without touching the seed's 630 existing keys. Same helper shape as `kernel/stock-ledger`'s own copy. */
export async function pickUnusedStockKey(
  client: PoolClient,
  opts: { locationId?: string } = {},
): Promise<StockFixtureKey> {
  const res = await client.query<{ location_id: string; storage_area_id: string; item_id: string }>(
    `SELECT sa.location_id, sa.id AS storage_area_id, i.id AS item_id
       FROM storage_areas sa
       CROSS JOIN items i
      WHERE NOT EXISTS (
              SELECT 1 FROM stock_balances b
               WHERE b.location_id = sa.location_id AND b.storage_area_id = sa.id AND b.item_id = i.id
            )
        ${opts.locationId ? 'AND sa.location_id = $1' : ''}
      ORDER BY random()
      LIMIT 1`,
    opts.locationId ? [opts.locationId] : [],
  );
  const row = res.rows[0];
  if (!row)
    throw new Error(
      'pickUnusedStockKey: no unused (location, area, item) triplet found — seed data exhausted?',
    );
  return { locationId: row.location_id, storageAreaId: row.storage_area_id, itemId: row.item_id };
}

/**
 * A `(location, area, item)` triplet where the ITEM has NO `stock_balances`
 * row ANYWHERE in that location (every other area included) — stricter than
 * `pickUnusedStockKey`, which only guarantees the exact triple is unused and
 * says nothing about the item's balance in the location's OTHER areas.
 * Needed for any test whose assertion depends on the SUMMED-across-areas
 * total starting at exactly zero — `min_stock_rules`/low-stock detection's
 * own grain (CONTRACTS.md migration 022: "balance summed across areas per
 * (location,item) vs min_qty"). Using the looser `pickUnusedStockKey` here
 * was the exact bug behind this suite's early flakiness: the seed routinely
 * already stocks a "core item" somewhere else in the same outlet, so a
 * freshly posted balance in some OTHER (empty) area silently summed with
 * that pre-existing stock and never actually crossed the test's intended
 * threshold.
 */
/**
 * ── WHY THIS MINTS AN ITEM INSTEAD OF PICKING ONE ────────────────────────────
 * This used to `CROSS JOIN items` and take any seeded item with no
 * `stock_balances` row in the location. That made the fixture a CONSUMABLE
 * POOL, and the pool only ever shrank:
 *
 *   - `purgeTestResidue()` (above) reclaims items whose balance came from a
 *     movement in `TEST_REF_TYPES`. That part worked.
 *   - but the other live-DB suites — stock-opname GL posting, PO receipt, the
 *     POS shift/sale flows — post REAL business movements (`ref_type` `'sale'`,
 *     `'opname'`, `'goods_receipt'`). Those are not residue and must never be
 *     purged, so every run permanently stocked a few more of the 91 seeded
 *     items in the shared fixture outlet.
 *
 * The failure that produced was not a test failure, it was an ERROR — "no item
 * with zero balance anywhere in location …" — appearing only after N runs, on
 * a database nobody had reseeded. It went unnoticed for a long time because
 * these suites were being silently skipped (see `vitest.config.ts`: they gate
 * on `DATABASE_URL`/`DATABASE_MIGRATION_URL`, which nothing loaded).
 *
 * Minting a dedicated item removes the coupling entirely: the guarantee this
 * helper's callers need — "summed balance across every area of this location
 * is exactly zero", which is `min_stock_rules`' own grain — is now true BY
 * CONSTRUCTION rather than true until some unrelated suite sells something.
 * It cannot exhaust, it cannot be raced by another suite, and it does not care
 * what the seed happens to stock.
 *
 * The item is namespaced (`ZZTEST-…`, sorting last so it never lands in a
 * `ORDER BY sku LIMIT n` fixture pick) and reclaimed by `purgeTestResidue()`.
 * `is_sellable` is false and `is_active` is true: it must behave like a normal
 * stocked item for balance/low-stock queries without ever appearing in a
 * product/menu path.
 *
 * The one assertion this could have disturbed is inventory's
 * `totalItems` check, and that one is written relatively
 * (`toBe(before.totalItems + 1)`), so a new item in the catalogue is invisible
 * to it.
 */
export async function pickUnusedItemInLocation(
  client: PoolClient,
  locationId: string,
): Promise<StockFixtureKey> {
  const area = await client.query<{ id: string }>(
    `SELECT id FROM storage_areas WHERE location_id = $1 ORDER BY sort_order LIMIT 1`,
    [locationId],
  );
  const storageAreaId = area.rows[0]?.id;
  if (!storageAreaId)
    throw new Error(`pickUnusedItemInLocation: location ${locationId} has no storage areas`);

  // Minted over the OWNER pool on purpose: `client` is the caller's
  // app-role transaction, which is ROLLED BACK at the end of the test. An
  // item created there would vanish before the assertions that read it back
  // through a different pool, which is the same reason `seedMovementCommitted`
  // exists.
  const created = await getOwnerPool().query<{ id: string }>(
    // `avg_cost` is copied from a REAL priced item rather than left at the
    // column default of 0. A zero-cost item is not a neutral fixture: stock
    // value, opname variance and every GL posting are `qty x avg_cost`, so a
    // free item silently turns a value-based assertion into `0 === 0`. It also
    // enlarges the zero-cost pool that `stock-opname`'s picker has to steer
    // around (see `pickUnusedStockKey`).
    `INSERT INTO items (sku, name, base_unit_id, storage_type, is_sellable, is_active, avg_cost)
     SELECT $1, $2, i.base_unit_id, 'dry', false, true, i.avg_cost
       FROM items i
      WHERE i.avg_cost > 0
      ORDER BY i.sku
      LIMIT 1
     RETURNING id`,
    [`${TEST_ITEM_SKU_PREFIX}${randomUUID().slice(0, 8)}`, 'Test fixture item'],
  );
  const itemId = created.rows[0]?.id;
  if (!itemId)
    throw new Error(
      'pickUnusedItemInLocation: could not mint a fixture item (is the items table empty?)',
    );

  return { locationId, storageAreaId, itemId };
}

/**
 * A `(location, item)` pair with NO existing `min_stock_rules` row — needed
 * whenever a test asserts "nothing was written" by checking for the
 * ABSENCE of a rule afterward. The seed's "30 core items" carry a
 * `min_stock_rules` row at every location by design (CONTRACTS.md migration
 * 022's seed comment); `pickUnusedStockKey`/`pickUnusedItemInLocation` only
 * guarantee an empty `stock_balances`, not an empty `min_stock_rules` — a
 * rejected-write test using either of those could see a PRE-EXISTING
 * seeded rule and mistake it for evidence its own write went through.
 */
export async function pickItemWithNoMinStockRule(
  client: PoolClient,
  locationId: string,
): Promise<{ locationId: string; itemId: string }> {
  const res = await client.query<{ item_id: string }>(
    `SELECT i.id AS item_id
       FROM items i
      WHERE NOT EXISTS (
              SELECT 1 FROM min_stock_rules msr WHERE msr.location_id = $1 AND msr.item_id = i.id
            )
      ORDER BY random()
      LIMIT 1`,
    [locationId],
  );
  const row = res.rows[0];
  if (!row)
    throw new Error(
      `pickItemWithNoMinStockRule: no item without a min_stock_rules row found for location ${locationId}`,
    );
  return { locationId, itemId: row.item_id };
}

export interface TransferPairFixture {
  locationId: string;
  itemId: string;
  fromAreaId: string;
  toAreaId: string;
}

/**
 * Two DISTINCT storage areas of the SAME location, plus an item with no
 * existing `stock_balances` row in EITHER area — the exact fixture shape an
 * area-transfer test needs. Guarantees `fromAreaId !== toAreaId` by
 * construction (picks two different rows from `storage_areas`), unlike
 * pairing `pickUnusedStockKey`'s random area with some OTHER fixed area that
 * might coincidentally be the same one.
 */
export async function pickUnusedTransferPairInLocation(
  client: PoolClient,
  locationId: string,
): Promise<TransferPairFixture> {
  const res = await client.query<{ from_area: string; to_area: string; item_id: string }>(
    `WITH areas AS (
       SELECT id FROM storage_areas WHERE location_id = $1
     )
     SELECT a1.id AS from_area, a2.id AS to_area, i.id AS item_id
       FROM areas a1
       CROSS JOIN areas a2
       CROSS JOIN items i
      WHERE a1.id <> a2.id
        AND NOT EXISTS (SELECT 1 FROM stock_balances b WHERE b.location_id = $1 AND b.storage_area_id = a1.id AND b.item_id = i.id)
        AND NOT EXISTS (SELECT 1 FROM stock_balances b WHERE b.location_id = $1 AND b.storage_area_id = a2.id AND b.item_id = i.id)
      ORDER BY random()
      LIMIT 1`,
    [locationId],
  );
  const row = res.rows[0];
  if (!row)
    throw new Error(
      `pickUnusedTransferPairInLocation: no clean two-area fixture found for location ${locationId}`,
    );
  return { locationId, itemId: row.item_id, fromAreaId: row.from_area, toAreaId: row.to_area };
}

/** min_stock_rules is OUR table (M07 owns CRUD on it) — write it directly via the owner pool for test setup that predates the code path under test, and always delete it afterward. */
export async function createMinStockRule(
  locationId: string,
  itemId: string,
  minQty: string,
  reorderQty: string | null = null,
): Promise<string> {
  const res = await getOwnerPool().query<{ id: string }>(
    `INSERT INTO min_stock_rules (location_id, item_id, min_qty, reorder_qty, is_active)
     VALUES ($1, $2, $3, $4, true)
     ON CONFLICT (location_id, item_id) DO UPDATE SET min_qty = EXCLUDED.min_qty, reorder_qty = EXCLUDED.reorder_qty, is_active = true
     RETURNING id`,
    [locationId, itemId, minQty, reorderQty],
  );
  return res.rows[0]!.id;
}

export async function deleteMinStockRule(locationId: string, itemId: string): Promise<void> {
  await getOwnerPool().query(
    `DELETE FROM min_stock_rules WHERE location_id = $1 AND item_id = $2`,
    [locationId, itemId],
  );
}
