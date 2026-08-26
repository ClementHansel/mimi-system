/**
 * W6-04 (financial correctness) — GoFood/ShopeeFood net-received math, GL
 * side (ACCEPTANCE.md §5 E7). Live database, real `PosOnlineOrderService`
 * AND the real `PostingEngineService` (no mocks) — same wiring pattern as
 * `stock-opname/stock-opname-gl-posting.spec.ts`.
 *
 * `pos-shift-flow.integration.test.ts` already proves the ARITHMETIC is
 * correct (netReceived accepted when it matches gross-discount-fees,
 * `ERR_NET_MISMATCH` when it doesn't) and `packages/shared/src/cart
 * /online-order-net.property.test.ts` proves that arithmetic holds as a
 * property for any amount combination, including the
 * `calculateOnlineOrderJournalSplit` netLeg+feeLeg=gross identity. What
 * neither of those proves is whether a completed online order actually
 * reaches the general ledger — this file checks that directly.
 *
 * B-16 FOUND (this file, first version): `PosOnlineOrderService` called
 * `StockLedgerService` only — no `EventBus`, no `eventBus.publish`, no
 * `calculateOnlineOrderJournalSplit` reference anywhere in it. A completed
 * GoFood/ShopeeFood order posted a real recipe-usage stock movement but the
 * `netLeg`/`feeLeg` split `JournalEventType.OUTLET_SALES`'s online branch
 * (`resolveOutletSalesLegs` in `posting-engine.service.ts`) exists to record
 * was never published from anywhere — the same systemic gap
 * `waste-return/waste-gl-posting.spec.ts` found for waste, here for
 * online-platform revenue: money that should land on `1030` (platform
 * receivable) net of `6300` (commission expense) never touched the ledger.
 *
 * FIXED: `applyOnlineOrderFact` now publishes `journal.action` for every
 * COMPLETED, non-conflict-loser order, right after the insert. This file now
 * asserts the FIXED behavior (a real `journal_entries` row, balanced,
 * correctly split) rather than pinning the absence.
 *
 * `PostingEngineService` posts on its OWN `withSystemContext` connection,
 * independent of this test's own transaction (see that class's doc comment)
 * — so, like `stock-opname-gl-posting.spec.ts`, this uses a COMMITTED
 * transaction for the order itself (`runCommitted` below) and cleans up by
 * hand in `afterEach`, rather than `withRollback` (which would leave a
 * durable, orphaned `journal_entries` row pointing at a rolled-back order).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { businessDateOf, OnlineOrderStatus, OnlinePlatform } from '@mimi/shared';
import { Pool, type PoolClient } from 'pg';
import { ChartOfAccountsService } from '../accounting/chart-of-accounts.service';
import { FiscalPeriodsService } from '../accounting/fiscal-periods.service';
import { JournalService } from '../accounting/journal.service';
import { PostingEngineService } from '../accounting/posting-engine.service';
import { formatDateOnly } from '../../common/date-only.util';
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

/** The REAL posting engine, subscribed to the SAME bus `PosOnlineOrderService` publishes through — same helper shape as `stock-opname-gl-posting.spec.ts`'s `buildEngine`. */
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
async function runCommitted<T>(ctx: RlsContext, fn: (client: PoolClient) => Promise<T>): Promise<T> {
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
  'POS online order (GoFood/ShopeeFood) — GL posting reachability, live database',
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

    it('control: a COMPLETED online order is recorded with the correct net-received math (positive control that the service itself works)', async () => {
      const eventBus = buildEventBus();
      const stockLedger = buildStockLedgerService(eventBus);
      const svc = new PosOnlineOrderService(stockLedger, eventBus);

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

    it('a completed online order posts a balanced outlet_sales (JOUT-03) entry: Dr 1030 net / Cr 4000, Dr 6300 fees / Cr 1030', async () => {
      const orderRef = `GF-GL-${randomUUID().slice(0, 8)}`;
      const orderDate = new Date().toISOString().slice(0, 10);
      const gross = '45000.00';
      const discount = '2000.00';
      const platformFee = '4500.00';
      const otherFee = '500.00';
      const netReceived = '38000.00'; // 45000 - 2000 - 4500 - 500
      const feeLeg = '7000.00'; // 2000 + 4500 + 500

      const eventBus = buildEventBus();
      const stockLedger = buildStockLedgerService(eventBus);
      buildEngine(eventBus); // the REAL posting engine, subscribed to the SAME bus the service publishes through
      const svc = new PosOnlineOrderService(stockLedger, eventBus);

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

      const entryRows = await cleanupPool.query<{
        id: string;
        event_type: string;
        location_id: string;
        entry_date: unknown;
      }>(
        `SELECT id, event_type, location_id, entry_date FROM journal_entries WHERE ref_type = 'online_order' AND ref_id = $1`,
        [order.id],
      );
      expect(entryRows.rows).toHaveLength(1);
      expect(entryRows.rows[0]!.event_type).toBe('outlet_sales');
      expect(entryRows.rows[0]!.location_id).toBe(fx.locationId);
      // `order_date` is the WITA business day the entry has to land on, per `applyOnlineOrderFact`'s
      // `endOfBusinessDay`-style `occurredAt` — never "today" if the order was recorded later.
      expect(formatDateOnly(entryRows.rows[0]!.entry_date)).toBe(businessDateOf(`${orderDate}T23:59:59.999+08:00`));

      const lineRows = await cleanupPool.query<{ code: string; debit: string; credit: string }>(
        `SELECT a.code, l.debit, l.credit
           FROM journal_lines l JOIN chart_of_accounts a ON a.id = l.account_id
          WHERE l.entry_id = $1 ORDER BY a.code`,
        [entryRows.rows[0]!.id],
      );
      // Balanced by construction (never a plug line): 1030 net (revenue leg) + 1030 fee leg + 4000 +
      // 6300 = 4 lines total (two touching 1030, from the two separate Dr/Cr pairs
      // `resolveOutletSalesLegs` builds), summing debits === summing credits.
      const totalDebit = lineRows.rows.reduce((s, r) => s + Number.parseFloat(r.debit), 0);
      const totalCredit = lineRows.rows.reduce((s, r) => s + Number.parseFloat(r.credit), 0);
      expect(totalDebit.toFixed(2)).toBe(totalCredit.toFixed(2));

      const revenueCredit = lineRows.rows.find((r) => r.code === '4000');
      expect(revenueCredit?.credit).toBe(netReceived);
      const feeDebit = lineRows.rows.find((r) => r.code === '6300');
      expect(feeDebit?.debit).toBe(feeLeg);
      const receivableLines = lineRows.rows.filter((r) => r.code === '1030');
      expect(receivableLines).toHaveLength(2); // one debit (netLeg, vs 4000), one credit (feeLeg, vs 6300)
      const receivableDebit = receivableLines.find((r) => Number.parseFloat(r.debit) > 0);
      const receivableCredit = receivableLines.find((r) => Number.parseFloat(r.credit) > 0);
      expect(receivableDebit?.debit).toBe(netReceived);
      expect(receivableCredit?.credit).toBe(feeLeg);

      // Idempotency — a replayed event (EventBus redelivery, sync replay) must not double-post.
      const replayPayload = {
        eventType: 'outlet_sales' as const,
        documentType: 'online_order',
        documentId: order.id,
        locationId: fx.locationId,
        amount: gross,
        context: { byMethod: { online: netReceived }, onlineFees: feeLeg },
        occurredAt: `${orderDate}T23:59:59.999+08:00`,
      };
      await eventBus.publish('journal.action', replayPayload);
      const replay = await cleanupPool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM journal_entries WHERE ref_type = 'online_order' AND ref_id = $1`,
        [order.id],
      );
      expect(replay.rows[0]!.count).toBe('1');
    });

    it('a conflict-loser fact (SYNC-PROTOCOL C8, "revenue reports use first") never posts a journal entry for its own amounts', async () => {
      const orderRef = `GF-LOSER-${randomUUID().slice(0, 8)}`;
      const orderDate = new Date().toISOString().slice(0, 10);

      const eventBus = buildEventBus();
      const stockLedger = buildStockLedgerService(eventBus);
      buildEngine(eventBus);
      const svc = new PosOnlineOrderService(stockLedger, eventBus);

      // `isConflictLoser: true` on a fresh fact (never a duplicate of an existing row — the
      // `existing` dedupe check above would short-circuit before this guard is even reached, which
      // is not what this test is proving) — the same shape `postUsage`'s own `isConflictLoser` guard
      // is exercised with, applied to the journal-publish guard added alongside it.
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
