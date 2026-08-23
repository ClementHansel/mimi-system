/**
 * Live-DB test harness for `purchasing.integration.spec.ts` — same
 * two-pool shape as `kernel/approvals/test-support/live-db.ts` and
 * `modules/stock-opname/test-support/live-db.ts` (D-21/D-22): a shared
 * superuser connection is exactly how RLS got silently bypassed once.
 * `withRollbackAs` asserts a CALLER-CHOSEN `app.role`/`app.user_id`/
 * `app.location_ids` so a test genuinely exercises a scoped role's own
 * RLS-restricted session, not merely `'owner'`'s central bypass.
 */
import { Pool, type PoolClient } from 'pg';
import { RoleKey } from '@mimi/shared';

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

function getAppPool(): Pool {
  appPool ??= new Pool({ connectionString: APP_URL, max: 5 });
  return appPool;
}

/** For manually wiring `SyncEventsRepository`'s `@Inject(DATABASE_POOL)` constructor arg in tests — every call in this suite passes an explicit `client`, so the pool itself is never actually queried directly, only required to exist. */
export function appPoolForDi(): Pool {
  return getAppPool();
}

export async function closePool(): Promise<void> {
  await ownerPool?.end();
  await appPool?.end();
  ownerPool = undefined;
  appPool = undefined;
}

export interface RlsSessionContext {
  role: string;
  userId: string;
  locationIds: readonly string[];
}

export async function setSessionContext(client: PoolClient, ctx: RlsSessionContext): Promise<void> {
  await client.query(`SELECT set_config('app.user_id', $1, true)`, [ctx.userId]);
  await client.query(`SELECT set_config('app.role', $1, true)`, [ctx.role]);
  await client.query(`SELECT set_config('app.location_ids', $1, true)`, [
    ctx.locationIds.join(','),
  ]);
}

export async function withRollbackAs<T>(
  ctx: RlsSessionContext,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getAppPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await setSessionContext(client, ctx);
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

const SYSTEM_CONTEXT_USER_ID = '00000000-0000-0000-0000-0000000000aa';

export async function withRollback<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return withRollbackAs({ role: 'owner', userId: SYSTEM_CONTEXT_USER_ID, locationIds: [] }, fn);
}

export interface Fixtures {
  warehouseId: string;
  kepalaGudangUserId: string;
  storageAreaWarehouse: string;
  outletId: string;
  supervisorUserId: string;
  leaderOutletUserId: string;
  storageAreaOutlet: string;
  itemId: string;
  unitId: string;
  supplierId: string;
  usersByRole: Record<RoleKey, string>;
}

export async function loadFixtures(): Promise<Fixtures> {
  const pool = getOwnerPool();

  const kgd = await pool.query<{ user_id: string; location_id: string }>(
    `SELECT ul.user_id, ul.location_id FROM user_locations ul JOIN users u ON u.id = ul.user_id JOIN roles r ON r.id = u.role_id WHERE r.key = 'kepala_gudang' LIMIT 1`,
  );
  if (!kgd.rows[0])
    throw new Error('loadFixtures: no kepala_gudang with a user_locations assignment in the seed');

  const pair = await pool.query<{ supervisor_id: string; leader_id: string; location_id: string }>(
    `SELECT spv.user_id AS supervisor_id, ldr.user_id AS leader_id, spv.location_id
       FROM user_locations spv
       JOIN users spv_u ON spv_u.id = spv.user_id
       JOIN roles spv_r ON spv_r.id = spv_u.role_id AND spv_r.key = 'supervisor'
       JOIN user_locations ldr ON ldr.location_id = spv.location_id
       JOIN users ldr_u ON ldr_u.id = ldr.user_id
       JOIN roles ldr_r ON ldr_r.id = ldr_u.role_id
      -- "an outlet floor worker who is not the supervisor", by preference rather
      -- than by role NAME. The specs that use this id supply the acting role
      -- themselves ("callerFor(..., RoleKey.LEADER_OUTLET, ...)"), so what the
      -- fixture owes them is a real user at the same outlet — not a particular
      -- role in the database.
      --
      -- It used to demand "leader_outlet", and broke the moment the org was
      -- reshaped into per-shift crews: the owner's model is supervisor + cashier
      -- + 2 cooks, so nobody holds "leader_outlet" any more and four fixtures
      -- failed against a perfectly valid database. Preference order keeps the
      -- old choice when it is still available, so nothing changes on a database
      -- seeded the old way.
      WHERE ldr_r.key IN ('leader_outlet', 'koki', 'kasir')
        AND ldr.user_id <> spv.user_id
      ORDER BY CASE ldr_r.key
                 WHEN 'leader_outlet' THEN 0
                 WHEN 'koki' THEN 1
                 ELSE 2
               END, ldr_u.username
      LIMIT 1`,
  );
  if (!pair.rows[0])
    throw new Error(
      'loadFixtures: no (supervisor, outlet-floor staffer) pair sharing one outlet in the seed',
    );

  const storageOutlet = await pool.query<{ id: string }>(
    `SELECT id FROM storage_areas WHERE location_id = $1 LIMIT 1`,
    [pair.rows[0].location_id],
  );
  const storageWarehouse = await pool.query<{ id: string }>(
    `SELECT id FROM storage_areas WHERE location_id = $1 LIMIT 1`,
    [kgd.rows[0].location_id],
  );
  const item = await pool.query<{ id: string }>(`SELECT id FROM items LIMIT 1`);
  const unit = await pool.query<{ id: string }>(`SELECT base_unit_id AS id FROM items LIMIT 1`);
  const supplier = await pool.query<{ id: string }>(`SELECT id FROM suppliers LIMIT 1`);

  // One representative user per role, and a role with NOBODY IN IT is skipped
  // rather than fatal.
  //
  // It used to throw, which made every fixture in this file depend on the seed
  // staffing all eleven roles. That broke the moment the org was reshaped into
  // the crews the business actually runs (supervisor + cashier + 2 cooks): no
  // employee holds `leader_outlet` any more, and eighteen spec files failed in
  // `beforeAll` against a database that was entirely valid.
  //
  // A spec that genuinely needs a given role now fails at the point of USE, on
  // the role it actually wanted, instead of every spec failing on the first
  // unstaffed role in enum order.
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
    if (!res.rows[0]) continue;
    usersByRole[roleKey] = res.rows[0].id;
  }

  return {
    warehouseId: kgd.rows[0].location_id,
    kepalaGudangUserId: kgd.rows[0].user_id,
    storageAreaWarehouse: storageWarehouse.rows[0]!.id,
    outletId: pair.rows[0].location_id,
    supervisorUserId: pair.rows[0].supervisor_id,
    leaderOutletUserId: pair.rows[0].leader_id,
    storageAreaOutlet: storageOutlet.rows[0]!.id,
    itemId: item.rows[0]!.id,
    unitId: unit.rows[0]!.id,
    supplierId: supplier.rows[0]!.id,
    usersByRole,
  };
}

let attachmentSeq = 0;

/** A minimal, real `attachments` row (FK target for `photoAttachmentIds`/proof ids) — committed on the owner pool so it's visible to the SEPARATE app-pool transaction under test, and cleaned up after. */
export async function createAttachment(uploadedBy: string, kind = 'test_photo'): Promise<string> {
  attachmentSeq += 1;
  const res = await getOwnerPool().query<{ id: string }>(
    `INSERT INTO attachments (object_key, file_name, mime_type, size_bytes, kind, uploaded_by)
     VALUES ($1,$2,'image/jpeg',1024,$3,$4) RETURNING id`,
    [`test/${Date.now()}-${attachmentSeq}`, `test-${attachmentSeq}.jpg`, kind, uploadedBy],
  );
  return res.rows[0]!.id;
}

export async function deleteAttachment(id: string): Promise<void> {
  await getOwnerPool().query(`DELETE FROM attachments WHERE id = $1`, [id]);
}
