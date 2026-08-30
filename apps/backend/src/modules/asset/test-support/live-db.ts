import { Pool, type PoolClient } from 'pg';
import { RoleKey } from '@mimi/shared';
import { pgDateToIso } from '../pg-date.util';

/**
 * Live-DB integration harness for M16 `asset` — copies the two-pool pattern
 * from `kernel/approvals/test-support/live-db.ts` (per this ticket's
 * instruction) rather than inventing a third variant. See that file's doc
 * comment for the full two-pool rationale (D-21/D-22).
 *
 *  - `getOwnerPool()` — `DATABASE_MIGRATION_URL` (superuser, `BYPASSRLS`).
 *    Fixture setup/teardown ONLY: reading seeded users/locations, and
 *    inserting/deleting the real `assets` row this suite needs (`assets`
 *    carries RLS — a test's own rolled-back app-pool transaction can create
 *    one for the DURATION of that one test, but the lifecycle spec below
 *    needs a durable asset visible across several separate
 *    `withRollbackAs` calls, hence `createAsset`/`deleteAsset` over the
 *    owner pool, matching `createWasteRecord`/`deleteWasteRecord`'s shape).
 *  - `getAppPool()` — `DATABASE_URL` (the `mimi_app` runtime identity).
 *    Every `AssetsService`/`SchedulesService`/`JobsService` call in the
 *    integration suite runs against a `PoolClient` from THIS pool with the
 *    exact `SET LOCAL ROLE app_user` + `set_config(...)` sequence
 *    `RlsContextGuard` issues per real request.
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
function getOwnerPool(): Pool {
  ownerPool ??= new Pool({ connectionString: OWNER_URL, max: 5 });
  return ownerPool;
}

/** The pool the code under test runs against — same identity (`mimi_app`) as production `DATABASE_POOL`. */
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

export interface RlsSessionContext {
  role: string;
  userId: string;
  locationIds: readonly string[];
}

/** Runs `fn` against a fresh `mimi_app` connection under a CALLER-CHOSEN RLS session, always rolled back. */
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

export interface Fixtures {
  warehouseId: string;
  outletId: string;
  outletBId: string;
  usersByRole: Record<RoleKey, string>;
}

/** Reads real seeded rows over the OWNER pool — never inserts master data (W1-C's territory). */
export async function loadFixtures(): Promise<Fixtures> {
  const pool = getOwnerPool();
  const warehouse = await pool.query<{ id: string }>(
    `SELECT id FROM locations WHERE type = 'warehouse' LIMIT 1`,
  );
  const outlets = await pool.query<{ id: string }>(
    `SELECT id FROM locations WHERE type = 'outlet' ORDER BY id LIMIT 2`,
  );
  if (!outlets.rows[0] || !outlets.rows[1]) {
    throw new Error('Seed data needs at least two outlets for the cross-location RLS proof.');
  }

  const usersByRole = {} as Record<RoleKey, string>;
  for (const roleKey of Object.values(RoleKey)) {
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
    if (res.rows[0]) usersByRole[roleKey] = res.rows[0].id;
  }

  return {
    warehouseId: warehouse.rows[0]!.id,
    outletId: outlets.rows[0]!.id,
    outletBId: outlets.rows[1]!.id,
    usersByRole,
  };
}

let seq = 0;
function nextNumber(prefix: string): string {
  seq += 1;
  return `${prefix}-TEST-${Date.now()}-${seq}`;
}

/** A real, committed `assets` row (RLS-scoped — needs the owner/`BYPASSRLS` pool to insert regardless of caller role) at `locationId`, used as a durable fixture across several separate `withRollbackAs` calls. */
export async function createAsset(locationId: string): Promise<string> {
  const res = await getOwnerPool().query<{ id: string }>(
    `INSERT INTO assets (asset_number, name, category, location_id, condition, status)
     VALUES ($1, 'Test Chiller', 'equipment', $2, 'fair', 'active')
     RETURNING id`,
    [nextNumber('AST'), locationId],
  );
  return res.rows[0]!.id;
}

export async function deleteAsset(id: string): Promise<void> {
  await getOwnerPool().query(`DELETE FROM service_history WHERE asset_id = $1`, [id]);
  await getOwnerPool().query(`DELETE FROM maintenance_jobs WHERE asset_id = $1`, [id]);
  await getOwnerPool().query(`DELETE FROM maintenance_schedules WHERE asset_id = $1`, [id]);
  await getOwnerPool().query(`DELETE FROM assets WHERE id = $1`, [id]);
}

/**
 * A real, committed `attachments` row (no RLS — API-gated only) standing in
 * for an already-uploaded/confirmed proof photo (FR-PMS-04's wajib bukti
 * servis). Never a real S3 object — `StorageService.getUrl()` only needs the
 * DB row to PRESIGN a GET (a local, no-network computation), never to
 * actually fetch bytes, so a fake `object_key` is sufficient for this
 * suite's purposes.
 */
export async function createAttachment(uploadedBy: string): Promise<string> {
  const res = await getOwnerPool().query<{ id: string }>(
    `INSERT INTO attachments (bucket, object_key, file_name, mime_type, size_bytes, kind, uploaded_by)
     VALUES ('mimi-test', $1, 'proof.jpg', 'image/jpeg', 1024, 'service_proof', $2)
     RETURNING id`,
    [`test/${nextNumber('ATT')}.jpg`, uploadedBy],
  );
  return res.rows[0]!.id;
}

export async function deleteAttachment(id: string): Promise<void> {
  await getOwnerPool().query(`DELETE FROM attachments WHERE id = $1`, [id]);
}

/** Cleans up any `payment_verifications` row a completed job's cost>0 path opened (FR-ACCT-04) — not covered by `deleteAsset`/`deleteAttachment`. */
export async function deletePaymentVerificationsForRef(refId: string): Promise<void> {
  await getOwnerPool().query(`DELETE FROM payment_verifications WHERE ref_id = $1`, [refId]);
}

/** Exposes the APP pool's connection string for tests that construct a full service graph (`Pool`-taking repositories/channels) rather than just calling `withRollbackAs`. */
export function appConnectionString(): string {
  return APP_URL;
}

/**
 * The Postgres session's own `CURRENT_DATE` — NOT `new Date().toISOString()`
 * (JS's UTC date, which is NOT guaranteed to match the DB server's
 * `TimeZone` GUC's notion of "today"; `complete()`/the sweep both compute
 * dates via `CURRENT_DATE` server-side). A test asserting against a
 * schedule's server-computed `last_done_at`/`next_due_at` must anchor "today"
 * to the SAME source those columns use, or it can flake by exactly one day
 * depending on the real-world UTC time-of-day a run happens to execute at.
 */
export async function serverToday(): Promise<string> {
  const res = await getOwnerPool().query<{ today: Date }>(`SELECT CURRENT_DATE AS today`);
  return pgDateToIso(res.rows[0]!.today);
}
