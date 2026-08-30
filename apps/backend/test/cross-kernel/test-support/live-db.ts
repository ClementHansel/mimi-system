import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';

/**
 * Live-DB harness for the Gate-G2 cross-kernel scenario
 * (`replenishment.integration.spec.ts` in this directory) — copied from
 * `kernel/approvals/test-support/live-db.ts`'s two-pool split (the same
 * split `modules/delivery/test-support/live-db.ts` uses), NOT reinvented:
 *
 *  - `getOwnerPool()` — `DATABASE_MIGRATION_URL` (Postgres superuser,
 *    `BYPASSRLS`). Fixture setup/teardown and post-hoc verification reads
 *    ONLY (raw `stock_movements`/`approval_steps`/`notifications`/
 *    `audit_log` queries to check what the code under test actually left
 *    behind) — never used to construct or call a kernel/module service.
 *  - `getAppPool()` — `DATABASE_URL` (the runtime `mimi_app` role, same
 *    identity `DATABASE_POOL` uses in production). Every service call this
 *    scenario drives runs on a `PoolClient` from THIS pool, under the exact
 *    `SET LOCAL ROLE app_user` + `app.user_id`/`app.role`/`app.location_ids`
 *    sequence `RlsContextGuard` sets for a real request — with the REAL role
 *    for each step (leader_outlet, supervisor, kepala_gudang, driver), never
 *    'owner'. An 'owner' session bypasses location-scoped RLS entirely
 *    (`app_is_central()`), which would make every RLS-dependent assertion in
 *    this scenario meaningless — see this repo's own migration
 *    209_w1c_kepala_gudang_fulfilment_visibility.sql for a real bug ('owner'
 *    everywhere in a test suite hid a kepala_gudang RLS gap for months).
 */

const OWNER_URL =
  process.env.DATABASE_MIGRATION_URL ??
  `postgres://mimi:mimi_secret@localhost:${process.env.POSTGRES_PORT ?? '55433'}/${process.env.POSTGRES_DB ?? 'mimi'}`;

const APP_URL =
  process.env.DATABASE_URL ??
  `postgres://mimi_app:mimi_app_secret@localhost:${process.env.POSTGRES_PORT ?? '55433'}/${process.env.POSTGRES_DB ?? 'mimi'}`;

let ownerPool: Pool | undefined;
let appPool: Pool | undefined;

/** Fixture setup/teardown/verification ONLY — never construct a kernel/module service against this pool. */

/**
 * A driver with NOTHING booked today, minting one if the seeded pool is dry.
 *
 * Verbatim counterpart of `pickOrMintFreeDriver` in
 * `src/modules/delivery/test-support/live-db.ts` — see that file for the full
 * reasoning. Short version: the seed ships two active drivers and books one of
 * them for `now`; these suites commit real Surat Jalan rows for today and
 * never release them, so FR-LOG's "one driver takes ONE truck type per day"
 * rule eventually rejects the first test in the file. Duplicated rather than
 * shared because these two fixture harnesses already duplicate their whole
 * two-pool setup on purpose (a cross-kernel suite must not import a module's
 * private test-support).
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

  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (username, name, password_hash, role_id, tenant_id)
     SELECT $1, 'Test fixture driver', u.password_hash, r.id, app_the_only_tenant()
       FROM roles r JOIN users u ON u.role_id = r.id
      WHERE r.key = 'driver' LIMIT 1
     RETURNING id`,
    [`zztest_driver_${randomUUID().slice(0, 8)}`],
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

export function getOwnerPool(): Pool {
  ownerPool ??= new Pool({ connectionString: OWNER_URL, max: 5 });
  return ownerPool;
}

/** The pool every service call under test runs against — same identity (`mimi_app`) as production `DATABASE_POOL`. */
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

export interface RlsCtx {
  role: string;
  userId: string;
  locationIds: readonly string[];
}

/**
 * Every module service in this codebase self-commits (`db-tx.ts`'s
 * `withWrite` convention — ONE HTTP request, ONE COMMIT); this scenario
 * chains SEVERAL such calls across SEVERAL different real roles, so each
 * step gets its OWN connection/transaction, opened with that step's real
 * `app.role`/`app.user_id`/`app.location_ids` — exactly what
 * `RlsContextGuard` would set for that step's real request, never a shared
 * superuser context spanning the whole scenario.
 */
export async function withCommit<T>(
  ctx: RlsCtx,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getAppPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [ctx.userId]);
    await client.query(`SELECT set_config('app.role', $1, true)`, [ctx.role]);
    await client.query(`SELECT set_config('app.tenant_id', app_the_only_tenant()::text, true)`);
    await client.query(`SELECT set_config('app.location_ids', $1, true)`, [
      ctx.locationIds.join(','),
    ]);
    const result = await fn(client);
    await client.query('COMMIT').catch(() => {}); // no-op NOTICE if `fn` already committed
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Read-only verification queries under a specific role — never used to drive a mutation. */
export async function withRollback<T>(
  ctx: RlsCtx,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getAppPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [ctx.userId]);
    await client.query(`SELECT set_config('app.role', $1, true)`, [ctx.role]);
    await client.query(`SELECT set_config('app.tenant_id', app_the_only_tenant()::text, true)`);
    await client.query(`SELECT set_config('app.location_ids', $1, true)`, [
      ctx.locationIds.join(','),
    ]);
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

export interface ScenarioFixtures {
  warehouseId: string;
  outletId: string;
  freezerAreaWarehouse: string;
  freezerAreaOutlet: string;
  frozenItemId: string;
  frozenItemUnitId: string;
  frozenVehicleId: string;
  driverId: string;
  driverUserId: string;
  leaderOutletUserId: string;
  supervisorUserId: string;
  kepalaGudangUserId: string;
  ownerUserId: string;
  managerUserId: string;
}

/** Reads real seeded rows over the OWNER pool — never inserts master data; reads are harmless regardless of connection identity. */
export async function loadFixtures(): Promise<ScenarioFixtures> {
  const pool = getOwnerPool();

  const warehouse = await pool.query<{ id: string }>(
    `SELECT id FROM locations WHERE type = 'warehouse' AND is_active = true ORDER BY created_at ASC LIMIT 1`,
  );
  const outlet = await pool.query<{ id: string }>(
    `SELECT id FROM locations WHERE type = 'outlet' AND is_active = true ORDER BY code ASC LIMIT 1`,
  );
  const warehouseId = warehouse.rows[0]!.id;
  const outletId = outlet.rows[0]!.id;

  const areaFor = async (locationId: string): Promise<string> => {
    const res = await pool.query<{ id: string }>(
      `SELECT id FROM storage_areas WHERE location_id = $1 AND type = 'freezer' AND is_active = true LIMIT 1`,
      [locationId],
    );
    if (!res.rows[0])
      throw new Error(`Seed is missing a 'freezer' storage area at location ${locationId}`);
    return res.rows[0].id;
  };

  const frozenItem = await pool.query<{ id: string; base_unit_id: string }>(
    `SELECT id, base_unit_id FROM items WHERE storage_type = 'frozen' AND is_active = true LIMIT 1`,
  );
  if (!frozenItem.rows[0]) throw new Error(`Seed data is missing a 'frozen' item`);

  const driver = { rows: [await pickOrMintFreeDriver(pool)] };
  if (!driver.rows[0])
    throw new Error(`Seed data is missing an active driver with a linked user_id`);

  const frozenVehicle = await pool.query<{ id: string }>(
    `SELECT id FROM vehicles WHERE has_freezer = true AND is_active = true LIMIT 1`,
  );
  if (!frozenVehicle.rows[0]) throw new Error(`Seed data is missing a freezer-capable vehicle`);

  const userAssignedTo = async (roleKey: string, locationId: string): Promise<string> => {
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
        ORDER BY array_position($1::text[], r.key), u.username
        LIMIT 1`,
      [wanted, locationId],
    );
    if (!res.rows[0])
      throw new Error(
        `No user with role '${roleKey}' (or an outlet-floor stand-in) assigned to location ${locationId}`,
      );
    return res.rows[0].id;
  };

  const centralUser = async (roleKey: string): Promise<string> => {
    const res = await pool.query<{ id: string }>(
      `SELECT u.id FROM users u
         JOIN roles r ON r.id = u.role_id
        WHERE r.key = ANY($1::text[])
        ORDER BY array_position($1::text[], r.key),
                   EXISTS (SELECT 1 FROM user_locations ul WHERE ul.user_id = u.id),
                   u.username
        LIMIT 1`,
      [roleKey === 'leader_outlet' ? ['koki', 'kasir'] : [roleKey]],
    );
    if (!res.rows[0]) throw new Error(`Seed data is missing a user with role '${roleKey}'`);
    return res.rows[0].id;
  };

  // kepala_gudang: this system has exactly one warehouse (D-... see migration 209's own header) —
  // any seeded KGD user qualifies, its location assignment (if any) is irrelevant to this scenario
  // because `app_is_fulfilment_role()` is what grants it cross-location visibility, not `user_locations`.
  const kgd = await pool.query<{ id: string }>(
    `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.key = 'kepala_gudang' LIMIT 1`,
  );
  if (!kgd.rows[0]) throw new Error(`Seed data is missing a 'kepala_gudang' user`);

  return {
    warehouseId,
    outletId,
    freezerAreaWarehouse: await areaFor(warehouseId),
    freezerAreaOutlet: await areaFor(outletId),
    frozenItemId: frozenItem.rows[0].id,
    frozenItemUnitId: frozenItem.rows[0].base_unit_id,
    frozenVehicleId: frozenVehicle.rows[0].id,
    driverId: driver.rows[0].id,
    driverUserId: driver.rows[0].user_id,
    leaderOutletUserId: await userAssignedTo('leader_outlet', outletId),
    supervisorUserId: await userAssignedTo('supervisor', outletId),
    kepalaGudangUserId: kgd.rows[0].id,
    ownerUserId: await centralUser('owner'),
    managerUserId: await centralUser('manager'),
  };
}

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
