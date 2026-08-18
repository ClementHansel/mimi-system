import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool, PoolClient } from 'pg';
import { NotificationService } from './notification.service';
import { InAppChannelService } from './channels/in-app-channel.service';
import { EmailChannelService } from './channels/email-channel.service';
import { WhatsAppChannelService } from './channels/whatsapp-channel.service';
import { NotificationOutboxRepository } from './channels/notification-outbox.repository';
import { NotificationGateway } from './notification.gateway';

/**
 * Integration proof (BUILD-PLAN §5 W2-C "TESTING" requirement): a disabled
 * WhatsApp channel writes to the outbox and sends nothing, exercised
 * against the LIVE compose Postgres, end-to-end through `NotificationService`
 * (not a channel unit test in isolation) — plus the in-app row landing in
 * the real `notifications` table.
 *
 * D-21/D-22: `DATABASE_URL`/`TEST_DATABASE_URL` now authenticates as
 * `mimi_app` — zero direct table grants, exactly the real runtime role.
 * `NotificationService` and its channels handle their own role-switching
 * internally (`common/database/system-context.ts`, the canonical helper) —
 * this suite's OWN setup/
 * assertion queries (fetching the seeded user, reading back the rows
 * `notify()` wrote) are NOT part of that internal plumbing, so they need
 * the same `SET LOCAL ROLE app_user` treatment `RlsContextGuard` gives a
 * real request; `withRequestContext()` below reproduces it.
 */
const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://mimi_app:mimi_app_secret@localhost:55433/mimi';

function fakeConfig(values: Record<string, string>) {
  return { get: (key: string, def?: unknown) => values[key] ?? def } as never;
}

/** A central-role request context for this test's own setup/assertion queries against tables with a central-role RLS bypass (`users`, `locations`, `notification_outbox` — the latter has no RLS at all but the role switch is still required). NOT used by the service under test, which manages its own contexts. */
async function withRequestContext<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await client.query(`SELECT set_config('app.role', 'owner', true)`);
    await client.query(
      `SELECT set_config('app.user_id', '00000000-0000-0000-0000-000000000000', true)`,
    );
    await client.query(`SELECT set_config('app.location_ids', '', true)`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * `notifications_self` RLS (migration 009) is `app_is_self(user_id)` with NO
 * central-role bypass at all (same gap `common/database/system-context.ts`
 * documents for the service itself) — reading a recipient's own notification back
 * (exactly what `GET /api/notifications` does for that recipient) requires
 * impersonating that recipient's `app.user_id`, not a central role.
 */
async function withOwnUserContext<T>(
  pool: Pool,
  userId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [userId]);
    await client.query(`SELECT set_config('app.role', '', true)`);
    await client.query(`SELECT set_config('app.location_ids', '', true)`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

describe('NotificationService (integration, live Postgres as mimi_app)', () => {
  let pool: Pool;
  let dbAvailable = true;
  let managerId: string;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    try {
      const user = await withRequestContext(pool, (client) =>
        client.query(`SELECT id FROM users WHERE username = 'manager1' LIMIT 1`),
      );
      if (user.rows.length === 0) {
        dbAvailable = false;
        return;
      }
      managerId = user.rows[0].id;
      // Give the seeded user a phone number if it doesn't have one, so the
      // WhatsApp fan-out path is actually exercised (not skipped for lack
      // of a contact number).
      await withRequestContext(pool, (client) =>
        client.query(`UPDATE users SET phone = COALESCE(phone, '628111222333') WHERE id = $1`, [
          managerId,
        ]),
      );
    } catch {
      dbAvailable = false;
    }
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('WA_ENABLED=false: NotificationService writes a real notifications row AND a real pending notification_outbox row, and never calls fetch', async () => {
    if (!dbAvailable) {
      console.warn('Skipping: live Postgres not reachable');
      return;
    }

    fetchSpy = vi.fn();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as never;

    try {
      const outboxRepo = new NotificationOutboxRepository(pool);
      const whatsapp = new WhatsAppChannelService(fakeConfig({ WA_ENABLED: 'false' }), outboxRepo);
      const email = new EmailChannelService(fakeConfig({ SMTP_HOST: '' }), outboxRepo);
      const gateway = { pushToUser: vi.fn() } as unknown as NotificationGateway;
      const inApp = new InAppChannelService(pool, gateway);
      const service = new NotificationService(pool, inApp, email, whatsapp);

      const result = await service.notify({
        templateKey: 'cold_chain_breach',
        userIds: [managerId],
        params: {
          recordedTemp: '-8.0',
          minTemp: '-25.0',
          maxTemp: '-15.0',
          context: 'SJ/202608/0001 drop 2',
          locationName: 'Mimi Chicken Balikpapan Kota',
        },
      });

      // in-app: a real row landed in `notifications`.
      expect(result.inApp).toHaveLength(1);
      const inAppRow = await withOwnUserContext(pool, managerId, (client) =>
        client.query('SELECT * FROM notifications WHERE id = $1', [result.inApp[0]!.id]),
      );
      expect(inAppRow.rows).toHaveLength(1);
      expect(inAppRow.rows[0].user_id).toBe(managerId);
      expect(inAppRow.rows[0].type).toBe('cold_chain_breach');
      expect(inAppRow.rows[0].title).toContain('rantai dingin');
      expect(gateway.pushToUser).toHaveBeenCalledTimes(1);

      // whatsapp: disabled → outbox row written, pending, fetch never called.
      expect(result.whatsapp).toHaveLength(1);
      expect(result.whatsapp[0]!.success).toBe(false);
      const outboxRow = await withRequestContext(pool, (client) =>
        client.query('SELECT * FROM notification_outbox WHERE id = $1', [
          result.whatsapp[0]!.outboxId,
        ]),
      );
      expect(outboxRow.rows).toHaveLength(1);
      expect(outboxRow.rows[0].channel).toBe('whatsapp');
      expect(outboxRow.rows[0].status).toBe('pending');
      expect(outboxRow.rows[0].attempts).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();

      // email: unconfigured SMTP → outbox row written and marked failed.
      expect(result.email).toHaveLength(1);
      expect(result.email[0]!.success).toBe(false);
      const emailOutboxRow = await withRequestContext(pool, (client) =>
        client.query('SELECT * FROM notification_outbox WHERE id = $1', [
          result.email[0]!.outboxId,
        ]),
      );
      expect(emailOutboxRow.rows[0].channel).toBe('email');
      expect(emailOutboxRow.rows[0].status).toBe('failed');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('REGRESSION (D-21/D-22): a bare mimi_app connection with no SET LOCAL ROLE cannot notify() at all, but the service itself handles its own role-switching correctly', async () => {
    if (!dbAvailable) return;

    // The exact bug the coordinator flagged: NotificationService's contact
    // lookup and in-app write used to run on `this.pool` directly, with no
    // role switch. Prove that shape is impossible to silently ship: a raw
    // query with zero role switch is rejected outright.
    await expect(pool.query('SELECT id, email, phone FROM users LIMIT 1')).rejects.toMatchObject({
      code: '42501', // permission denied
    });
    await expect(
      pool.query(`INSERT INTO notifications (user_id, type, title, body) VALUES ($1,'x','x','x')`, [
        managerId,
      ]),
    ).rejects.toMatchObject({ code: '42501' });

    // The fixed shape: NotificationService.notify() succeeds against the
    // SAME unprivileged pool because it manages its own system context
    // internally for every query it issues (`common/database/system-context.ts`).
    const outboxRepo = new NotificationOutboxRepository(pool);
    const whatsapp = new WhatsAppChannelService(fakeConfig({ WA_ENABLED: 'false' }), outboxRepo);
    const email = new EmailChannelService(fakeConfig({ SMTP_HOST: '' }), outboxRepo);
    const gateway = { pushToUser: vi.fn() } as unknown as NotificationGateway;
    const inApp = new InAppChannelService(pool, gateway);
    const service = new NotificationService(pool, inApp, email, whatsapp);

    const result = await service.notify({
      templateKey: 'low_stock',
      userIds: [managerId],
      params: {
        itemName: 'Ayam Fillet',
        locationName: 'Gudang',
        currentQty: '1',
        minQty: '10',
        unit: 'kg',
      },
    });
    expect(result.inApp).toHaveLength(1);
  });
});
