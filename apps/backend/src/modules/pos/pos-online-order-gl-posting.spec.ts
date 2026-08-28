/**
 * W6-04 (financial correctness) — GoFood/ShopeeFood net-received math, GL
 * side (ACCEPTANCE.md §5 E7). Live database, real `PosOnlineOrderService`
 * AND the real `PostingEngineService` (no mocks) — same wiring pattern as
 * `stock-opname/stock-opname-gl-posting.spec.ts`.
 *
 * HISTORY, so nobody "fixes" this back:
 *
 * 1. B-16 FOUND (this file, first version): `PosOnlineOrderService` never
 *    published `journal.action` for a completed order — a real stock
 *    movement posted, but the revenue/fee split `resolveOutletSalesLegs`'s
 *    online branch exists to record never reached the ledger.
 * 2. FIXED (this file, second version): `applyOnlineOrderFact` published
 *    `journal.action` for every COMPLETED, non-conflict-loser order. This
 *    file asserted a real, balanced `journal_entries` row.
 * 3. RETIRED (this file, THIRD version, owner decision 2026-08-27 — three-
 *    tier channel pricing, migration 249): GoFood/ShopeeFood orders are now
 *    rung up as an ordinary POS `Sale` with `channel` set, in the SAME till
 *    interface as walk-in, and `PosSaleService.applySaleFact` is now the ONE
 *    place that posts `journal.action` for a platform order. Fix #2 above,
 *    left in place, would have double-counted the same real-world
 *    transaction's revenue once channel sales went live — a completed
 *    channel `Sale` AND a completed `online_orders` row, both posting.
 *    `PosOnlineOrderService.applyOnlineOrderFact` no longer publishes
 *    `journal.action` at all (see that class's header for the full
 *    rationale — table/endpoints/projector are left DORMANT, not dropped;
 *    only the GL side effect was removed). THIS FILE NOW ASSERTS THE
 *    ABSENCE OF A JOURNAL ENTRY, deliberately, as a regression guard against
 *    someone re-adding the publish call because "test 2 used to check for
 *    one" — it did, and doing so again reintroduces the double-count.
 *
 * `PostingEngineService` posts on its OWN `withSystemContext` connection,
 * independent of this test's own transaction (see that class's doc comment)
 * — so, like `stock-opname-gl-posting.spec.ts`, this uses a COMMITTED
 * transaction for the order itself (`runCommitted` below) and cleans up by
 * hand in `afterEach`, rather than `withRollback` (which would leave a
 * durable, orphaned `journal_entries` row pointing at a rolled-back order —
 * moot for the no-entry-expected tests below, but kept for parity with the
 * "control" test and in case a future regression starts posting again).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { OnlineOrderStatus, OnlinePlatform } from '@mimi/shared';
import { Pool, type PoolClient } from 'pg';
import { ChartOfAccountsService } from '../accounting/chart-of-accounts.service';
import { FiscalPeriodsService } from '../accounting/fiscal-periods.service';
import { JournalService } from '../accounting/journal.service';
import { PostingEngineService } from '../accounting/posting-engine.service';
import { PosOnlineOrderService } from './services/pos-online-order.service';
import {
  buildEventBus,
  buildStockLedgerService,
  closePool,
  getAppPool,
  loadOutletFixture,
  switchActor,
  type OutletFixture,
} from './test-support/live-db';
import { EventBus } from '../../kernel/events/event-bus.service';
import type { RlsContext } from './test-support/live-db';

vi.setConfig({ testTimeout: 20_000 });

const cleanupPool = new Pool({
  connectionString:
    process.env.DATABASE_MIGRATION_URL ??
    `postgres://${process.env.POSTGRES_USER ?? 'mimi'}:${process.env.POSTGRES_PASSWORD ?? 'mimi_secret'}@localhost:${process.env.POSTGRES_PORT ?? '55433'}/${process.env.POSTGRES_DB ?? 'mimi'}`,
});

/** The REAL posting engine, subscribed to the SAME bus `PosOnlineOrderService` publishes through — same helper shape as `stock-opname-gl-posting.spec.ts`'s `buildEngine`. Kept wired up in the tests below even though nothing is expected to arrive: a LIVE, listening engine finding nothing is a stronger absence proof than never subscribing one at all. */
function buildEngine(eventBus: EventBus): PostingEngineService {
  const journal = new JournalService(new ChartOfAccountsService(), new FiscalPeriodsService());
  const engine = new PostingEngineService(getAppPool(), eventBus, journal);
  engine.onModuleInit();
  return engine;
}

/**
 * Runs `fn` on a fresh `mimi_app` connection, under real RLS as the given
 * role, and COMMITS (unlike `withRollback`) — required here because
 * `PostingEngineService` posts on its own connection regardless of what this
 * transaction does, so a rolled-back order would leave its journal entry
 * behind as an orphan. Caller is responsible for cleaning up afterward.
 */
async function runCommitted<T>(
  ctx: RlsContext,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getAppPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await switchActor(client, ctx);
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

let fx: OutletFixture;
const orderIds: string[] = [];

describe.skipIf(!process.env.DATABASE_URL)(
  'POS online order (GoFood/ShopeeFood) — GL posting is RETIRED here, live database',
  () => {
    beforeAll(async () => {
      fx = await loadOutletFixture();
    }, 30_000);

    afterEach(async () => {
      while (orderIds.length) {
        const orderId = orderIds.pop()!;
        await cleanupPool.query(
          `DELETE FROM journal_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE ref_type = 'online_order' AND ref_id = $1)`,
          [orderId],
        );
        await cleanupPool.query(
          `DELETE FROM journal_entries WHERE ref_type = 'online_order' AND ref_id = $1`,
          [orderId],
        );
        await cleanupPool.query(`DELETE FROM online_orders WHERE id = $1`, [orderId]);
      }
    });

    afterAll(async () => {
      await cleanupPool.end();
      await closePool();
    });

    it('control: a COMPLETED online order is still recorded with the correct net-received math (positive control that the service itself works)', async () => {
      const eventBus = buildEventBus();
      const stockLedger = buildStockLedgerService(eventBus);
      const svc = new PosOnlineOrderService(stockLedger);

      const orderId = randomUUID();
      const gross = '60000.00';
      const discount = '3000.00';
      const platformFee = '6000.00';
      const otherFee = '1000.00';
      const netReceived = '50000.00'; // 60000 - 3000 - 6000 - 1000

      const order = await runCommitted(
        { userId: fx.kasirId, roleKey: 'kasir', locationIds: [fx.locationId] },
        (client) =>
          svc.create(client, fx.kasirId, {
            clientId: randomUUID(),
            locationId: fx.locationId,
            platform: OnlinePlatform.SHOPEEFOOD,
            orderRef: `SF-${orderId.slice(0, 8)}`,
            orderDate: new Date().toISOString().slice(0, 10),
            grossAmount: gross,
            discountAmount: discount,
            platformFee,
            otherFee,
            netReceived,
            status: OnlineOrderStatus.COMPLETED,
          }),
      );
      orderIds.push(order.id);

      expect(order.netReceived).toBe(netReceived);
      expect(order.platform).toBe(OnlinePlatform.SHOPEEFOOD);
    });

    it('a completed online order posts NO journal entry any more (retired 2026-08-27 — see class header: the equivalent POS channel `Sale` is now the single revenue record, and leaving this publish in would double-count it)', async () => {
      const orderRef = `GF-GL-${randomUUID().slice(0, 8)}`;
      const orderDate = new Date().toISOString().slice(0, 10);
      const gross = '45000.00';
      const discount = '2000.00';
      const platformFee = '4500.00';
      const otherFee = '500.00';
      const netReceived = '38000.00'; // 45000 - 2000 - 4500 - 500

      const eventBus = buildEventBus();
      const stockLedger = buildStockLedgerService(eventBus);
      buildEngine(eventBus); // the REAL posting engine, listening on the SAME bus — proves nothing arrives, not just that nothing was sent
      const svc = new PosOnlineOrderService(stockLedger);

      const order = await runCommitted(
        { userId: fx.kasirId, roleKey: 'kasir', locationIds: [fx.locationId] },
        (client) =>
          svc.create(client, fx.kasirId, {
            clientId: randomUUID(),
            locationId: fx.locationId,
            platform: OnlinePlatform.GOFOOD,
            orderRef,
            orderDate,
            grossAmount: gross,
            discountAmount: discount,
            platformFee,
            otherFee,
            netReceived,
            status: OnlineOrderStatus.COMPLETED,
          }),
      );
      orderIds.push(order.id);

      const entryRows = await cleanupPool.query<{ id: string }>(
        `SELECT id FROM journal_entries WHERE ref_type = 'online_order' AND ref_id = $1`,
        [order.id],
      );
      expect(entryRows.rows).toHaveLength(0);
    });

    it('a conflict-loser fact (SYNC-PROTOCOL C8, "revenue reports use first") ALSO never posts a journal entry — was already excluded before the retirement, doubly true now that nothing on this path posts at all', async () => {
      const orderRef = `GF-LOSER-${randomUUID().slice(0, 8)}`;
      const orderDate = new Date().toISOString().slice(0, 10);

      const eventBus = buildEventBus();
      const stockLedger = buildStockLedgerService(eventBus);
      buildEngine(eventBus);
      const svc = new PosOnlineOrderService(stockLedger);

      // `isConflictLoser: true` on a fresh fact (never a duplicate of an existing row — the
      // `existing` dedupe check above would short-circuit before this guard is even reached, which
      // is not what this test is proving) — the same shape `postUsage`'s own `isConflictLoser` guard
      // is exercised with.
      const loser = await runCommitted(
        { userId: fx.kasirId, roleKey: 'kasir', locationIds: [fx.locationId] },
        (client) =>
          svc.applyOnlineOrderFact(client, {
            clientId: randomUUID(),
            locationId: fx.locationId,
            platform: OnlinePlatform.GOFOOD,
            orderRef,
            orderDate,
            grossAmount: '20000.00',
            discountAmount: '0.00',
            platformFee: '2000.00',
            otherFee: '0.00',
            netReceived: '18000.00',
            status: OnlineOrderStatus.COMPLETED,
            recordedByUserId: fx.kasirId,
            isConflictLoser: true,
          }),
      );
      orderIds.push(loser.id);

      const entryRows = await cleanupPool.query<{ id: string }>(
        `SELECT id FROM journal_entries WHERE ref_type = 'online_order' AND ref_id = $1`,
        [loser.id],
      );
      expect(entryRows.rows).toHaveLength(0);
    });
  },
);
