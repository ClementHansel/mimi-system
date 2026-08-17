import { Pool, type PoolClient } from 'pg';
import { EventBus } from '../../../kernel/events/event-bus.service';
import { ApprovalsRepository } from '../../../kernel/approvals/approvals.repository';
import { ApprovalService } from '../../../kernel/approvals/approvals.service';
import { StockLedgerService } from '../../../kernel/stock-ledger/stock-ledger.service';
import { StockMovedEventEmitter } from '../../../kernel/stock-ledger/stock-ledger-events';
import { SyncEventsRepository } from '../../../kernel/sync/sync-events.repository';
import { SyncConflictsRepository } from '../../../kernel/sync/sync-conflicts.repository';
import { ConflictDetectorService } from '../../../kernel/sync/conflict-detector.service';
import { SyncEmitService } from '../../../kernel/sync/sync-emit.service';
import { NotificationService } from '../../../kernel/notification/notification.service';
import { InAppChannelService } from '../../../kernel/notification/channels/in-app-channel.service';
import { EmailChannelService } from '../../../kernel/notification/channels/email-channel.service';
import { WhatsAppChannelService } from '../../../kernel/notification/channels/whatsapp-channel.service';
import { NotificationOutboxRepository } from '../../../kernel/notification/channels/notification-outbox.repository';
import { PaymentVerificationsService } from '../../accounting/payment-verifications.service';

/**
 * Live-DB test harness (copied pattern: `kernel/approvals/test-support/
 * live-db.ts`, per this module's brief — same two-pool / `SET LOCAL ROLE
 * app_user` reasoning, not re-explained here).
 *
 *  - `getOwnerPool()` — `DATABASE_MIGRATION_URL` superuser. FIXTURE READS
 *    ONLY (seeded locations/users/products/recipes) — never construct a
 *    service under test against it.
 *  - `getAppPool()` — `DATABASE_URL`'s `mimi_app` role, the SAME identity
 *    `DATABASE_POOL` uses in production. Every `Pos*Service` call in the
 *    integration suite runs on a `PoolClient` from THIS pool, so the suite
 *    exercises the REAL RLS-enforced path — a Kasir-role transaction really
 *    can only see its own outlet's rows, exactly as production does.
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

export interface RlsContext {
  userId: string;
  roleKey: string;
  /** `[]` = no locations (central roles resolve unrestricted via `app_is_central()` regardless). */
  locationIds?: string[];
}

/**
 * Re-asserts the session context for a DIFFERENT actor on the SAME
 * transaction/connection — needed whenever a scenario test plays two real
 * actors in sequence (a Kasir's void request, then a Supervisor's approval)
 * within one `withRollback` block. This is not a shortcut around RLS: it is
 * exactly what changes between the two REAL HTTP requests in production
 * (each gets its own `RlsContextGuard` pass, seeded from that request's own
 * verified JWT) — simulated here on one connection purely so the test can
 * still see the first actor's uncommitted writes (a second, separate
 * transaction could not). `users_select`'s `app_is_self(id)` policy in
 * particular depends on `app.user_id` matching the CURRENT actor, which is
 * why e.g. PIN verification needs this rather than staying "as Kasir" for
 * the whole scenario.
 */
/**
 * Neutralizes any PRE-EXISTING seeded open shift at `locationId` before a
 * test opens its own — `database/seed.ts` leaves several outlets with an
 * already-`open` shift (no `device_id`), which collides with
 * `PosShiftService.open()`'s "already open for this location/device"
 * conflict check whenever a test omits `deviceId` (as these tests do — a
 * random `deviceId` would violate the real FK to `devices(id)`). Runs on the
 * test's OWN rolled-back `client`/transaction, so it never durably touches
 * seed data.
 */
export async function neutralizeOpenShifts(client: PoolClient, locationId: string): Promise<void> {
  await client.query(`UPDATE pos_shifts SET status = 'closed' WHERE location_id = $1 AND status = 'open'`, [locationId]);
}

export async function switchActor(client: PoolClient, ctx: RlsContext): Promise<void> {
  await client.query(`SELECT set_config('app.user_id', $1, true)`, [ctx.userId]);
  await client.query(`SELECT set_config('app.role', $1, true)`, [ctx.roleKey]);
  await client.query(`SELECT set_config('app.location_ids', $1, true)`, [(ctx.locationIds ?? []).join(',')]);
}

/**
 * Runs `fn` on a fresh `mimi_app` connection inside a transaction that is
 * ALWAYS rolled back, asserting the exact session context
 * `RlsContextGuard` asserts per real request (`SET LOCAL ROLE app_user` +
 * `app.user_id`/`app.role`/`app.location_ids`). Every query a `Pos*Service`
 * issues during the test therefore runs under real, `FORCE`d RLS as the
 * GIVEN role — this is what lets a test assert "a Kasir cannot approve
 * their own void" by literally trying it as Kasir and observing the
 * rejection, not by inspecting the RBAC matrix.
 */
export async function withRollback<T>(ctx: RlsContext, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getAppPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await switchActor(client, ctx);
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

export interface OutletFixture {
  locationId: string;
  locationCode: string;
  kitchenLineAreaId: string;
  kasirId: string;
  kasirUsername: string;
  supervisorId: string;
  supervisorUsername: string;
  /** The seed's known demo PIN for `spv_*`/central-role users (`database/seed.ts`'s `DEMO_PIN`). */
  supervisorPin: string;
  ownerId: string;
  managerId: string;
  productId: string;
  productPrice: string;
}

/**
 * Reads real seeded rows (never inserts master data — that is `senior-db`'s
 * territory) via the OWNER pool. Picks an outlet that has a `kitchen_line`
 * storage area AND at least one `kasir1_<code>` / `spv_<code>` pair (every
 * seeded outlet qualifies — `database/seed.ts` gives each one both), so the
 * fixture is resilient to which specific outlet the seed happened to create
 * first.
 */
export async function loadOutletFixture(): Promise<OutletFixture> {
  const pool = getOwnerPool();

  const outlet = await pool.query<{ id: string; code: string; area_id: string }>(
    `SELECT l.id, l.code, sa.id AS area_id
       FROM locations l
       JOIN storage_areas sa ON sa.location_id = l.id AND sa.type = 'kitchen_line' AND sa.is_active
      WHERE l.type = 'outlet'
      ORDER BY l.code
      LIMIT 1`,
  );
  if (!outlet.rows[0]) throw new Error('Seed data has no outlet with a kitchen_line storage area — run database/seed.ts first.');
  const { id: locationId, code: locationCode, area_id: kitchenLineAreaId } = outlet.rows[0];

  const kasirUsername = `kasir1_${locationCode.toLowerCase()}`;
  const supervisorUsername = `spv_${locationCode.toLowerCase()}`;

  const kasir = await pool.query<{ id: string }>(`SELECT id FROM users WHERE username = $1`, [kasirUsername]);
  const supervisor = await pool.query<{ id: string }>(`SELECT id FROM users WHERE username = $1`, [supervisorUsername]);
  if (!kasir.rows[0] || !supervisor.rows[0]) {
    throw new Error(`Seed data is missing '${kasirUsername}'/'${supervisorUsername}' for outlet ${locationCode}.`);
  }

  const owner = await pool.query<{ id: string }>(
    `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.key = 'owner' LIMIT 1`,
  );
  const manager = await pool.query<{ id: string }>(
    `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.key = 'manager' LIMIT 1`,
  );
  if (!owner.rows[0] || !manager.rows[0]) throw new Error('Seed data is missing an owner/manager user.');

  // Requires at least one recipe line whose unit ALREADY matches the ingredient's base unit — some
  // seeded recipe lines pair a unit with no `unit_conversions` path at all (e.g. a `kg`-authored
  // line against a `pcs`-based packaging item), which `recipe-usage.util.ts` correctly SKIPS rather
  // than failing the sale (see that file's header) — but that would make a fixture picked at
  // random spuriously post zero usage. Picking a product with a guaranteed-postable line keeps this
  // fixture deterministic without special-casing seed data.
  const product = await pool.query<{ id: string; price: string }>(
    `SELECT DISTINCT p.id, p.price FROM products p
       JOIN recipes r ON r.product_id = p.id AND r.is_active
       JOIN recipe_lines rl ON rl.recipe_id = r.id
       JOIN items i ON i.id = rl.item_id AND rl.unit_id = i.base_unit_id
      WHERE p.is_active
      ORDER BY p.id
      LIMIT 1`,
  );
  if (!product.rows[0]) throw new Error('Seed data has no active product with a directly-postable recipe line.');

  return {
    locationId,
    locationCode,
    kitchenLineAreaId,
    kasirId: kasir.rows[0].id,
    kasirUsername,
    supervisorId: supervisor.rows[0].id,
    supervisorUsername,
    supervisorPin: '123456', // database/seed.ts's DEMO_PIN, seeded for every `spv_*` user (`withPin: true`)
    ownerId: owner.rows[0].id,
    managerId: manager.rows[0].id,
    productId: product.rows[0].id,
    productPrice: product.rows[0].price,
  };
}

// ── Real service graphs, wired by hand (no Nest DI container in these
// tests — same convention `kernel/stock-ledger`/`kernel/approvals`'s own
// integration specs use: `new Service(new Dependency())`). ──────────────────

export function buildEventBus(): EventBus {
  return new EventBus();
}

export function buildApprovalService(): ApprovalService {
  return new ApprovalService(new ApprovalsRepository());
}

/** `PosSaleService`'s escalated `payment_verifications` write for a bank-transfer sale (FR-ACCT-03). */
export function buildPaymentVerificationsService(pool: Pool): PaymentVerificationsService {
  return new PaymentVerificationsService(buildSyncEmitService(pool), buildEventBus());
}

export function buildStockLedgerService(eventBus: EventBus): StockLedgerService {
  return new StockLedgerService(new StockMovedEventEmitter(eventBus));
}

export function buildSyncEmitService(pool: Pool): SyncEmitService {
  const events = new SyncEventsRepository(pool);
  const conflicts = new ConflictDetectorService(events, new SyncConflictsRepository());
  return new SyncEmitService(events, conflicts);
}

function fakeConfigService(values: Record<string, string> = {}) {
  return { get: (key: string, def?: unknown) => values[key] ?? def } as never;
}

/**
 * A real `NotificationService` (DB-backed in-app channel; email/WhatsApp
 * channels are constructed for real too, but the `approval_pending`
 * template this module uses is `channels: ['in_app']` only, so neither
 * ever fires). `NotificationGateway`'s socket.io push is faked out — a
 * plain `new NotificationGateway` never gets its `@WebSocketServer()`
 * field populated outside a running Nest app, so calling it for real would
 * throw; `pushToUser` is a UX nicety on top of the DB row this suite
 * verifies directly, not something these tests need to exercise.
 */
export function buildNotificationService(pool: Pool): NotificationService {
  const outbox = new NotificationOutboxRepository(pool);
  const fakeGateway = { pushToUser: () => undefined } as unknown as ConstructorParameters<typeof InAppChannelService>[1];
  return new NotificationService(
    pool,
    new InAppChannelService(pool, fakeGateway),
    new EmailChannelService(fakeConfigService(), outbox),
    new WhatsAppChannelService(fakeConfigService({ WA_ENABLED: 'false' }), outbox),
  );
}
