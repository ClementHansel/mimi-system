import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { PoolClient } from 'pg';
import { PaymentMethod, RoleKey } from '@mimi/shared';
import type { DomainEvent } from '../../kernel/events/domain-events';
import { PosCatalogService } from './services/pos-catalog.service';
import { PosShiftService } from './services/pos-shift.service';
import { PosSaleService } from './services/pos-sale.service';
import { CreateSaleDto } from './dto/sale.dto';
import { SalesReportService } from '../report/services/sales-report.service';
import { ChartOfAccountsService } from '../accounting/chart-of-accounts.service';
import { FiscalPeriodsService } from '../accounting/fiscal-periods.service';
import { JournalService } from '../accounting/journal.service';
import { PostingEngineService } from '../accounting/posting-engine.service';
import { DailyPostingService } from '../accounting/daily-posting.service';
import {
  buildApprovalService,
  buildEventBus,
  buildNotificationService,
  buildPaymentVerificationsService,
  buildStockLedgerService,
  buildVoucherRedemptionService,
  clearAuthLockouts,
  closePool,
  getAppPool,
  loadOutletFixture,
  neutralizeOpenShifts,
  withRollback,
  type OutletFixture,
} from './test-support/live-db';

/**
 * GrabFood as a first-class sales channel (migration 270), against the LIVE
 * database. Every assertion here is the `shopeefood` behaviour restated for
 * `grabfood`, because "mirrors shopeefood exactly" is the requirement:
 *
 *   1. a `channel: 'grabfood'` sale is accepted by the DTO, by the service and
 *      by `sales.channel`'s CHECK — and a made-up channel still is not;
 *   2. the POS catalog carries `priceGrabfood`, and a sale priced from it (or
 *      from `price` when it is NULL — the contract's fallback) is stored with
 *      exactly those line prices;
 *   3. the sale surfaces as platform `grabfood` in `mv_sales_daily`, in the
 *      `groupBy=channel` report and in the shift-close online box;
 *   4. a GrabFood day posts the same general-ledger legs as an identical
 *      ShopeeFood day. The posting rules key on `sale_payments.method`, never
 *      on `channel`, so this is the test that would catch anyone teaching the
 *      aggregator a per-channel branch.
 */

const SHOPEE_DAY = '2019-03-14';
const GRAB_DAY = '2019-03-15';

let fx: OutletFixture;

function services(pool = getAppPool()) {
  const eventBus = buildEventBus();
  return {
    catalog: new PosCatalogService(),
    shifts: new PosShiftService(pool, buildApprovalService(), buildNotificationService(pool)),
    sales: new PosSaleService(
      pool,
      buildStockLedgerService(eventBus),
      buildPaymentVerificationsService(pool),
      buildVoucherRedemptionService(),
    ),
  };
}

/** A product with NO recipe (so no stock plumbing is involved) and the given channel prices. */
async function insertProduct(
  client: PoolClient,
  price: string,
  priceGrabfood: string | null,
): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const res = await client.query<{ id: string }>(
    `INSERT INTO products (code, name, category_id, price, price_grabfood, is_active)
     VALUES ($1,$2,(SELECT id FROM product_categories WHERE name = 'Umum'),$3,$4,true)
     RETURNING id`,
    [`TEST-GRAB-${suffix}`, `Test grabfood product ${suffix}`, price, priceGrabfood],
  );
  return res.rows[0]!.id;
}

beforeAll(async () => {
  await clearAuthLockouts();
  fx = await loadOutletFixture();
}, 30_000);

afterAll(async () => {
  await clearAuthLockouts();
  await closePool();
});

describe('GrabFood sales channel (migration 270), live database', () => {
  it('the DTO and the DB CHECK accept grabfood and still refuse an unknown channel', async () => {
    const base = {
      clientId: randomUUID(),
      shiftId: randomUUID(),
      locationId: randomUUID(),
      occurredAt: new Date().toISOString(),
      lines: [{ productId: randomUUID(), qty: '1.000', unitPrice: '10000.00' }],
      payments: [{ method: 'cash', amount: '10000.00' }],
    };
    const ok = await validate(plainToInstance(CreateSaleDto, { ...base, channel: 'grabfood' }));
    expect(ok).toHaveLength(0);
    const bad = await validate(plainToInstance(CreateSaleDto, { ...base, channel: 'tokopedia' }));
    expect(bad.map((e) => e.property)).toContain('channel');

    await withRollback(
      { userId: fx.kasirId, roleKey: 'kasir', locationIds: [fx.locationId] },
      async (client) => {
        const svc = services();
        await neutralizeOpenShifts(client, fx.locationId);
        const shift = await svc.shifts.open(client, fx.kasirId, {
          clientId: randomUUID(),
          locationId: fx.locationId,
          openingCash: '0.00',
        });
        const probe = (channel: string) =>
          client.query(
            `INSERT INTO sales (receipt_number, client_id, location_id, shift_id, kasir_id, status,
                                subtotal, discount, total, paid_amount, change_amount, occurred_at, channel)
             VALUES ($1,$2,$3,$4,$5,'completed',1,0,1,1,0,now(),$6)`,
            [
              `CHK-${randomUUID().slice(0, 10)}`,
              randomUUID(),
              fx.locationId,
              shift.id,
              fx.kasirId,
              channel,
            ],
          );
        await expect(probe('grabfood')).resolves.toBeDefined();
        await client.query('SAVEPOINT bad');
        await expect(probe('tokopedia')).rejects.toThrow(/sales_channel_check/);
        await client.query('ROLLBACK TO SAVEPOINT bad');
      },
    );
  }, 30_000);

  it('is priced from price_grabfood, falls back to price when NULL, and is stored with exactly those line prices', async () => {
    await withRollback(
      { userId: fx.kasirId, roleKey: 'kasir', locationIds: [fx.locationId] },
      async (client) => {
        const svc = services();
        const withGrab = await insertProduct(client, '10000.00', '12500.00');
        const withoutGrab = await insertProduct(client, '8000.00', null);

        // The catalog payload the till prices from.
        const catalog = await svc.catalog.getCatalog(client);
        const rowWith = catalog.products.find((p) => p.id === withGrab)!;
        const rowWithout = catalog.products.find((p) => p.id === withoutGrab)!;
        expect(rowWith.priceGrabfood).toBe('12500.00');
        expect(rowWithout.priceGrabfood).toBeNull();

        // The contract's fallback, exactly as the till's `priceForChannel` applies it.
        const priceFor = (p: { price: string; priceGrabfood: string | null }) =>
          p.priceGrabfood ?? p.price;
        expect(priceFor(rowWith)).toBe('12500.00');
        expect(priceFor(rowWithout)).toBe('8000.00'); // never 0.00

        await neutralizeOpenShifts(client, fx.locationId);
        const shift = await svc.shifts.open(client, fx.kasirId, {
          clientId: randomUUID(),
          locationId: fx.locationId,
          openingCash: '0.00',
        });
        const sale = await svc.sales.create(
          client,
          fx.kasirId,
          {
            clientId: randomUUID(),
            shiftId: shift.id,
            locationId: fx.locationId,
            occurredAt: new Date().toISOString(),
            lines: [
              { productId: withGrab, qty: '2.000', unitPrice: priceFor(rowWith) },
              { productId: withoutGrab, qty: '1.000', unitPrice: priceFor(rowWithout) },
            ],
            payments: [{ method: PaymentMethod.QRIS, amount: '33000.00' }],
            channel: 'grabfood',
          },
          { roleKey: 'kasir', locationIds: [fx.locationId] },
        );
        expect(sale.channel).toBe('grabfood');
        expect(sale.total).toBe('33000.00'); // 2 x 12.500 + 8.000
        expect(sale.lines.map((l) => l.unitPrice).sort()).toEqual(['12500.00', '8000.00']);
      },
    );
  }, 30_000);

  it('shows up as platform grabfood in mv_sales_daily, the channel report and the shift-close box', async () => {
    await withRollback(
      { userId: fx.kasirId, roleKey: 'kasir', locationIds: [fx.locationId] },
      async (client) => {
        const svc = services();
        const productId = await insertProduct(client, '10000.00', '12500.00');
        await neutralizeOpenShifts(client, fx.locationId);
        const shift = await svc.shifts.open(client, fx.kasirId, {
          clientId: randomUUID(),
          locationId: fx.locationId,
          openingCash: '0.00',
        });
        const occurredAt = '2019-03-16T12:00:00+08:00'; // far from any seeded or live date
        await svc.sales.create(
          client,
          fx.kasirId,
          {
            clientId: randomUUID(),
            shiftId: shift.id,
            locationId: fx.locationId,
            occurredAt,
            lines: [{ productId, qty: '1.000', unitPrice: '12500.00' }],
            payments: [{ method: PaymentMethod.QRIS, amount: '12500.00' }],
            channel: 'grabfood',
          },
          { roleKey: 'kasir', locationIds: [fx.locationId] },
        );

        // mv_sales_daily — the online-vs-walk-in split every dashboard reads.
        await client.query(`SELECT refresh_dashboard_matview('mv_sales_daily')`);
        const mv = await client.query<{ gross: string; tx_count: string }>(
          `SELECT gross, tx_count FROM mv_sales_daily
            WHERE location_id = $1 AND sales_date = '2019-03-16' AND platform = 'grabfood'`,
          [fx.locationId],
        );
        expect(mv.rows).toHaveLength(1);
        expect(mv.rows[0]!.gross).toBe('12500.00');
        expect(Number(mv.rows[0]!.tx_count)).toBe(1);

        // groupBy=channel
        const report = await new SalesReportService().getSalesReport(
          client,
          { userId: fx.kasirId, roleKey: RoleKey.KASIR, locationScope: [fx.locationId] },
          { groupBy: 'channel', from: '2019-03-16', to: '2019-03-16', locationId: fx.locationId },
        );
        const grab = report.rows.find((r) => r.groupKey === 'grabfood');
        expect(grab).toMatchObject({ txCount: 1, gross: '12500.00', net: '12500.00' });
        expect(report.rows.find((r) => r.groupKey === 'shopeefood')).toBeUndefined();

        // shift-close online box
        const closed = await svc.shifts.close(client, shift.id, fx.kasirId, {
          closingCashCounted: '0.00',
        });
        expect(closed.report.onlineOrders).toContainEqual({
          platform: 'grabfood',
          count: 1,
          net: '12500.00',
        });
      },
    );
  }, 30_000);

  it('a GrabFood day posts the same GL legs as an identical ShopeeFood day (Dr 1031 QRIS / Cr 4000)', async () => {
    await withRollback(
      { userId: fx.ownerId, roleKey: 'owner', locationIds: [fx.locationId] },
      async (client) => {
        const svc = services();
        const productId = await insertProduct(client, '10000.00', '12500.00');
        await neutralizeOpenShifts(client, fx.locationId);
        const shiftId = randomUUID();
        await client.query(
          `INSERT INTO pos_shifts (id, client_id, location_id, opened_by, shift_number, opening_cash, status, opened_at)
           VALUES ($1,$2,$3,$4,$5,'0.00','open', now())`,
          [shiftId, randomUUID(), fx.locationId, fx.kasirId, `GRABGL-${shiftId.slice(0, 12)}`],
        );

        const ring = (channel: 'shopeefood' | 'grabfood', day: string) =>
          svc.sales.create(
            client,
            fx.kasirId,
            {
              clientId: randomUUID(),
              shiftId,
              locationId: fx.locationId,
              occurredAt: `${day}T12:00:00+08:00`,
              lines: [{ productId, qty: '4.000', unitPrice: '12500.00' }],
              payments: [{ method: PaymentMethod.QRIS, amount: '50000.00' }],
              channel,
            },
            { roleKey: 'owner', locationIds: [fx.locationId] },
          );
        await ring('shopeefood', SHOPEE_DAY);
        await ring('grabfood', GRAB_DAY);

        const journal = new JournalService(
          new ChartOfAccountsService(),
          new FiscalPeriodsService(),
        );
        const engine = new PostingEngineService(getAppPool(), buildEventBus(), journal);

        const legsFor = async (day: string) => {
          const bus = buildEventBus();
          const events: DomainEvent<'journal.action'>[] = [];
          bus.subscribe('journal.action', (e) => {
            events.push(e);
          });
          const daily = new DailyPostingService(bus);
          const result = await daily.postBusinessDay(client, fx.locationId, day);
          expect(result.byMethod).toEqual({ qris: '50000.00' });
          const ev = events.find((e) => e.payload.eventType === 'outlet_sales')!;
          await engine.postForEvent(client, ev);
          const lines = await client.query<{ account_code: string; debit: string; credit: string }>(
            `SELECT a.code AS account_code, l.debit, l.credit
               FROM journal_entries e
               JOIN journal_lines l ON l.entry_id = e.id
               JOIN chart_of_accounts a ON a.id = l.account_id
              WHERE e.event_type = 'outlet_sales' AND e.ref_type = 'sale_day' AND e.ref_id = $1
              ORDER BY a.code`,
            [ev.payload.documentId],
          );
          return lines.rows;
        };

        const shopeeLegs = await legsFor(SHOPEE_DAY);
        const grabLegs = await legsFor(GRAB_DAY);

        expect(grabLegs).toEqual(shopeeLegs);
        expect(grabLegs).toEqual([
          { account_code: '1031', debit: '50000.00', credit: '0.00' },
          { account_code: '4000', debit: '0.00', credit: '50000.00' },
        ]);
      },
    );
  }, 60_000);
});
