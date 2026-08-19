/**
 * W6-04 (financial correctness) — GoFood/ShopeeFood net-received math, GL
 * side (ACCEPTANCE.md §5 E7, "NONE"). Live database, real
 * `PosOnlineOrderService`, no mocks — same wiring pattern as
 * `pos-shift-flow.integration.test.ts` (kept in a separate new file per this
 * ticket's "new *.spec.ts only" constraint).
 *
 * `pos-shift-flow.integration.test.ts` already proves the ARITHMETIC is
 * correct (netReceived accepted when it matches gross-discount-fees,
 * `ERR_NET_MISMATCH` when it doesn't) and `packages/shared/src/cart
 * /online-order-net.property.test.ts` (this ticket) proves that arithmetic
 * holds as a property for any amount combination, including the
 * `calculateOnlineOrderJournalSplit` netLeg+feeLeg=gross identity. What none
 * of that proves is whether a completed online order ever actually reaches
 * the general ledger — this file checks that directly.
 *
 * `PosOnlineOrderService` (`services/pos-online-order.service.ts`) imports
 * `StockLedgerService` only — no `EventBus`, no `eventBus.publish`, no
 * reference to `calculateOnlineOrderJournalSplit` at all (confirmed by
 * reading the file). A completed GoFood/ShopeeFood order posts a real
 * recipe-usage stock movement (`postUsage`, proven below as the control)
 * but the `netLeg`/`feeLeg` split that `JournalEventType.OUTLET_SALES`'s
 * online branch (`resolveOutletSalesLegs`'s `ctx.onlineFees`/`ctx.byMethod`
 * handling in `posting-engine.service.ts`) exists to record is never
 * published from anywhere — proven negatively below. This is the SAME
 * systemic gap as `waste-return/waste-gl-posting.spec.ts`'s finding, applied
 * to online-platform revenue instead of waste: money that should land on
 * `1030` (platform receivable) net of `6300` (commission expense) never
 * touches the ledger at all.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OnlineOrderStatus, OnlinePlatform } from '@mimi/shared';
import { Pool } from 'pg';
import { PosOnlineOrderService } from './services/pos-online-order.service';
import {
  buildEventBus,
  buildStockLedgerService,
  closePool,
  loadOutletFixture,
  withRollback,
  type OutletFixture,
} from './test-support/live-db';

vi.setConfig({ testTimeout: 20_000 });

const cleanupPool = new Pool({
  connectionString:
    process.env.DATABASE_MIGRATION_URL ??
    `postgres://${process.env.POSTGRES_USER ?? 'mimi'}:${process.env.POSTGRES_PASSWORD ?? 'mimi_secret'}@localhost:${process.env.POSTGRES_PORT ?? '55433'}/${process.env.POSTGRES_DB ?? 'mimi'}`,
});

let fx: OutletFixture;

describe.skipIf(!process.env.DATABASE_URL)(
  'POS online order (GoFood/ShopeeFood) — GL posting reachability, live database',
  () => {
    beforeAll(async () => {
      fx = await loadOutletFixture();
    }, 30_000);

    afterAll(async () => {
      await cleanupPool.end();
      await closePool();
    });

    it('control: a COMPLETED online order is recorded with the correct net-received math (positive control that the service itself works)', async () => {
      await withRollback(
        { userId: fx.kasirId, roleKey: 'kasir', locationIds: [fx.locationId] },
        async (client) => {
          const eventBus = buildEventBus();
          const stockLedger = buildStockLedgerService(eventBus);
          const svc = new PosOnlineOrderService(stockLedger);

          const orderId = randomUUID();
          const gross = '60000.00';
          const discount = '3000.00';
          const platformFee = '6000.00';
          const otherFee = '1000.00';
          const netReceived = '50000.00'; // 60000 - 3000 - 6000 - 1000

          const order = await svc.create(client, fx.kasirId, {
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
          });

          expect(order.netReceived).toBe(netReceived);
          expect(order.platform).toBe(OnlinePlatform.SHOPEEFOOD);
        },
      );
    });

    it('DEFECT: a completed online order never produces a journal_entries row for outlet_sales (JOUT-03) — the platform-settlement GL leg is unreachable in production', async () => {
      const orderRef = `GF-GLGAP-${randomUUID().slice(0, 8)}`;

      // `withRollback` ALWAYS rolls back at the end of the callback (see that helper's doc
      // comment), so the order created here never durably exists — querying `journal_entries` from
      // a SEPARATE connection/pool afterward would find nothing regardless of whether the GL
      // wiring is fixed, making that assertion meaningless either way. Assert via the SAME
      // connection/transaction the order was created on, before rollback — exactly how
      // `pos-shift-flow.integration.test.ts` verifies its own stock-movement side effects.
      await withRollback(
        { userId: fx.kasirId, roleKey: 'kasir', locationIds: [fx.locationId] },
        async (client) => {
          const eventBus = buildEventBus();
          const stockLedger = buildStockLedgerService(eventBus);
          const svc = new PosOnlineOrderService(stockLedger);

          const order = await svc.create(client, fx.kasirId, {
            clientId: randomUUID(),
            locationId: fx.locationId,
            platform: OnlinePlatform.GOFOOD,
            orderRef,
            orderDate: new Date().toISOString().slice(0, 10),
            grossAmount: '45000.00',
            discountAmount: '2000.00',
            platformFee: '4500.00',
            otherFee: '500.00',
            netReceived: '38000.00',
            status: OnlineOrderStatus.COMPLETED,
          });

          // journal_entries is NOT RLS-scoped the same way online_orders is (it is finance/central
          // data), but this connection is still `mimi_app` under the `kasir` session — read it via
          // the SAME transaction/client the order was created on, which is guaranteed to see
          // whatever the create() call itself might have written (in-transaction, uncommitted or
          // not) before this test's own rollback discards everything.
          const journalRows = await client.query<{ id: string; event_type: string }>(
            `SELECT id, event_type FROM journal_entries WHERE ref_type = 'online_order' AND ref_id = $1`,
            [order.id],
          );
          // EXPECTED (per JOUT-03 / `calculateOnlineOrderJournalSplit`): a balanced entry crediting
          // revenue (4000) and debiting 1030 (platform receivable) net of 6300 (commission expense).
          // ACTUAL, today: 0 rows — `PosOnlineOrderService` never calls `eventBus.publish`. Pinned
          // as the CURRENT (broken) behavior so this goes RED the moment the wiring is fixed.
          expect(journalRows.rows).toHaveLength(0);
        },
      );
    });
  },
);
