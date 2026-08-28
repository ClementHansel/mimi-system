import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ApprovalDocumentType,
  businessDateOf,
  OnlinePlatform,
  OnlineOrderStatus,
  PaymentMethod,
  PaymentStatus,
  RoleKey,
  SaleStatus,
  VoidRefundType,
} from '@mimi/shared';
import { PosCatalogService } from './services/pos-catalog.service';
import { PosShiftService } from './services/pos-shift.service';
import { PosSaleService } from './services/pos-sale.service';
import { PosVoidRefundService } from './services/pos-void-refund.service';
import { PosOnlineOrderService } from './services/pos-online-order.service';
import { PosCashVarianceService } from './services/pos-cash-variance.service';
import { PosDailyStockService } from './services/pos-daily-stock.service';
import {
  buildApprovalCodeService,
  clearAuthLockouts,
  buildApprovalService,
  buildEventBus,
  buildNotificationService,
  buildPaymentVerificationsService,
  buildVoucherRedemptionService,
  buildStockLedgerService,
  buildSyncEmitService,
  closePool,
  getAppPool,
  loadOutletFixture,
  neutralizeOpenShifts,
  switchActor,
  withRollback,
  type OutletFixture,
} from './test-support/live-db';

/**
 * Full-shift scenario against the LIVE database (BUILD-PLAN W3-08 brief,
 * campaign-wide instruction: real Postgres, no `expect(true).toBe(true)`).
 * One `withRollback` transaction runs the entire day so every step sees the
 * previous step's uncommitted writes (identical convention to
 * `kernel/approvals/approvals.integration.spec.ts`); nothing here durably
 * mutates the seed.
 *
 * Covers: buka kasir -> sale per payment method (cash/QRIS/transfer, the
 * FR-ACCT-03 status ladder) -> void request + supervisor approval (D-08,
 * never hand-rolled) -> GoFood/ShopeeFood manual entry -> tutup kasir with
 * a shortfall that auto-proposes a cash-variance deduction (D-19) ->
 * supervisor decision.
 */

function services(pool = getAppPool(), eventBus = buildEventBus()) {
  const approvals = buildApprovalService();
  const stockLedger = buildStockLedgerService(eventBus);
  const syncEmit = buildSyncEmitService(pool);
  const notifications = buildNotificationService(pool);
  return {
    catalog: new PosCatalogService(),
    shifts: new PosShiftService(pool, approvals, notifications),
    sales: new PosSaleService(
      pool,
      stockLedger,
      buildPaymentVerificationsService(pool),
      buildVoucherRedemptionService(),
    ),
    approvalCodes: buildApprovalCodeService(pool),
    voidRefunds: new PosVoidRefundService(
      pool,
      approvals,
      buildApprovalCodeService(pool),
      stockLedger,
      syncEmit,
      notifications,
      eventBus,
    ),
    onlineOrders: new PosOnlineOrderService(stockLedger),
    cashVariances: new PosCashVarianceService(pool, approvals),
    dailyStock: new PosDailyStockService(),
  };
}

let fx: OutletFixture;

beforeAll(async () => {
  // B-15 — a wrong code commits a lockout row that outlives every rollback.
  await clearAuthLockouts();
  fx = await loadOutletFixture();
}, 30_000);

afterAll(async () => {
  await clearAuthLockouts();
  await closePool();
});

describe('POS — full shift, live database', () => {
  it('catalog is readable and non-empty', async () => {
    await withRollback(
      { userId: fx.kasirId, roleKey: 'kasir', locationIds: [fx.locationId] },
      async (client) => {
        const svc = services();
        const catalog = await svc.catalog.getCatalog(client);
        expect(catalog.products.length).toBeGreaterThan(0);
        expect(catalog.categories.length).toBeGreaterThan(0);

        // FR-POS-06 offline projection: `fx.productId` is picked by
        // `loadOutletFixture()` specifically for having a unit-matching recipe,
        // so its catalog row must carry enough for the device to fold a sale
        // into local stock consumption without a round trip.
        const recipeProduct = catalog.products.find((p) => p.id === fx.productId)!;
        expect(recipeProduct.hasRecipe).toBe(true);
        expect(recipeProduct.recipeYieldQty).toBeTruthy();
        expect(recipeProduct.recipeLines!.length).toBeGreaterThan(0);
        for (const line of recipeProduct.recipeLines!) {
          expect(line.itemId).toBeTruthy();
          expect(line.unitId).toBeTruthy();
          expect(Number(line.qty)).toBeGreaterThan(0);
        }
      },
    );
  });

  it('open -> sell cash/QRIS/transfer -> void the cash sale -> online order -> close with a cash-variance proposal', async () => {
    await withRollback(
      { userId: fx.kasirId, roleKey: 'kasir', locationIds: [fx.locationId] },
      async (client) => {
        const svc = services();

        // ── Buka kasir (FR-POS-02) ──────────────────────────────────────────
        const openingCash = '100000.00';
        const openClientId = randomUUID();
        await neutralizeOpenShifts(client, fx.locationId);
        const shift = await svc.shifts.open(client, fx.kasirId, {
          clientId: openClientId,
          locationId: fx.locationId,
          openingCash,
        });
        expect(shift.status).toBe('open');
        expect(shift.shiftNumber).toContain(fx.locationCode);

        // Re-opening with the SAME clientId is idempotent (sync's dedupe contract).
        const reopened = await svc.shifts.open(client, fx.kasirId, {
          clientId: openClientId,
          locationId: fx.locationId,
          openingCash,
        });
        expect(reopened.id).toBe(shift.id);

        // ── Sales across all three payment methods (FR-POS-04) ─────────────
        const saleFor = (method: PaymentMethod) =>
          svc.sales.create(
            client,
            fx.kasirId,
            {
              clientId: randomUUID(),
              shiftId: shift.id,
              locationId: fx.locationId,
              occurredAt: new Date().toISOString(),
              lines: [{ productId: fx.productId, qty: '1.000', unitPrice: fx.productPrice }],
              payments: [{ method, amount: fx.productPrice }],
            },
            { roleKey: 'kasir', locationIds: [fx.locationId] },
          );

        const cashSale = await saleFor(PaymentMethod.CASH);
        expect(cashSale.status).toBe(SaleStatus.COMPLETED);
        expect(cashSale.payments[0]!.paymentStatus).toBe(PaymentStatus.PAID);
        expect(cashSale.receiptNumber).toContain(fx.locationCode);

        const qrisSale = await saleFor(PaymentMethod.QRIS);
        expect(qrisSale.payments[0]!.paymentStatus).toBe(PaymentStatus.VERIFIED);

        const transferSale = await saleFor(PaymentMethod.BANK_TRANSFER);
        // FR-ACCT-03: a transfer is never marked paid on the cashier's say-so — it starts (and, absent
        // a Finance verification this suite does not perform, STAYS) `pending`.
        expect(transferSale.payments[0]!.paymentStatus).toBe(PaymentStatus.PENDING);

        // FR-ACCT-03's other half, created under this SAME real Kasir session: Finance's queue must
        // actually learn there is something to verify. `PosSaleService` escalates ONLY the one
        // `payment_verifications` INSERT (`PaymentVerificationsService.createSystemVerification`) and
        // restores the Kasir's own RLS context immediately after — which is exactly why a PLAIN
        // `client.query` here (still 'kasir', migration 095's `payment_verifications_role` RLS being
        // central-role-only for SELECT too) would see nothing: the escalation window closed, it
        // didn't leak. Uncommitted-row visibility rules out a second connection (this whole scenario
        // runs inside one rolled-back transaction), so this assertion borrows the SAME transient,
        // single-purpose escalation the test-support `withRollback`/`switchActor` pair already uses
        // for the void-approval steps above, then switches back to 'kasir' immediately after reading.
        await switchActor(client, { userId: fx.kasirId, roleKey: 'owner', locationIds: [] });
        const pv = await client.query(
          `SELECT amount, status, location_id FROM payment_verifications WHERE ref_type = 'sale_payment' AND ref_id = (SELECT id FROM sale_payments WHERE sale_id = $1)`,
          [transferSale.id],
        );
        await switchActor(client, {
          userId: fx.kasirId,
          roleKey: 'kasir',
          locationIds: [fx.locationId],
        });
        expect(pv.rows).toHaveLength(1);
        expect(pv.rows[0]!.status).toBe('pending');
        expect(pv.rows[0]!.amount).toBe(fx.productPrice);
        expect(pv.rows[0]!.location_id).toBe(fx.locationId);

        // Recipe explosion actually posted stock movements (D-07, via StockLedgerService — never a
        // hand-rolled balance write).
        const movementCount = await client.query(
          `SELECT COUNT(*) FROM stock_movements WHERE ref_type = 'sale' AND ref_id = $1`,
          [cashSale.id],
        );
        expect(Number(movementCount.rows[0].count)).toBeGreaterThan(0);

        // ── Void the cash sale, via ApprovalService — never hand-rolled (FR-POS-03, APR-02) ──
        const requested = await svc.voidRefunds.requestVoid(client, cashSale.id, fx.kasirId, {
          clientId: randomUUID(),
          type: VoidRefundType.VOID,
          reason: 'Pelanggan salah pesan',
        });
        expect(requested.status).toBe('pending');

        // The AUTHORIZATION is a separate real actor (Supervisor) — in production a second HTTP
        // request with its own `RlsContextGuard` pass; `switchActor` simulates that on this same
        // transaction so the test still sees the Kasir's just-written request (see that helper's
        // header).
        //
        // B-15: the supervisor no longer approves at the till. They ISSUE a one-time code from
        // their own session, and the kasir redeems it — so the session that commits the decision
        // is the KASIR's, while the decision itself is recorded against the supervisor.
        await switchActor(client, {
          userId: fx.supervisorId,
          roleKey: 'supervisor',
          locationIds: [fx.locationId],
        });
        const issued = await svc.approvalCodes.issue(client, {
          documentType: ApprovalDocumentType.VOID_REFUND,
          documentId: requested.voidRefundId,
          approver: { userId: fx.supervisorId, roleKey: RoleKey.SUPERVISOR },
        });
        await switchActor(client, {
          userId: fx.kasirId,
          roleKey: 'kasir',
          locationIds: [fx.locationId],
        });
        const approved = await svc.voidRefunds.approve(
          client,
          requested.voidRefundId,
          fx.kasirId,
          issued.code,
        );
        expect(approved.status).toBe('approved');
        expect(approved.offlineAuthorized).toBe(false);

        const voidedSale = await svc.sales.getById(client, cashSale.id);
        expect(voidedSale.status).toBe(SaleStatus.VOIDED);

        // The reversal actually posted a return_in movement (not just flipped a status column).
        const reversalCount = await client.query(
          `SELECT COUNT(*) FROM stock_movements WHERE ref_type = 'void_refund' AND movement_type = 'return_in'`,
          [],
        );
        expect(Number(reversalCount.rows[0].count)).toBeGreaterThan(0);

        // ── GoFood/ShopeeFood manual entry (FR-POS-05/07) — net-received maths is @mimi/shared's cart module ──
        const gross = '50000.00';
        const discount = '2000.00';
        const platformFee = '5000.00';
        const otherFee = '1000.00';
        const netReceived = '42000.00'; // 50000 - 2000 - 5000 - 1000
        const order = await svc.onlineOrders.create(client, fx.kasirId, {
          clientId: randomUUID(),
          locationId: fx.locationId,
          platform: OnlinePlatform.GOFOOD,
          orderRef: `GF-${randomUUID().slice(0, 8)}`,
          orderDate: new Date().toISOString().slice(0, 10),
          grossAmount: gross,
          discountAmount: discount,
          platformFee,
          otherFee,
          netReceived,
          status: OnlineOrderStatus.COMPLETED,
          shiftId: shift.id,
        });
        expect(order.netReceived).toBe(netReceived);

        await expect(
          svc.onlineOrders.create(client, fx.kasirId, {
            clientId: randomUUID(),
            locationId: fx.locationId,
            platform: OnlinePlatform.GOFOOD,
            orderRef: `GF-MISMATCH-${randomUUID().slice(0, 8)}`,
            orderDate: new Date().toISOString().slice(0, 10),
            grossAmount: gross,
            discountAmount: discount,
            platformFee,
            otherFee,
            netReceived: '99999.00', // deliberately wrong
            status: OnlineOrderStatus.COMPLETED,
          }),
        ).rejects.toMatchObject({ response: { code: 'ERR_NET_MISMATCH' } });

        // ── Tutup kasir with a shortfall (D-19) ─────────────────────────────
        // expectedCash = opening(100000) + cashSale(voided, so its cash payment nets out as a "cash
        // refund" too) => expectedCash returns to 100000.00 exactly. Count 10000 short of that.
        const closingCashCounted = '90000.00';
        const { shift: closedShift, report } = await svc.shifts.close(
          client,
          shift.id,
          fx.kasirId,
          { closingCashCounted },
        );
        expect(closedShift.status).toBe('closed');
        expect(closedShift.expectedCash).toBe('100000.00');
        expect(closedShift.cashVariance).toBe('-10000.00');
        expect(report.cashVarianceProposalId).not.toBeNull();
        expect(report.voids).toBe(1);
        expect(report.onlineOrders.find((o) => o.platform === OnlinePlatform.GOFOOD)?.net).toBe(
          netReceived,
        );

        const proposalId = report.cashVarianceProposalId!;
        const proposalRow = await client.query(
          `SELECT status, amount FROM cash_variance_proposals WHERE id = $1`,
          [proposalId],
        );
        expect(proposalRow.rows[0].status).toBe('pending');
        expect(proposalRow.rows[0].amount).toBe('10000.00');

        // ── Supervisor decides the proposal — reason mandatory, never offline-authorizable (§5.9) ──
        await expect(
          svc.cashVariances.approve(client, proposalId, fx.supervisorId, RoleKey.SUPERVISOR, ''),
        ).rejects.toMatchObject({ response: { code: 'ERR_REASON_REQUIRED' } });

        const decided = await svc.cashVariances.approve(
          client,
          proposalId,
          fx.supervisorId,
          RoleKey.SUPERVISOR,
          'Disetujui, potong gaji bulan ini',
        );
        expect(decided.status).toBe('approved');
        expect(decided.decisionReason).toBe('Disetujui, potong gaji bulan ini');
      },
    );
  }, 30_000);

  it('daily stock report reflects posted usage_out movements', async () => {
    await withRollback(
      { userId: fx.kasirId, roleKey: 'kasir', locationIds: [fx.locationId] },
      async (client) => {
        const svc = services();
        await neutralizeOpenShifts(client, fx.locationId);
        const shift = await svc.shifts.open(client, fx.kasirId, {
          clientId: randomUUID(),
          locationId: fx.locationId,
          openingCash: '50000.00',
        });
        const sale = await svc.sales.create(
          client,
          fx.kasirId,
          {
            clientId: randomUUID(),
            shiftId: shift.id,
            locationId: fx.locationId,
            occurredAt: new Date().toISOString(),
            lines: [{ productId: fx.productId, qty: '2.000', unitPrice: fx.productPrice }],
            payments: [
              { method: PaymentMethod.CASH, amount: (Number(fx.productPrice) * 2).toFixed(2) },
            ],
          },
          { roleKey: 'kasir', locationIds: [fx.locationId] },
        );
        expect(sale.status).toBe(SaleStatus.COMPLETED);

        // The BUSINESS date (WITA), not the UTC date. `toISOString().slice(0,10)`
        // was used here and is wrong for eight hours out of every twenty-four:
        // between 00:00 and 08:00 WITA the UTC date is still *yesterday*, so this
        // asked for yesterday's report while the sale it had just posted landed in
        // today's WITA business day — the report correctly returned nothing and the
        // test failed with "expected undefined to be defined".
        //
        // It therefore passed all afternoon and started failing after midnight WITA,
        // which reads exactly like a regression from unrelated work. `getReport`
        // windows on WITA via `businessDayBoundaries`; the caller must agree.
        const today = businessDateOf(new Date().toISOString());
        const report = await svc.dailyStock.getReport(client, fx.locationId, today);
        const usageRow = report.find((r) => Number(r.estimatedUsage) > 0);
        expect(usageRow).toBeDefined();
      },
    );
  }, 30_000);

  it('three-tier channel pricing (migration 249): a sale on each channel stores the unitPrice it was given (never re-derived from products.price) and still explodes stock', async () => {
    await withRollback(
      { userId: fx.kasirId, roleKey: 'kasir', locationIds: [fx.locationId] },
      async (client) => {
        const svc = services();
        await neutralizeOpenShifts(client, fx.locationId);
        const shift = await svc.shifts.open(client, fx.kasirId, {
          clientId: randomUUID(),
          locationId: fx.locationId,
          openingCash: '50000.00',
        });

        const usageOutCount = async () =>
          Number(
            (
              await client.query(
                `SELECT COUNT(*) AS n FROM stock_movements WHERE ref_type = 'sale' AND movement_type = 'usage_out'`,
              )
            ).rows[0].n,
          );
        const before = await usageOutCount();

        // GoFood price deliberately set HIGHER than the walk-in `fx.productPrice` to prove the
        // server stores the CALLER's channel price verbatim — re-deriving from `products.price` at
        // posting time (the bug this test guards against) would silently overwrite it and the
        // receipt/revenue would be wrong.
        const gofoodPrice = (Number(fx.productPrice) + 3000).toFixed(2);
        const gofoodSale = await svc.sales.create(
          client,
          fx.kasirId,
          {
            clientId: randomUUID(),
            shiftId: shift.id,
            locationId: fx.locationId,
            occurredAt: new Date().toISOString(),
            lines: [{ productId: fx.productId, qty: '1.000', unitPrice: gofoodPrice }],
            payments: [{ method: PaymentMethod.CASH, amount: gofoodPrice }],
            channel: 'gofood',
          },
          { roleKey: 'kasir', locationIds: [fx.locationId] },
        );
        expect(gofoodSale.channel).toBe('gofood');
        expect(gofoodSale.lines[0]!.unitPrice).toBe(gofoodPrice);
        expect(gofoodSale.lines[0]!.unitPrice).not.toBe(fx.productPrice);
        expect(gofoodSale.total).toBe(gofoodPrice); // the channel price, not the walk-in price, drives the total
        const afterGofood = await usageOutCount();
        expect(afterGofood).toBeGreaterThan(before); // recipe explosion still ran — the point of retiring online_orders
        const perSaleUsageRows = afterGofood - before; // fx.productId's recipe may post more than one ingredient line per sale

        const shopeefoodPrice = (Number(fx.productPrice) + 2500).toFixed(2);
        const shopeefoodSale = await svc.sales.create(
          client,
          fx.kasirId,
          {
            clientId: randomUUID(),
            shiftId: shift.id,
            locationId: fx.locationId,
            occurredAt: new Date().toISOString(),
            lines: [{ productId: fx.productId, qty: '1.000', unitPrice: shopeefoodPrice }],
            payments: [{ method: PaymentMethod.CASH, amount: shopeefoodPrice }],
            channel: 'shopeefood',
          },
          { roleKey: 'kasir', locationIds: [fx.locationId] },
        );
        expect(shopeefoodSale.channel).toBe('shopeefood');
        expect(shopeefoodSale.lines[0]!.unitPrice).toBe(shopeefoodPrice);
        expect(await usageOutCount()).toBe(before + perSaleUsageRows * 2);

        // `channel` omitted entirely (older app build / plain walk-in cart) defaults to 'walk_in' —
        // matches `sales.channel`'s own DB DEFAULT, never left NULL or rejected.
        const walkInSale = await svc.sales.create(
          client,
          fx.kasirId,
          {
            clientId: randomUUID(),
            shiftId: shift.id,
            locationId: fx.locationId,
            occurredAt: new Date().toISOString(),
            lines: [{ productId: fx.productId, qty: '1.000', unitPrice: fx.productPrice }],
            payments: [{ method: PaymentMethod.CASH, amount: fx.productPrice }],
          },
          { roleKey: 'kasir', locationIds: [fx.locationId] },
        );
        expect(walkInSale.channel).toBe('walk_in');
        expect(await usageOutCount()).toBe(before + perSaleUsageRows * 3);
      },
    );
  }, 30_000);

  it('shift-close report.onlineOrders is continuous across the 249 cutover — a sales.channel row is counted AND a pre-cutover online_orders row is still counted (migration 251 regression guard)', async () => {
    // This is the test that would have CAUGHT the ticket's bug: before migration 251,
    // `PosShiftService.buildReport`'s `onlineOrders` box read `online_orders` alone, so a
    // GoFood/ShopeeFood order rung up through `sales.channel` (the ONLY thing that writes new
    // online revenue since migration 249 retired `online_orders` as a write path) would
    // silently vanish from this box — while a genuinely pre-cutover `online_orders` row (still
    // real, still owed revenue) must NOT stop being counted just because the write path moved.
    // Both must be true in the SAME report for the fix to be right, which is why both are
    // asserted here rather than in two separate tests.
    await withRollback(
      { userId: fx.kasirId, roleKey: 'kasir', locationIds: [fx.locationId] },
      async (client) => {
        const svc = services();
        await neutralizeOpenShifts(client, fx.locationId);
        const shift = await svc.shifts.open(client, fx.kasirId, {
          clientId: randomUUID(),
          locationId: fx.locationId,
          openingCash: '50000.00',
        });

        // POST-cutover path: a GoFood order rung up as an ordinary channel sale.
        const gofoodPrice = '61000.00';
        await svc.sales.create(
          client,
          fx.kasirId,
          {
            clientId: randomUUID(),
            shiftId: shift.id,
            locationId: fx.locationId,
            occurredAt: new Date().toISOString(),
            lines: [{ productId: fx.productId, qty: '1.000', unitPrice: gofoodPrice }],
            payments: [{ method: PaymentMethod.CASH, amount: gofoodPrice }],
            channel: 'gofood',
          },
          { roleKey: 'kasir', locationIds: [fx.locationId] },
        );

        // PRE-cutover path, still live data: a ShopeeFood order recorded the OLD way
        // (`online_orders`, dormant as a write path for the app's own POS flow but still a
        // real historical record `PosOnlineOrderService.create` can still write — see that
        // service's header on why the table stays writable/readable).
        await svc.onlineOrders.create(client, fx.kasirId, {
          clientId: randomUUID(),
          locationId: fx.locationId,
          platform: OnlinePlatform.SHOPEEFOOD,
          orderRef: `MIG251-${randomUUID().slice(0, 8)}`,
          orderDate: businessDateOf(new Date()),
          grossAmount: '42000.00',
          discountAmount: '0.00',
          platformFee: '0.00',
          otherFee: '0.00',
          netReceived: '42000.00',
          status: OnlineOrderStatus.COMPLETED,
          shiftId: shift.id,
        });

        const { report } = await svc.shifts.close(client, shift.id, fx.kasirId, {
          closingCashCounted: '50000.00',
        });

        const byPlatform = new Map(report.onlineOrders.map((r) => [r.platform, r]));
        expect(byPlatform.get(OnlinePlatform.GOFOOD)).toEqual({
          platform: OnlinePlatform.GOFOOD,
          count: 1,
          net: gofoodPrice,
        });
        expect(byPlatform.get(OnlinePlatform.SHOPEEFOOD)).toEqual({
          platform: OnlinePlatform.SHOPEEFOOD,
          count: 1,
          net: '42000.00',
        });
      },
    );
  }, 30_000);

  it('a BATCH recipe (yield_qty > 1) posts stock scaled by qtySold ÷ yieldQty — regression guard for the flat-multiply bug', async () => {
    await withRollback(
      { userId: fx.kasirId, roleKey: 'kasir', locationIds: [fx.locationId] },
      async (client) => {
        const svc = services();
        await neutralizeOpenShifts(client, fx.locationId);

        // Test-LOCAL master data only (never the shared seed — other modules
        // depend on its current shape): a product whose recipe execution
        // yields 10 product units and consumes 2.000 units of one ingredient
        // per execution, i.e. 0.200 per product unit. `recipes`/`recipe_lines`
        // have no RLS (§1.14 NONE), so this insert needs no role escalation.
        const unitRes = await client.query<{ id: string }>(`SELECT id FROM units LIMIT 1`);
        const unitId = unitRes.rows[0]!.id;
        const suffix = randomUUID().slice(0, 8);

        const itemRes = await client.query<{ id: string }>(
          `INSERT INTO items (sku, name, base_unit_id, avg_cost) VALUES ($1,$2,$3,$4) RETURNING id`,
          [`TEST-BATCH-ITEM-${suffix}`, 'Test batch-recipe ingredient', unitId, '5000.00'],
        );
        const testItemId = itemRes.rows[0]!.id;

        const productRes = await client.query<{ id: string }>(
          `INSERT INTO products (code, name, category_id, price, is_active)
           VALUES ($1,$2,(SELECT id FROM product_categories WHERE name = 'Umum'),'10000.00',true)
           RETURNING id`,
          [`TEST-BATCH-${suffix}`, 'Test batch-recipe product'],
        );
        const testProductId = productRes.rows[0]!.id;

        const recipeRes = await client.query<{ id: string }>(
          `INSERT INTO recipes (product_id, yield_qty) VALUES ($1, '10.000') RETURNING id`,
          [testProductId],
        );
        const testRecipeId = recipeRes.rows[0]!.id;
        await client.query(
          `INSERT INTO recipe_lines (recipe_id, item_id, qty, unit_id) VALUES ($1,$2,'2.000',$3)`,
          [testRecipeId, testItemId, unitId],
        );

        const shift = await svc.shifts.open(client, fx.kasirId, {
          clientId: randomUUID(),
          locationId: fx.locationId,
          openingCash: '50000.00',
        });
        const sale = await svc.sales.create(
          client,
          fx.kasirId,
          {
            clientId: randomUUID(),
            shiftId: shift.id,
            locationId: fx.locationId,
            occurredAt: new Date().toISOString(),
            lines: [{ productId: testProductId, qty: '5.000', unitPrice: '10000.00' }],
            payments: [{ method: PaymentMethod.CASH, amount: '50000.00' }],
          },
          { roleKey: 'kasir', locationIds: [fx.locationId] },
        );
        expect(sale.status).toBe(SaleStatus.COMPLETED);

        // Hand-checked, not code-derived: recipe_qty(2.000) × (qtySold(5) ÷
        // yieldQty(10)) = 2.000 × 0.5 = 1.000. The bug this guards against
        // (`recipe_qty × qtySold` with no yield division) would have posted
        // 10.000 instead — 10× too much.
        const movements = await client.query<{ qty: string; movement_type: string }>(
          `SELECT qty, movement_type FROM stock_movements WHERE ref_type = 'sale' AND ref_id = $1 AND item_id = $2`,
          [sale.id, testItemId],
        );
        expect(movements.rows).toHaveLength(1);
        expect(movements.rows[0]!.movement_type).toBe('usage_out');
        expect(movements.rows[0]!.qty).toBe('1.000');
      },
    );
  }, 30_000);
});
