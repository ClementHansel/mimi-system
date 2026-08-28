import { Pool, type PoolClient } from 'pg';
import { RoleKey } from '@mimi/shared';
import { randomUUID } from 'node:crypto';

/**
 * Live-DB harness for M10 `delivery`'s integration suite — same two-pool
 * split as `kernel/approvals/test-support/live-db.ts` and
 * `modules/inventory/test-support/live-db.ts` (D-21/D-22: a single shared
 * superuser connection string is exactly how RLS got silently bypassed once,
 * and how a module can ship green tests against zero working endpoints — a
 * fake pool never proves a real permission grant exists).
 *
 *  - `getOwnerPool()` — `DATABASE_MIGRATION_URL` (superuser, `BYPASSRLS`).
 *    Fixture setup/teardown ONLY: reading seeded locations/users/items/
 *    storage-areas/drivers/vehicles. Never used to construct or call any
 *    service under test.
 *  - `getAppPool()` — `DATABASE_URL` (the runtime `mimi_app` role — the SAME
 *    identity `DATABASE_POOL` uses in production). Every service call in the
 *    integration suite runs against a `PoolClient` from THIS pool, under the
 *    same `SET LOCAL ROLE app_user` + session-var sequence `RlsContextGuard`
 *    issues for a real request.
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

/** Fixture setup/teardown ONLY — never construct a delivery service against this pool. */
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

/**
 * A driver with NOTHING booked today — minting one if the seeded pool is
 * exhausted.
 *
 * The seed ships exactly TWO active drivers, and it books one of them for
 * `now` (an in-transit dry Surat Jalan, so the demo has live truck positions).
 * These suites then COMMIT real Surat Jalan rows for today and never release
 * them, so the pool of usable drivers shrank by one per run until FR-LOG's
 * "one driver takes ONE truck type per day" rule (`assertNoTruckTypeClash`)
 * rejected the very first test and every later one cascaded on an `undefined`
 * SJ.
 *
 * Same shape of bug, and the same fix, as `pickUnusedItemInLocation` in
 * `modules/inventory/test-support/live-db.ts` (see its long note): stop
 * competing for a finite seeded resource and mint a dedicated one, so the
 * guarantee the callers need is true BY CONSTRUCTION rather than true until
 * the pool runs dry. It went unnoticed for a long time only because these
 * live-DB suites were being silently skipped — see `vitest.config.ts`.
 *
 * `drivers.user_id` is UNIQUE, so a minted driver needs its own user; it is
 * created inactive-looking but valid (`zztest_driver_*`, the seeded driver
 * role, a copied password hash so no real credential is invented) and is inert
 * — nothing logs in as it. No suite asserts an absolute user or driver count.
 */
async function pickOrMintFreeDriver(pool: Pool): Promise<{ id: string; user_id: string }> {
  const free = await pool.query<{ id: string; user_id: string }>(
    `SELECT d.id, d.user_id
       FROM drivers d
      WHERE d.is_active = true
        AND d.user_id IS NOT NULL
        AND NOT EXISTS (
              SELECT 1 FROM surat_jalan sj
               WHERE sj.driver_id = d.id
                 AND sj.planned_date = CURRENT_DATE
                 AND sj.status <> 'cancelled'
            )
      ORDER BY d.id
      LIMIT 1`,
  );
  if (free.rows[0]) return free.rows[0];

  const suffix = randomUUID().slice(0, 8);
  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (username, name, password_hash, role_id)
     SELECT $1, 'Test fixture driver', u.password_hash, r.id
       FROM roles r
       JOIN users u ON u.role_id = r.id
      WHERE r.key = 'driver'
      LIMIT 1
     RETURNING id`,
    [`zztest_driver_${suffix}`],
  );
  const userId = user.rows[0]?.id;
  if (!userId)
    throw new Error('pickOrMintFreeDriver: seed has no driver-role user to model a fixture on');

  const driver = await pool.query<{ id: string; user_id: string }>(
    `INSERT INTO drivers (user_id, name, is_active)
     VALUES ($1, 'Test fixture driver', true)
     RETURNING id, user_id`,
    [userId],
  );
  return driver.rows[0]!;
}

export interface RlsCtx {
  role: string;
  userId: string;
  locationIds: readonly string[] | null;
}

const SYSTEM_CONTEXT_USER_ID = '00000000-0000-0000-0000-0000000000ad';
export const CENTRAL_CTX: RlsCtx = {
  role: 'owner',
  userId: SYSTEM_CONTEXT_USER_ID,
  locationIds: null,
};

/** Runs `fn` against a fresh `mimi_app` connection inside a transaction that is ALWAYS rolled back. */
export async function withRollback<T>(
  fn: (client: PoolClient) => Promise<T>,
  ctx: RlsCtx = CENTRAL_CTX,
): Promise<T> {
  const client = await getAppPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [ctx.userId]);
    await client.query(`SELECT set_config('app.role', $1, true)`, [ctx.role]);
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
 * Counterpart to `withRollback` for every M10 service method — they all
 * self-commit via `db-tx.ts`'s `withWrite` (the Wave-3 mutation convention:
 * ONE HTTP request, ONE COMMIT, matching `RlsCleanupInterceptor`'s "a module
 * service may already have committed on this same client" contract). A test
 * exercising a real mutating call therefore needs its OWN cleanup — this
 * helper does not hide that; callers clean up explicitly afterward.
 */
export async function withCommit<T>(
  fn: (client: PoolClient) => Promise<T>,
  ctx: RlsCtx = CENTRAL_CTX,
): Promise<T> {
  const client = await getAppPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [ctx.userId]);
    await client.query(`SELECT set_config('app.role', $1, true)`, [ctx.role]);
    await client.query(`SELECT set_config('app.location_ids', $1, true)`, [
      ctx.locationIds === null ? '' : ctx.locationIds.join(','),
    ]);
    const result = await fn(client);
    await client.query('COMMIT').catch(() => {}); // no-op NOTICE if `fn` already committed — same tolerance as RlsCleanupInterceptor
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export interface Fixtures {
  warehouseId: string;
  outletId: string;
  freezerAreaWarehouse: string;
  dryAreaWarehouse: string;
  chillerAreaWarehouse: string;
  freezerAreaOutlet: string;
  dryAreaOutlet: string;
  frozenItemId: string;
  frozenItemUnitId: string;
  dryItemId: string;
  dryItemUnitId: string;
  /** No 'chilled' item exists in the seed (only 'frozen'/'dry' — the seed predates the owner's chilled/frozen-share-a-truck decision, W1-C follow-up) — inserted by `loadFixtures` itself, torn down in `deleteChilledItemFixture`. */
  chilledItemId: string;
  chilledItemUnitId: string;
  driverId: string;
  driverUserId: string;
  frozenVehicleId: string;
  dryVehicleId: string;
  usersByRole: Record<RoleKey, string>;
  outletAssignedUserId: (roleKey: RoleKey) => Promise<string>;
}

/** Reads real seeded rows over the OWNER pool — never inserts master data (W1-C's territory); reads are harmless regardless of connection identity. */
export async function loadFixtures(): Promise<Fixtures> {
  const pool = getOwnerPool();

  const warehouse = await pool.query<{ id: string }>(
    `SELECT id FROM locations WHERE type = 'warehouse' AND is_active = true ORDER BY created_at ASC LIMIT 1`,
  );
  const outlet = await pool.query<{ id: string }>(
    `SELECT id FROM locations WHERE type = 'outlet' AND is_active = true ORDER BY code ASC LIMIT 1`,
  );
  const warehouseId = warehouse.rows[0]!.id;
  const outletId = outlet.rows[0]!.id;

  const areaFor = async (locationId: string, type: string): Promise<string> => {
    const res = await pool.query<{ id: string }>(
      `SELECT id FROM storage_areas WHERE location_id = $1 AND type = $2 AND is_active = true LIMIT 1`,
      [locationId, type],
    );
    if (!res.rows[0])
      throw new Error(`Seed is missing a '${type}' storage area at location ${locationId}`);
    return res.rows[0].id;
  };

  const frozenItem = await pool.query<{ id: string; base_unit_id: string; category_id: string }>(
    `SELECT id, base_unit_id, category_id FROM items WHERE storage_type = 'frozen' AND is_active = true LIMIT 1`,
  );
  const dryItem = await pool.query<{ id: string; base_unit_id: string }>(
    `SELECT id, base_unit_id FROM items WHERE storage_type = 'dry' AND is_active = true LIMIT 1`,
  );
  if (!frozenItem.rows[0]) throw new Error(`Seed data is missing a 'frozen' item`);
  if (!dryItem.rows[0]) throw new Error(`Seed data is missing a 'dry' item`);

  // No 'chilled' item in the seed yet (see `Fixtures.chilledItemId` doc) — insert one directly, reusing the
  // frozen item's category/unit to satisfy FKs. `ON CONFLICT (sku) DO NOTHING` + a fixed sku makes this
  // idempotent across repeated local test runs against the same DB.
  const chilledSku = 'TEST-CHILLED-FIXTURE-0001';
  const chilledRes = await pool.query<{ id: string }>(
    `INSERT INTO items (sku, name, category_id, base_unit_id, storage_type, is_sellable, avg_cost, last_purchase_cost)
     VALUES ($1, 'Test Fixture — Chilled Item', $2, $3, 'chilled', false, 15000, 15000)
     ON CONFLICT (sku) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [chilledSku, frozenItem.rows[0].category_id, frozenItem.rows[0].base_unit_id],
  );

  const driver = { rows: [await pickOrMintFreeDriver(pool)] };
  if (!driver.rows[0])
    throw new Error(`Seed data is missing an active driver with a linked user_id`);

  const frozenVehicle = await pool.query<{ id: string }>(
    `SELECT id FROM vehicles WHERE has_freezer = true AND is_active = true LIMIT 1`,
  );
  const dryVehicle = await pool.query<{ id: string }>(
    `SELECT id FROM vehicles WHERE has_freezer = false AND is_active = true LIMIT 1`,
  );
  if (!frozenVehicle.rows[0]) throw new Error(`Seed data is missing a freezer-capable vehicle`);
  if (!dryVehicle.rows[0]) throw new Error(`Seed data is missing a non-freezer vehicle`);

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

  return {
    warehouseId,
    outletId,
    freezerAreaWarehouse: await areaFor(warehouseId, 'freezer'),
    dryAreaWarehouse: await areaFor(warehouseId, 'dry_store'),
    chillerAreaWarehouse: await areaFor(warehouseId, 'chiller'),
    freezerAreaOutlet: await areaFor(outletId, 'freezer'),
    dryAreaOutlet: await areaFor(outletId, 'dry_store'),
    frozenItemId: frozenItem.rows[0].id,
    frozenItemUnitId: frozenItem.rows[0].base_unit_id,
    dryItemId: dryItem.rows[0].id,
    dryItemUnitId: dryItem.rows[0].base_unit_id,
    chilledItemId: chilledRes.rows[0]!.id,
    chilledItemUnitId: frozenItem.rows[0].base_unit_id,
    driverId: driver.rows[0].id,
    driverUserId: driver.rows[0].user_id,
    frozenVehicleId: frozenVehicle.rows[0].id,
    dryVehicleId: dryVehicle.rows[0].id,
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

/** A real, confirmed `attachments` row (kernel/storage's table) — SJ receiving needs at least one photo + a signature, both pre-existing/confirmed before `receive()` is called. Written on the OWNER pool (fixture setup in a table this module doesn't own the writer for; presign/confirm is kernel/storage's HTTP surface, not exercised here). */
export async function createConfirmedAttachment(
  kind: string,
  entityType: string | null,
  entityId: string | null,
): Promise<string> {
  const res = await getOwnerPool().query<{ id: string }>(
    `INSERT INTO attachments (bucket, object_key, file_name, mime_type, size_bytes, kind, entity_type, entity_id)
     VALUES ('mimi-test', $1, $2, 'image/jpeg', 1024, $3, $4, $5)
     RETURNING id`,
    [
      `test/${kind}/${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`,
      `${kind}.jpg`,
      kind,
      entityType,
      entityId,
    ],
  );
  return res.rows[0]!.id;
}

export async function deleteAttachment(id: string): Promise<void> {
  await getOwnerPool().query(`DELETE FROM attachments WHERE id = $1`, [id]);
}

/** Full cleanup of everything a create→...→complete flow touches, by `sj_number` prefix — SJ/drops/lines/temp-logs/seals cascade from `surat_jalan`; `document_counters` rows are left (shared, harmless). */
export async function deleteSuratJalan(id: string): Promise<void> {
  await getOwnerPool().query(`DELETE FROM surat_jalan WHERE id = $1`, [id]);
}

export async function deleteGoodsReceipt(id: string): Promise<void> {
  await getOwnerPool().query(`DELETE FROM goods_receipts WHERE id = $1`, [id]);
}

/**
 * Rolls back the `stock_balances` side-effect a committed SJ flow leaves for this key.
 *
 * QA-ISOLATION finding: this used to blind-DELETE both `stock_movements` AND the
 * `stock_balances` row for the key, on the assumption the (warehouse/outlet freezer area,
 * frozen item) fixture combination this suite dispatches against had zero seed history.
 * That assumption is false often enough to matter — the seed carries "opening stock
 * balances for 30 core items across all locations" (see `database/reset.ts`'s own seed
 * log), and a frozen item at a warehouse/outlet freezer area is a plausible member of
 * that 30. Blind-deleting the row then durably drops the live DB's total `stock_balances`
 * row count below what a fresh reset produces — caught empirically here (a fresh-reset
 * baseline of 630 rows dropped to 628 after one run touching two such keys) — and, worse,
 * makes `stock_movements` from the REAL seed vanish along with this suite's own rows.
 *
 * Fixed to never delete a row it didn't necessarily create: reconcile
 * `stock_balances.qty_on_hand` to the fold of whatever `stock_movements` remain for the key
 * (their own `ref_type`/`ref_id` residue is left in place — harmless, polymorphic, and
 * itself already accounted for by the very fold this reconciles against).
 */
export async function resetStockKey(
  locationId: string,
  storageAreaId: string,
  itemId: string,
): Promise<void> {
  await getOwnerPool().query(
    `UPDATE stock_balances
        SET qty_on_hand = COALESCE(
          (SELECT SUM(CASE WHEN m.movement_type LIKE '%_out' THEN -m.qty ELSE m.qty END)
             FROM stock_movements m
            WHERE m.location_id = stock_balances.location_id
              AND m.storage_area_id = stock_balances.storage_area_id
              AND m.item_id = stock_balances.item_id),
          0
        )
      WHERE location_id = $1 AND storage_area_id = $2 AND item_id = $3`,
    [locationId, storageAreaId, itemId],
  );
}

export async function createReplenishmentRequestFixture(
  locationId: string,
  requestedBy: string,
  itemId: string,
  unitId: string,
  qty: string,
): Promise<{ requestId: string; lineId: string }> {
  const owner = getOwnerPool();
  const period = new Date().toISOString().slice(0, 7).replace('-', '');
  const numRes = await owner.query<{ last_number: number }>(
    `INSERT INTO document_counters (doc_type, period, last_number) VALUES ('RR', $1, 1)
     ON CONFLICT (doc_type, period) DO UPDATE SET last_number = document_counters.last_number + 1 RETURNING last_number`,
    [period],
  );
  const requestNumber = `RR/${period}/${String(numRes.rows[0]!.last_number).padStart(4, '0')}`;
  const reqRes = await owner.query<{ id: string }>(
    `INSERT INTO replenishment_requests (request_number, location_id, status, source, requested_by)
     VALUES ($1, $2, 'approved', 'manual', $3) RETURNING id`,
    [requestNumber, locationId, requestedBy],
  );
  const requestId = reqRes.rows[0]!.id;
  const lineRes = await owner.query<{ id: string }>(
    `INSERT INTO replenishment_request_lines (request_id, item_id, unit_id, qty_requested, qty_approved) VALUES ($1, $2, $3, $4, $4) RETURNING id`,
    [requestId, itemId, unitId, qty],
  );
  return { requestId, lineId: lineRes.rows[0]!.id };
}

export async function deleteReplenishmentRequest(id: string): Promise<void> {
  await getOwnerPool().query(`DELETE FROM replenishment_requests WHERE id = $1`, [id]);
}

export async function readReplenishmentRequestStatus(id: string): Promise<string | null> {
  const res = await getOwnerPool().query<{ status: string }>(
    `SELECT status FROM replenishment_requests WHERE id = $1`,
    [id],
  );
  return res.rows[0]?.status ?? null;
}
