/**
 * B-16 — proof that POS revenue and COGS now reach the general ledger.
 *
 * `waste-gl-posting.spec.ts` and `pos-online-order-gl-posting.spec.ts` pin the
 * BROKEN half of B-16 (services that post stock but never publish a journal
 * event). This file is the other side: `DailyPostingService` is the missing
 * JOUT-02/JOUT-03 aggregator, and these tests fail if it stops posting, stops
 * balancing, or starts double-posting.
 *
 * Why the posting engine is driven via `postForEvent(client, …)` rather than
 * by letting `EventBus` reach the real subscriber: the engine's own
 * subscriber runs `withSystemContext` against the POOL, i.e. a different
 * connection, which could neither see this test's uncommitted sales nor be
 * undone by its rollback. `postForEvent` exists for exactly this reason (see
 * its doc comment). The path from `publish` to that subscriber is wired in
 * `PostingEngineService.onModuleInit` and covered by the module's own
 * integration spec.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import type { DomainEvent } from '../../kernel/events/domain-events';
import { ChartOfAccountsService } from './chart-of-accounts.service';
import { FiscalPeriodsService } from './fiscal-periods.service';
import { JournalService } from './journal.service';
import { PostingEngineService } from './posting-engine.service';
import { DailyPostingService } from './daily-posting.service';
import {
  buildEventBus,
  closePool,
  getAppPool,
  loadOutletFixture,
  withRollback,
  type OutletFixture,
} from '../pos/test-support/live-db';

vi.setConfig({ testTimeout: 30_000 });

let fx: OutletFixture;

/** A date far enough in the past that no seeded or concurrently-running suite has sales on it, so the aggregate under test is exactly what this test inserted. */
const TEST_DAY = '2019-03-14';

interface Captured {
  events: DomainEvent<'journal.action'>[];
  daily: DailyPostingService;
}

function buildDaily(): Captured {
  const bus = buildEventBus();
  const events: DomainEvent<'journal.action'>[] = [];
  bus.subscribe('journal.action', (e) => {
    events.push(e);
  });
  return { events, daily: new DailyPostingService(bus) };
}

function buildEngine(pool: Pool): PostingEngineService {
  const journal = new JournalService(new ChartOfAccountsService(), new FiscalPeriodsService());
  return new PostingEngineService(pool, buildEventBus(), journal);
}

/** Inserts one completed sale with the given payment split, returning nothing durable — the caller's transaction is always rolled back. */
async function insertSale(
  client: PoolClient,
  fixture: OutletFixture,
  shiftId: string,
  opts: { total: string; change: string; payments: Array<{ method: string; amount: string }> },
): Promise<string> {
  const saleId = randomUUID();
  const paid = opts.payments.reduce((a, p) => a + Number.parseFloat(p.amount), 0).toFixed(2);
  await client.query(
    `INSERT INTO sales (id, receipt_number, client_id, location_id, shift_id, kasir_id, status,
                        subtotal, discount, total, paid_amount, change_amount, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'completed', $7, 0, $7, $8, $9, $10::timestamptz)`,
    [
      saleId,
      `R-${saleId.slice(0, 12)}`,
      randomUUID(),
      fixture.locationId,
      shiftId,
      fixture.kasirId,
      opts.total,
      paid,
      opts.change,
      `${TEST_DAY}T12:00:00+08:00`,
    ],
  );
  for (const p of opts.payments) {
    await client.query(
      `INSERT INTO sale_payments (sale_id, method, amount, payment_status)
       VALUES ($1, $2, $3, 'paid')`,
      [saleId, p.method, p.amount],
    );
  }
  return saleId;
}

async function openShift(client: PoolClient, fixture: OutletFixture): Promise<string> {
  const shiftId = randomUUID();
  await client.query(
    `INSERT INTO pos_shifts (id, client_id, location_id, opened_by, shift_number, opening_cash,
                             status, opened_at)
     VALUES ($1, $2, $3, $4, $5, '0.00', 'open', $6::timestamptz)`,
    [
      shiftId,
      randomUUID(),
      fixture.locationId,
      fixture.kasirId,
      `GLTEST-${shiftId.slice(0, 12)}`, // shift_number is globally UNIQUE
      `${TEST_DAY}T08:00:00+08:00`,
    ],
  );
  return shiftId;
}

describe.skipIf(!process.env.DATABASE_URL)(
  'DailyPostingService — JOUT-02/JOUT-03 daily GL aggregation (B-16), live database',
  () => {
    beforeAll(async () => {
      fx = await loadOutletFixture();
    }, 30_000);

    afterAll(async () => {
      await closePool();
    });

    it('a completed cash sale reaches the general ledger as Dr 1000 / Cr 4000', async () => {
      await withRollback(
        { userId: fx.ownerId, roleKey: 'owner', locationIds: [fx.locationId] },
        async (client) => {
          const shiftId = await openShift(client, fx);
          await insertSale(client, fx, shiftId, {
            total: '50000.00',
            change: '0.00',
            payments: [{ method: 'cash', amount: '50000.00' }],
          });

          const { events, daily } = buildDaily();
          const result = await daily.postBusinessDay(client, fx.locationId, TEST_DAY);

          expect(result.salesTotal).toBe('50000.00');
          expect(result.byMethod).toEqual({ cash: '50000.00' });

          const salesEvent = events.find((e) => e.payload.eventType === 'outlet_sales');
          expect(salesEvent).toBeDefined();

          await buildEngine(getAppPool()).postForEvent(client, salesEvent!);

          const lines = await client.query<{ account_code: string; debit: string; credit: string }>(
            `SELECT a.code AS account_code, l.debit, l.credit
               FROM journal_entries e
               JOIN journal_lines l ON l.entry_id = e.id
               JOIN chart_of_accounts a ON a.id = l.account_id
              WHERE e.event_type = 'outlet_sales' AND e.ref_type = 'sale_day'
                AND e.ref_id = $1
              ORDER BY a.code`,
            [salesEvent!.payload.documentId],
          );

          expect(lines.rowCount).toBe(2);
          const debit = lines.rows.find((r) => Number.parseFloat(r.debit) > 0);
          const credit = lines.rows.find((r) => Number.parseFloat(r.credit) > 0);
          expect(debit?.account_code).toBe('1000'); // Kas outlet
          expect(credit?.account_code).toBe('4000'); // Pendapatan Penjualan
          expect(debit?.debit).toBe('50000.00');
          expect(credit?.credit).toBe('50000.00');
        },
      );
    });

    it('the cash leg is net of change given, so a split-payment day still balances', async () => {
      await withRollback(
        { userId: fx.ownerId, roleKey: 'owner', locationIds: [fx.locationId] },
        async (client) => {
          const shiftId = await openShift(client, fx);
          // Customer hands over 100k for a 75k sale and takes 25k back; a
          // second sale is paid by QRIS. Summing raw payments would debit
          // 130k against 105k of revenue — the entry would never balance.
          await insertSale(client, fx, shiftId, {
            total: '75000.00',
            change: '25000.00',
            payments: [{ method: 'cash', amount: '100000.00' }],
          });
          await insertSale(client, fx, shiftId, {
            total: '30000.00',
            change: '0.00',
            payments: [{ method: 'qris', amount: '30000.00' }],
          });

          const { events, daily } = buildDaily();
          const result = await daily.postBusinessDay(client, fx.locationId, TEST_DAY);

          expect(result.salesTotal).toBe('105000.00');
          expect(result.byMethod).toEqual({ cash: '75000.00', qris: '30000.00' });

          const salesEvent = events.find((e) => e.payload.eventType === 'outlet_sales')!;
          await buildEngine(getAppPool()).postForEvent(client, salesEvent);

          const totals = await client.query<{ debit: string; credit: string }>(
            `SELECT COALESCE(SUM(l.debit), 0) AS debit, COALESCE(SUM(l.credit), 0) AS credit
               FROM journal_entries e
               JOIN journal_lines l ON l.entry_id = e.id
              WHERE e.event_type = 'outlet_sales' AND e.ref_id = $1`,
            [salesEvent.payload.documentId],
          );
          expect(totals.rows[0]!.debit).toBe('105000.00');
          expect(totals.rows[0]!.credit).toBe('105000.00');
        },
      );
    });

    it('re-running the same day does not double-post revenue', async () => {
      await withRollback(
        { userId: fx.ownerId, roleKey: 'owner', locationIds: [fx.locationId] },
        async (client) => {
          const shiftId = await openShift(client, fx);
          await insertSale(client, fx, shiftId, {
            total: '40000.00',
            change: '0.00',
            payments: [{ method: 'cash', amount: '40000.00' }],
          });

          const { events, daily } = buildDaily();
          const engine = buildEngine(getAppPool());
          await daily.postBusinessDay(client, fx.locationId, TEST_DAY);
          await daily.postBusinessDay(client, fx.locationId, TEST_DAY);

          const salesEvents = events.filter((e) => e.payload.eventType === 'outlet_sales');
          expect(salesEvents).toHaveLength(2);
          // Same derived ref_id both times — that is what makes the replay a
          // no-op rather than a second set of journal lines.
          expect(salesEvents[0]!.payload.documentId).toBe(salesEvents[1]!.payload.documentId);

          for (const e of salesEvents) await engine.postForEvent(client, e);

          const entries = await client.query<{ count: string }>(
            `SELECT COUNT(*) AS count FROM journal_entries
              WHERE event_type = 'outlet_sales' AND ref_id = $1`,
            [salesEvents[0]!.payload.documentId],
          );
          expect(entries.rows[0]!.count).toBe('1');
        },
      );
    });

    it('a day with no trading posts nothing at all', async () => {
      await withRollback(
        { userId: fx.ownerId, roleKey: 'owner', locationIds: [fx.locationId] },
        async (client) => {
          const { events, daily } = buildDaily();
          const result = await daily.postBusinessDay(client, fx.locationId, '2019-03-15');

          expect(result.posted).toBe(false);
          expect(result.salesTotal).toBe('0.00');
          expect(events).toHaveLength(0);
        },
      );
    });
  },
);
