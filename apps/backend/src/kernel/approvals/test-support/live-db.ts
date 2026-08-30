import { Pool, type PoolClient } from 'pg';
import { RoleKey } from '@mimi/shared';
import { ApprovalService } from '../approvals.service';
import { ApprovalsRepository } from '../approvals.repository';
import { NotificationService } from '../../notification/notification.service';
import { InAppChannelService } from '../../notification/channels/in-app-channel.service';
import { EmailChannelService } from '../../notification/channels/email-channel.service';
import { WhatsAppChannelService } from '../../notification/channels/whatsapp-channel.service';
import { NotificationOutboxRepository } from '../../notification/channels/notification-outbox.repository';
import type { NotificationGateway } from '../../notification/notification.gateway';

/**
 * Live-DB test harness for the integration suite (BUILD-PLAN W2-B brief:
 * "Integration tests against the live DB for every one of the 12 document
 * types' chains").
 *
 * TWO POOLS, DELIBERATELY (D-21/D-22 — matching W2-D's
 * `kernel/sync/test-support/live-db.ts` and W1-D's
 * `common/database/database.module.ts` boot check, not a pattern invented
 * here): a single shared superuser connection string is exactly how RLS got
 * silently bypassed once (BUILD-PLAN D-22 incident — a Kasir context saw
 * every location's rows instead of its own).
 *
 *  - `getOwnerPool()` — `DATABASE_MIGRATION_URL` (Postgres superuser,
 *    `BYPASSRLS`). FIXTURE SETUP/TEARDOWN ONLY: reading seeded users/
 *    locations/items/suppliers, inserting/deleting a test `stock_opname` /
 *    `waste_records` / `returns` / `offline_credentials` row. These are
 *    test-harness concerns, not the code under test.
 *  - `getAppPool()` — `DATABASE_URL` (the runtime `mimi_app` role — the SAME
 *    connection identity `DATABASE_POOL` uses in production, D-22). Every
 *    `ApprovalService`/`ApprovalsRepository` call in the integration suite
 *    runs against a `PoolClient` from THIS pool, so the suite exercises the
 *    REAL RLS-enforced path (`stock_opname`/`waste_records`/`returns` are
 *    `FORCE`d, location-scoped RLS tables `document-context.resolver.ts`
 *    reads across) — not a superuser bypass wearing a test's clothing.
 *    `mimi_app` is `NOINHERIT` into `app_user` (D-21/D-22): `withRollback`
 *    issues the identical `SET LOCAL ROLE app_user` + `set_config(...)`
 *    sequence `RlsContextGuard` issues for every real request (see that
 *    file) — reproducing production's own session setup, not a shortcut
 *    around it. The two-pool split is what keeps that legitimate: fixture
 *    rows in tables this agent does not own are written by the SEPARATE
 *    owner connection, committed durably (a different Postgres backend
 *    cannot see another backend's uncommitted rows), and explicitly cleaned
 *    up — `withRollback`'s ROLLBACK only ever undoes the code-under-test's
 *    OWN writes (`approvals`/`approval_steps`/`settings`).
 *
 * Central role ('owner') is asserted for the app-pool transaction's RLS
 * context so fixtures spanning multiple locations (an outlet's opname vs a
 * warehouse's) are visible in one test run without narrowing to one
 * location — the identical choice `kernel/stock-ledger`'s harness makes,
 * for the identical reason. This still runs mechanically under RLS/`app_user`
 * (Postgres evaluates `app_has_location(...) OR app_is_central()` on every
 * row for a real, non-superuser role) — it is not a `BYPASSRLS` shortcut.
 * `getPending()`'s OWN role/location scoping (SUPERVISOR at outlet A vs
 * outlet B) is exercised by passing different `CallerScope`s into the
 * service call, independent of this session-level RLS role.
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

/** Fixture setup/teardown ONLY — never construct `ApprovalService`/`ApprovalsRepository` against this pool. */
/**
 * Exported for B-15's lockout suite, which must read state COMMITTED by
 * another connection (`recordFailure` deliberately owns its own transaction).
 * Fixture-side only — never the code under test.
 */
export function getOwnerPool(): Pool {
  ownerPool ??= new Pool({ connectionString: OWNER_URL, max: 5 });
  return ownerPool;
}

/**
 * The pool the code under test runs against — same identity (`mimi_app`) as
 * production `DATABASE_POOL`. Exported (B-07) so
 * `approvals.integration.spec.ts` can hand the SAME pool to a real
 * `NotificationService` — `ApprovalService`'s notify hooks resolve
 * recipients and write notification rows on their OWN connection (never the
 * caller's `DbClient` — see `notification-recipients.ts`), so proving B-07
 * against the live DB means wiring a real `NotificationService` against this
 * exact pool, not a second, disconnected one.
 */
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

/** A fixed, valid-UUID sentinel actor for the RLS session context — no real user row needs to exist for it (nothing here relies on `app.user_id` resolving to an actual `users` row; `approval_steps.acted_by` etc. always use real fixture user ids). */
const SYSTEM_CONTEXT_USER_ID = '00000000-0000-0000-0000-0000000000aa';

/**
 * Runs `fn` against a fresh `mimi_app` connection, inside a transaction that
 * is ALWAYS rolled back — the code under test's own writes
 * (`approvals`/`approval_steps`/`settings`) never persist. Asserts the SAME
 * `SET LOCAL ROLE app_user` mechanism `RlsContextGuard` asserts per real
 * request, with the session's `app.role` fixed to `'owner'` (a CENTRAL
 * role — see `app_is_central()`, migration 009) so fixtures spanning
 * multiple locations (an outlet's opname vs a warehouse's) are visible in
 * one test run.
 *
 * HONEST LIMIT, found the hard way (coordinator-flagged incident): `'owner'`
 * being central means every RLS predicate this session hits — including
 * `app_has_location()` on `stock_opname`/`waste_records`/`returns` AND
 * `users_select`'s `app_is_central() OR app_is_self(id)` — takes its CENTRAL
 * bypass arm, never its scoped-role arm. A bug that only manifests for a
 * NON-central role (Supervisor Cabang, Kepala Gudang, Leader Outlet, Kasir,
 * Driver) hitting a table whose policy has no scoped-role grant for what
 * it's trying to read is INVISIBLE to any test run through this function —
 * which is exactly how `findPendingCandidates`' `JOIN users` regression
 * shipped past 71 passing tests: every one of them ran as `'owner'`, which
 * `users_select` grants unconditionally, so the join never had anything to
 * drop. Central-role tests here validate the ENGINE's own logic (chain
 * progression, threshold routing, reason/offline gating); they do NOT stand
 * in for a scoped role's actual RLS-restricted session. Use
 * `withRollbackAs()` below whenever a test's whole point is that a
 * NON-central role's session sees what it should — never simulate that by
 * passing a scoped `roleKey` only into `CallerScope` (an application-level
 * parameter to `getPending()`) while the DB session itself stays `'owner'`;
 * that is precisely the gap that hid this bug.
 */
export async function withRollback<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return withRollbackAs({ role: 'owner', userId: SYSTEM_CONTEXT_USER_ID, locationIds: [] }, fn);
}

export interface RlsSessionContext {
  /** A `RoleKey` string value, or `'owner'`/etc. — whatever `app.role` a real request would carry. */
  role: string;
  userId: string;
  /** `[]` = unrestricted for central roles; for a scoped role this MUST be the location(s) that role is actually assigned, or `app_has_location()` legitimately denies everything. */
  locationIds: readonly string[];
}

/**
 * Same rolled-back-transaction contract as `withRollback`, but with a
 * CALLER-CHOSEN `app.role`/`app.user_id`/`app.location_ids` — the only way
 * to actually exercise a scoped role's real RLS-restricted session (see
 * `withRollback`'s doc comment for why that distinction matters). Use this
 * for any test whose assertion depends on what a NON-central role's own
 * Postgres session can and cannot see.
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
  storageAreaOutlet: string;
  storageAreaWarehouse: string;
  itemId: string;
  supplierId: string;
  usersByRole: Record<RoleKey, string>;
}

/** Reads real seeded rows (locations/users/items/suppliers/storage_areas) over the OWNER pool — never inserts master data (that is W1-C's territory), and reads are harmless regardless of connection identity. */
export async function loadFixtures(): Promise<Fixtures> {
  const pool = getOwnerPool();
  const warehouse = await pool.query<{ id: string }>(
    `SELECT id FROM locations WHERE type = 'warehouse' LIMIT 1`,
  );
  const outlet = await pool.query<{ id: string }>(
    `SELECT id FROM locations WHERE type = 'outlet' LIMIT 1`,
  );
  const item = await pool.query<{ id: string }>(`SELECT id FROM items LIMIT 1`);
  const supplier = await pool.query<{ id: string }>(`SELECT id FROM suppliers LIMIT 1`);
  const storageOutlet = await pool.query<{ id: string }>(
    `SELECT id FROM storage_areas LIMIT 1 OFFSET 0`,
  );
  const storageWarehouse = await pool.query<{ id: string }>(
    `SELECT id FROM storage_areas LIMIT 1 OFFSET 1`,
  );

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
    itemId: item.rows[0]!.id,
    supplierId: supplier.rows[0]!.id,
    usersByRole,
  };
}

let seq = 0;
function nextNumber(prefix: string): string {
  seq += 1;
  return `${prefix}-TEST-${Date.now()}-${seq}`;
}

// ── Fixture rows in tables this agent does not own — OWNER pool, durably
// committed (so the SEPARATE app-pool transaction under test can see them),
// and always deleted by the matching `deleteX` after the test. ───────────

export async function createStockOpname(locationId: string, countedBy: string): Promise<string> {
  const res = await getOwnerPool().query<{ id: string }>(
    `INSERT INTO stock_opname (opname_number, location_id, status, counted_by)
     VALUES ($1, $2, 'submitted', $3)
     RETURNING id`,
    [nextNumber('OPN'), locationId, countedBy],
  );
  return res.rows[0]!.id;
}

export async function deleteStockOpname(id: string): Promise<void> {
  await getOwnerPool().query(`DELETE FROM stock_opname WHERE id = $1`, [id]);
}

export async function createWasteRecord(
  locationId: string,
  storageAreaId: string,
  itemId: string,
  reportedBy: string,
): Promise<string> {
  const res = await getOwnerPool().query<{ id: string }>(
    `INSERT INTO waste_records (waste_number, batch_id, location_id, storage_area_id, item_id, qty, reason, status, reported_by)
     VALUES ($1, gen_random_uuid(), $2, $3, $4, 1.000, 'expired', 'pending', $5)
     RETURNING id`,
    [nextNumber('WST'), locationId, storageAreaId, itemId, reportedBy],
  );
  return res.rows[0]!.id;
}

export async function deleteWasteRecord(id: string): Promise<void> {
  await getOwnerPool().query(`DELETE FROM waste_records WHERE id = $1`, [id]);
}

export async function createReturnOutletToWarehouse(
  fromLocationId: string,
  toLocationId: string,
  requestedBy: string,
): Promise<string> {
  const res = await getOwnerPool().query<{ id: string }>(
    `INSERT INTO returns (return_number, direction, from_location_id, to_location_id, status, requested_by)
     VALUES ($1, 'outlet_to_warehouse', $2, $3, 'submitted', $4)
     RETURNING id`,
    [nextNumber('RET'), fromLocationId, toLocationId, requestedBy],
  );
  return res.rows[0]!.id;
}

export async function createReturnWarehouseToSupplier(
  fromLocationId: string,
  supplierId: string,
  requestedBy: string,
): Promise<string> {
  const res = await getOwnerPool().query<{ id: string }>(
    `INSERT INTO returns (return_number, direction, from_location_id, supplier_id, status, requested_by)
     VALUES ($1, 'warehouse_to_supplier', $2, $3, 'submitted', $4)
     RETURNING id`,
    [nextNumber('RET'), fromLocationId, supplierId, requestedBy],
  );
  return res.rows[0]!.id;
}

export async function deleteReturn(id: string): Promise<void> {
  await getOwnerPool().query(`DELETE FROM returns WHERE id = $1`, [id]);
}

/**
 * A minimal, real `offline_credentials` row (kernel/sync's table, block
 * 120-129) — `approval_steps.offline_credential_id` FK-references it, so an
 * offline-provisional test cannot use a bare random UUID. Everything beyond
 * the FK target is a placeholder; the actual credential minting/crypto
 * lifecycle is D-17/M01/kernel-sync territory, not this agent's.
 */
export async function createOfflineCredential(
  userId: string,
  roleKey: string,
  locationIds: string[],
): Promise<string> {
  const res = await getOwnerPool().query<{ credential_id: string }>(
    `INSERT INTO offline_credentials (credential_id, user_id, role_key, location_ids, scopes, binding_secret_enc, pin_verifier, expires_at)
     VALUES (gen_random_uuid(), $1, $2, $3::uuid[], '{}'::jsonb, $4, 'test-pin-verifier', NOW() + INTERVAL '24 hours')
     RETURNING credential_id`,
    [userId, roleKey, locationIds, Buffer.from('test-binding-secret')],
  );
  return res.rows[0]!.credential_id;
}

export async function deleteOfflineCredential(credentialId: string): Promise<void> {
  await getOwnerPool().query(`DELETE FROM offline_credentials WHERE credential_id = $1`, [
    credentialId,
  ]);
}

/**
 * B-07 — ensures a fixture user has a phone/email on file so the WhatsApp/
 * email fan-out branches of a real `notify()` call are actually exercised
 * rather than silently skipped (`NotificationService.notify()` logs+skips a
 * channel when the recipient has no contact info for it). `COALESCE` so this
 * never clobbers a real value a fixture user might already have. Runs on the
 * owner pool — this is master-data-adjacent test setup, not code under test.
 */
export async function ensureUserContact(
  userId: string,
  phone: string,
  email: string,
): Promise<void> {
  await getOwnerPool().query(
    `UPDATE users SET phone = COALESCE(phone, $2), email = COALESCE(email, $3) WHERE id = $1`,
    [userId, phone, email],
  );
}

/**
 * B-07 — `loadFixtures()` picks `usersByRole[SUPERVISOR]` and `outletId`
 * independently (each its own `SELECT ... LIMIT 1`, no `ORDER BY`), so
 * nothing guarantees the fixture Supervisor is actually assigned (via
 * `user_locations`) to the fixture outlet — a correlation earlier tests in
 * this suite don't depend on (role-based `decide()` authorization never
 * checks location), but the B-07 notify path DOES depend on it (a
 * location-scoped role is filtered to users actually assigned to that
 * location — `notification-recipients.ts`). `ON CONFLICT DO NOTHING` makes
 * this an idempotent, additive fixture nudge, not a destructive rewrite of
 * seed data.
 */
export async function ensureUserLocation(userId: string, locationId: string): Promise<void> {
  await getOwnerPool().query(
    `INSERT INTO user_locations (user_id, location_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [userId, locationId],
  );
}

/**
 * `settings` is written on the APP-POOL client passed in (same transaction
 * as the code under test, `app_user` has full CRUD grants on it) — never via
 * the owner pool, so the change is rolled back with everything else and
 * never needs a manual revert.
 */
export async function setSettingValue(
  client: PoolClient,
  key: string,
  value: unknown,
): Promise<void> {
  await client.query(`UPDATE settings SET value = $2 WHERE key = $1`, [key, JSON.stringify(value)]);
}

/**
 * B-07 — a real `ApprovalService`, wired with a real `NotificationService`
 * against the SAME `mimi_app` pool `withRollback`/`withRollbackAs` run the
 * code-under-test's own transaction on (`getAppPool()` — one shared pool,
 * two separate connections: `ApprovalService.decide()`'s own `client` runs
 * in the rolled-back transaction; `NotificationService`'s recipient
 * resolution and channel writes run on THEIR OWN connection from the same
 * pool, exactly as production does — see `notification-recipients.ts`).
 * `WA_ENABLED=false`/unset `SMTP_HOST` (the harness's fixed config) means
 * every send is exercised end-to-end through the real outbox-write code path
 * without needing real SMTP/n8n credentials in CI, matching
 * `notification.service.integration.spec.ts`'s own established shape for
 * this exact "channel disabled, but the pipeline still runs for real"
 * pattern.
 */
export function buildApprovalServiceWithNotifications(): ApprovalService {
  const pool = getAppPool();
  const outbox = new NotificationOutboxRepository(pool);
  const whatsapp = new WhatsAppChannelService(fakeConfig({ WA_ENABLED: 'false' }), outbox);
  const email = new EmailChannelService(fakeConfig({ SMTP_HOST: '' }), outbox);
  const gateway = { pushToUser: () => {} } as unknown as NotificationGateway;
  const inApp = new InAppChannelService(pool, gateway);
  const notifications = new NotificationService(pool, inApp, email, whatsapp);
  return new ApprovalService(new ApprovalsRepository(), notifications, pool);
}

function fakeConfig(values: Record<string, string>) {
  return { get: (key: string, def?: unknown) => values[key] ?? def } as never;
}

/**
 * Reads a recipient's own `notifications` rows back — `notifications_self`
 * RLS (migration 009) is `app_is_self(user_id)` ONLY, no central-role arm
 * (the same gap `common/database/system-context.ts` documents), so this
 * must impersonate that exact recipient, not assert a central role.
 */
/** `notification_outbox` carries no RLS at all (migration 009 §1.14 "NONE" group) — safe to read via the owner pool, purely for test assertions. */
export async function readOutboxRows(
  channel: 'email' | 'whatsapp',
  recipient: string,
): Promise<Array<{ template_key: string; status: string }>> {
  const res = await getOwnerPool().query<{ template_key: string; status: string }>(
    `SELECT template_key, status FROM notification_outbox WHERE channel = $1 AND recipient = $2 ORDER BY created_at DESC`,
    [channel, recipient],
  );
  return res.rows;
}

export async function readOwnNotifications(
  userId: string,
): Promise<Array<{ type: string; title: string; body: string }>> {
  const client = await getAppPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [userId]);
    await client.query(`SELECT set_config('app.role', '', true)`);
    await client.query(`SELECT set_config('app.tenant_id', app_the_only_tenant()::text, true)`);
    await client.query(`SELECT set_config('app.location_ids', '', true)`);
    const res = await client.query<{ type: string; title: string; body: string }>(
      `SELECT type, title, body FROM notifications WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId],
    );
    await client.query('COMMIT');
    return res.rows;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
