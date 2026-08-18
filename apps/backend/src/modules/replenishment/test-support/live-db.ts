import { Pool, type PoolClient } from 'pg';
import { RoleKey } from '@mimi/shared';

/**
 * Live-DB harness for the M09 integration suite — copied from
 * `kernel/approvals/test-support/live-db.ts` (this ticket's explicit
 * instruction) and adapted in ONE way: `withRollback` here takes the REAL
 * `(userId, roleKey, locationIds)` the test wants asserted for THIS
 * transaction, instead of hard-coding `role='owner'`. The kernel harness can
 * get away with a fixed central context because `approvals`/`approval_steps`
 * carry no RLS at all (migration 009's own comment: "table grants above
 * already cover app_user access") — every scoping check that matters for
 * THOSE tests happens inside `ApprovalService` itself, not at the row level.
 * `replenishment_requests`/`replenishment_request_lines` are the opposite:
 * `FORCE`d, location-scoped RLS (migration 037) IS the thing under test here
 * (a Supervisor must see their own outlet's request and NOT another
 * outlet's; a negatively-tested Kasir must see neither) — a harness that
 * always asserts `owner` would silently paper over exactly the RBAC/RLS
 * behaviour this suite exists to prove, the "27 passing tests that never
 * touched Postgres" failure mode in miniature.
 *
 * TWO POOLS, DELIBERATELY (D-21/D-22 — see the kernel file's own header for
 * the fuller incident history): `getOwnerPool()` for fixture setup/teardown
 * ONLY (never runs code under test); `getAppPool()` is the SAME connection
 * IDENTITY (`mimi_app`, NOINHERIT into `app_user`) `DATABASE_POOL` uses in
 * production. Every `ReplenishmentService`/`ReplenishmentAdvancementService`
 * call in this suite runs on an app-pool `PoolClient`, through the identical
 * `SET LOCAL ROLE app_user` + `set_config(...)` sequence `RlsContextGuard`
 * issues per real request — never a hand-built approximation of it.
 *
 * IMPORTANT — UNLIKE `kernel/approvals`'s harness, `ReplenishmentService`'s
 * mutating methods SELF-COMMIT (the "AIRE/inventory convention", matching
 * `modules/location`'s `db-tx.ts` `withWrite()` helper — see
 * `replenishment.service.ts`'s own class header for why building the
 * response before that `COMMIT` is mandatory here, not optional). That means
 * `withRollback`'s trailing `ROLLBACK` is a no-op the INSTANT a mutating
 * call runs inside it — the row really persists. Every integration test
 * that creates a request tracks its id and cleans it up via
 * `cleanupReplenishmentRequests()` below (owner pool) — never assume a
 * `withRollback` block alone undoes a `ReplenishmentService` mutation.
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

/** Fixture setup/teardown ONLY — never construct `ReplenishmentService`/`ReplenishmentRepository` against this pool. */
function getOwnerPool(): Pool {
  ownerPool ??= new Pool({ connectionString: OWNER_URL, max: 5 });
  return ownerPool;
}

/** The pool the code under test runs against — same identity (`mimi_app`) as production `DATABASE_POOL`. */
function getAppPool(): Pool {
  appPool ??= new Pool({ connectionString: APP_URL, max: 5 });
  return appPool;
}

/** For manually wiring `SyncEventsRepository`'s `@Inject(DATABASE_POOL)` constructor arg in tests — every call in this suite passes an explicit `client`, so the pool itself is never actually queried through directly, only required to exist (mirrors `stock-opname`'s identical helper). */
export function appPoolForDi(): Pool {
  return getAppPool();
}

/**
 * Exposed for the ONE test that needs a row durable across two SEPARATE
 * `withRollback` sessions (each of which always rolls back at the end of
 * its own block, by design) — proving a cross-session RLS predicate (does
 * Supervisor B see Supervisor A's outlet's row) needs the row to still
 * exist when the SECOND session opens its own connection. Every such test
 * MUST clean up its own durably-inserted row in a `finally` — this harness
 * does not do it automatically, unlike `withRollback`'s guaranteed undo.
 */
export function getOwnerPoolForTest(): Pool {
  return getOwnerPool();
}

export async function closePool(): Promise<void> {
  await ownerPool?.end();
  await appPool?.end();
  ownerPool = undefined;
  appPool = undefined;
}

export interface RlsContext {
  userId: string;
  roleKey: string;
  /** `null` = central (no location filter — `app_is_central()`); `[]`/omitted array still filters. */
  locationIds: string[] | null;
}

/**
 * Runs `fn` against a fresh `mimi_app` connection inside a transaction that
 * is ALWAYS rolled back. Asserts the exact session context `RlsContextGuard`
 * asserts per real request (`SET LOCAL ROLE app_user` + `app.role`/
 * `app.user_id`/`app.location_ids`), so every query the code under test
 * issues runs under real, `FORCE`d RLS for the SPECIFIC caller the test
 * names — never the owner pool's `BYPASSRLS`, never a fixed central role
 * hiding a scoping bug.
 */
export async function withRollback<T>(
  context: RlsContext,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getAppPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [context.userId]);
    await client.query(`SELECT set_config('app.role', $1, true)`, [context.roleKey]);
    await client.query(`SELECT set_config('app.location_ids', $1, true)`, [
      context.locationIds === null ? '' : context.locationIds.join(','),
    ]);
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

export interface OutletFixture {
  locationId: string;
  leaderUserId: string;
  supervisorUserId: string;
}

export interface Fixtures {
  warehouseId: string;
  outletA: OutletFixture;
  outletB: OutletFixture;
  kepalaGudangUserId: string;
  ownerUserId: string;
  managerUserId: string;
  kasirUserId: string;
  itemId: string;
  itemId2: string;
  unitId: string;
}

export async function loadFixtures(): Promise<Fixtures> {
  const pool = getOwnerPool();

  const warehouse = await pool.query<{ id: string }>(
    `SELECT id FROM locations WHERE type = 'warehouse' LIMIT 1`,
  );
  const items = await pool.query<{ id: string }>(`SELECT id FROM items ORDER BY sku LIMIT 2`);
  const unit = await pool.query<{ id: string }>(`SELECT id FROM units LIMIT 1`);

  const outletsRes = await pool.query<{ location_id: string; role_key: string; user_id: string }>(
    `SELECT ul.location_id, r.key AS role_key, u.id AS user_id
       FROM user_locations ul
       JOIN users u ON u.id = ul.user_id AND u.is_active
       JOIN roles r ON r.id = u.role_id
       JOIN locations l ON l.id = ul.location_id AND l.type = 'outlet'
      WHERE r.key IN ('leader_outlet', 'supervisor')`,
  );
  const byLocation = new Map<string, Map<string, string>>();
  for (const row of outletsRes.rows) {
    const bucket = byLocation.get(row.location_id) ?? new Map<string, string>();
    bucket.set(row.role_key, row.user_id);
    byLocation.set(row.location_id, bucket);
  }
  const qualifying = [...byLocation.entries()].filter(
    ([, roles]) => roles.has(RoleKey.LEADER_OUTLET) && roles.has(RoleKey.SUPERVISOR),
  );
  if (qualifying.length < 2) {
    throw new Error(
      `Seed data needs at least 2 outlets each with a leader_outlet AND a supervisor user assigned — found ${qualifying.length}. Fixtures require the full seed to have run.`,
    );
  }
  const [locA, rolesA] = qualifying[0]!;
  const [locB, rolesB] = qualifying[1]!;

  const userByRole = async (roleKey: string): Promise<string> => {
    const res = await pool.query<{ id: string }>(
      `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.key = $1 AND u.is_active LIMIT 1`,
      [roleKey],
    );
    if (!res.rows[0])
      throw new Error(`Seed data is missing an active user with role '${roleKey}'.`);
    return res.rows[0].id;
  };

  return {
    warehouseId: warehouse.rows[0]!.id,
    outletA: {
      locationId: locA,
      leaderUserId: rolesA.get(RoleKey.LEADER_OUTLET)!,
      supervisorUserId: rolesA.get(RoleKey.SUPERVISOR)!,
    },
    outletB: {
      locationId: locB,
      leaderUserId: rolesB.get(RoleKey.LEADER_OUTLET)!,
      supervisorUserId: rolesB.get(RoleKey.SUPERVISOR)!,
    },
    kepalaGudangUserId: await userByRole(RoleKey.KEPALA_GUDANG),
    ownerUserId: await userByRole(RoleKey.OWNER),
    managerUserId: await userByRole(RoleKey.MANAGER),
    kasirUserId: await userByRole(RoleKey.KASIR),
    itemId: items.rows[0]!.id,
    itemId2: items.rows[1]!.id,
    unitId: unit.rows[0]!.id,
  };
}

/**
 * Cleans up everything a `ReplenishmentService`/`ReplenishmentAdvancementService`
 * call durably wrote for the given request ids (see the class header re:
 * self-commit): the kernel `approvals`/`approval_steps` rows (no FK back to
 * `replenishment_requests` — D-08's chain bookkeeping is generic across 12
 * document types, so this is a `document_type`/`document_id` match, not a
 * cascade), the `sync_events` rows `SyncEmitService` inserted, and finally
 * `replenishment_requests` itself (`replenishment_request_lines` cascades).
 * Run via the OWNER pool — cleanup is a test-harness concern, not code under
 * test, and must work regardless of which RLS-scoped session wrote the row.
 */
export async function cleanupReplenishmentRequests(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const pool = getOwnerPool();
  await pool.query(
    `DELETE FROM approval_steps WHERE approval_id IN (
       SELECT id FROM approvals WHERE document_type = 'replenishment_request' AND document_id = ANY($1::uuid[])
     )`,
    [ids],
  );
  await pool.query(
    `DELETE FROM approvals WHERE document_type = 'replenishment_request' AND document_id = ANY($1::uuid[])`,
    [ids],
  );
  await pool.query(
    `DELETE FROM sync_events WHERE entity = 'replenishment_requests' AND entity_id = ANY($1::uuid[])`,
    [ids],
  );
  await pool.query(`DELETE FROM replenishment_requests WHERE id = ANY($1::uuid[])`, [ids]);
}

/**
 * A minimal, real `surat_jalan` row (M10's own table — `replenishment_requests.sj_id` FK-references it,
 * so a test exercising `linkSuratJalan`/`markShipped` cannot use a bare random UUID). Everything beyond
 * the FK target is a placeholder; the SJ lifecycle itself is M10's territory, not this module's. Durable
 * via the OWNER pool (bypasses RLS) — always paired with `deleteSuratJalan` in the caller's `finally`.
 */
export async function createSuratJalanFixture(
  originLocationId: string,
  createdBy: string,
): Promise<string> {
  const pool = getOwnerPool();
  const shipmentType = await pool.query<{ id: string }>(`SELECT id FROM shipment_types LIMIT 1`);
  const driver = await pool.query<{ id: string }>(`SELECT id FROM drivers LIMIT 1`);
  const vehicle = await pool.query<{ id: string }>(`SELECT id FROM vehicles LIMIT 1`);
  if (!shipmentType.rows[0] || !driver.rows[0] || !vehicle.rows[0]) {
    throw new Error(
      'createSuratJalanFixture: seed data is missing shipment_types/drivers/vehicles rows.',
    );
  }
  const res = await pool.query<{ id: string }>(
    `INSERT INTO surat_jalan (sj_number, origin_location_id, shipment_type_id, driver_id, vehicle_id, status, planned_date, created_by)
     VALUES ($1, $2, $3, $4, $5, 'draft', CURRENT_DATE, $6)
     RETURNING id`,
    [
      `SJ-TEST-${Date.now()}`,
      originLocationId,
      shipmentType.rows[0].id,
      driver.rows[0].id,
      vehicle.rows[0].id,
      createdBy,
    ],
  );
  return res.rows[0]!.id;
}

export async function deleteSuratJalanFixture(id: string): Promise<void> {
  await getOwnerPool().query(`DELETE FROM surat_jalan WHERE id = $1`, [id]);
}
