/**
 * Integration tests against the LIVE database (BUILD-PLAN §5/§8 idiom,
 * mirrored from `kernel/stock-opname/stock-opname.integration.spec.ts`).
 * Every test runs inside its own `withRollbackAs` transaction and ROLLBACKs
 * at the end — nothing here durably mutates the seed. REAL roles
 * (`finance`, `owner`, `kasir`) in session context throughout, never
 * hardcoded `'owner'`, per this module's brief.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ERR_PROOF_REQUIRED, ERR_UNBALANCED_ENTRY, PayeeType, PaymentVerificationRefType, RoleKey } from '@mimi/shared';

vi.setConfig({ testTimeout: 20_000 });

import { EventBus } from '../../kernel/events/event-bus.service';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';
import { SyncEventsRepository } from '../../kernel/sync/sync-events.repository';
import { SyncConflictsRepository } from '../../kernel/sync/sync-conflicts.repository';
import { ConflictDetectorService } from '../../kernel/sync/conflict-detector.service';

import { ChartOfAccountsService } from './chart-of-accounts.service';
import { FiscalPeriodsService } from './fiscal-periods.service';
import { JournalService } from './journal.service';
import { PostingEngineService } from './posting-engine.service';
import { PaymentVerificationsService, type PaymentActor } from './payment-verifications.service';

import { appPoolForDi, closePool, loadFixtures, withRollbackAs, type Fixtures } from './test-support/live-db';

describe('M17 accounting — live DB integration', () => {
  let fixtures: Fixtures;
  const coa = new ChartOfAccountsService();
  const periods = new FiscalPeriodsService();
  const journal = new JournalService(coa, periods);
  const eventBus = new EventBus();
  const postingEngine = new PostingEngineService(appPoolForDi(), eventBus, journal);
  const syncEvents = new SyncEventsRepository();
  const syncConflicts = new SyncConflictsRepository();
  const conflictDetector = new ConflictDetectorService(syncConflicts);
  const syncEmit = new SyncEmitService(syncEvents, conflictDetector);
  const payments = new PaymentVerificationsService(syncEmit, eventBus);

  beforeAll(async () => {
    fixtures = await loadFixtures();
  });

  afterAll(async () => {
    await closePool();
  });

  function actor(roleKey: RoleKey, locationScope: readonly string[] | null = null): PaymentActor {
    return { userId: fixtures.usersByRole[roleKey], roleKey, locationScope };
  }

  // ── chart of accounts (real 'finance' role) ─────────────────────────────

  it('finance can read the seeded chart of accounts', async () => {
    await withRollbackAs({ role: RoleKey.FINANCE, userId: fixtures.usersByRole[RoleKey.FINANCE], locationIds: [] }, async (client) => {
      const accounts = await coa.list(client, {});
      expect(accounts.length).toBeGreaterThanOrEqual(28); // §6.1 seeds 29 codes
      expect(accounts.find((a) => a.code === '1100')?.name).toBe('Persediaan Gudang');
      expect(accounts.every((a) => a.isSystem)).toBe(true); // none of the §6.1 seed rows are manual additions
    });
  });

  // ── fiscal periods: camelCase wire shape (coordinator-flagged regression — the finance UI's
  // `FiscalPeriodRow` was coded against a live snake_case leak; `list`/`close`/`reopen` must return
  // exactly CONTRACTS.md §4.17's `{id; periodCode; startDate; endDate; status}`, never the raw
  // `pg` row (`period_code`/`start_date`/`closed_at`), matching every other endpoint in this module.
  it('GET periods returns camelCase, never the raw snake_case pg row', async () => {
    await withRollbackAs({ role: RoleKey.FINANCE, userId: fixtures.usersByRole[RoleKey.FINANCE], locationIds: [] }, async (client) => {
      const list = await periods.list(client);
      expect(list.length).toBeGreaterThan(0);
      const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
      for (const p of list) {
        expect(p).toEqual(expect.objectContaining({ id: expect.any(String), periodCode: expect.any(String), startDate: expect.stringMatching(dateOnly), endDate: expect.stringMatching(dateOnly), status: expect.any(String) }));
        // `startDate`/`endDate` must be plain 'YYYY-MM-DD' (CONTRACTS.md's `ISODate`), never a `Date`
        // object's default JSON serialization — `node-pg` parses `DATE` columns via a LOCAL-timezone
        // constructor, so a raw `.toISOString()` shifts the calendar day by the server's UTC offset
        // (Asia/Makassar, UTC+8) — the exact symptom that first caught this (see `formatDateOnly`'s
        // doc comment in `accounting.types.ts`). Anchoring `startDate` to `periodCode`'s own month
        // catches that shift directly: a one-day-back leak would fail this line even though the regex
        // above alone would not (an ISO datetime's date portion still matches `\d{4}-\d{2}-\d{2}`).
        expect(p.startDate.slice(0, 7)).toBe(p.periodCode);
        expect(p).not.toHaveProperty('period_code');
        expect(p).not.toHaveProperty('start_date');
        expect(p).not.toHaveProperty('end_date');
        expect(p).not.toHaveProperty('closed_by');
        expect(p).not.toHaveProperty('closed_at');
      }
    });
  });

  it('POST periods/:id/close and /reopen also return camelCase', async () => {
    await withRollbackAs({ role: RoleKey.OWNER, userId: fixtures.usersByRole[RoleKey.OWNER], locationIds: [] }, async (client) => {
      const list = await periods.list(client);
      const openPeriod = list.find((p) => p.status === 'open');
      expect(openPeriod).toBeTruthy();

      const closed = await periods.close(client, openPeriod!.id, fixtures.usersByRole[RoleKey.OWNER], undefined);
      expect(closed.status).toBe('closed');
      expect(closed.periodCode).toBe(openPeriod!.periodCode);
      expect(closed).not.toHaveProperty('period_code');

      const reopened = await periods.reopen(client, openPeriod!.id, 'test: verifying camelCase shape');
      expect(reopened.status).toBe('open');
      expect(reopened).not.toHaveProperty('closed_at');
    });
  });

  // ── manual journal entry: balanced succeeds, unbalanced is rejected ─────

  it('a balanced manual entry posts; an unbalanced one is rejected with ERR_UNBALANCED_ENTRY', async () => {
    await withRollbackAs({ role: RoleKey.FINANCE, userId: fixtures.usersByRole[RoleKey.FINANCE], locationIds: [] }, async (client) => {
      const entryDate = new Date().toISOString().slice(0, 10);
      const entry = await journal.postManual(client, fixtures.usersByRole[RoleKey.FINANCE], {
        entryDate,
        description: 'Test: pembelian tunai perlengkapan',
        lines: [
          { accountCode: '6100', debit: '150000.00' },
          { accountCode: '1000', credit: '150000.00' },
        ],
      });
      expect(entry.status).toBe('posted');
      // `entryDate` must round-trip exactly as submitted, never shifted by a day (the same `pg`
      // DATE-parsing/local-timezone gotcha `formatDateOnly` exists to close — see periods' test above).
      expect(entry.entryDate).toBe(entryDate);
      expect(entry.lines).toHaveLength(2);
      const debitTotal = entry.lines.reduce((s, l) => s + Number(l.debit), 0);
      const creditTotal = entry.lines.reduce((s, l) => s + Number(l.credit), 0);
      expect(debitTotal).toBe(creditTotal);

      await expect(
        journal.postManual(client, fixtures.usersByRole[RoleKey.FINANCE], {
          entryDate: new Date().toISOString().slice(0, 10),
          description: 'Test: unbalanced entry must be rejected, never auto-corrected',
          lines: [
            { accountCode: '6100', debit: '150000.00' },
            { accountCode: '1000', credit: '100000.00' },
          ],
        }),
      ).rejects.toMatchObject({ response: { code: ERR_UNBALANCED_ENTRY } });
    });
  });

  // ── the "permission denied" pin (carried item #3's actual RLS gap) ──────

  it('PERMISSION DENIED PIN: a raw INSERT into payment_verifications under a real kasir session is rejected by RLS', async () => {
    await withRollbackAs({ role: RoleKey.KASIR, userId: fixtures.usersByRole[RoleKey.KASIR], locationIds: [fixtures.outletId] }, async (client) => {
      await expect(
        client.query(
          `INSERT INTO payment_verifications (pv_number, ref_type, payee_type, amount, submitted_by, location_id)
           VALUES ('PV/TEST/00001', 'sale_payment', 'other', '75000.00', $1, $2)`,
          [fixtures.usersByRole[RoleKey.KASIR], fixtures.outletId],
        ),
      ).rejects.toThrow(/row-level security|permission denied/i);
    });
  });

  it('CARRIED ITEM #3 FIX: PaymentVerificationsService.create() succeeds for a real kasir session (escalated insert, then restores kasir scope)', async () => {
    await withRollbackAs({ role: RoleKey.KASIR, userId: fixtures.usersByRole[RoleKey.KASIR], locationIds: [fixtures.outletId] }, async (client) => {
      const created = await payments.create(client, actor(RoleKey.KASIR, [fixtures.outletId]), {
        refType: PaymentVerificationRefType.SALE_PAYMENT,
        payeeType: PayeeType.OTHER,
        amount: '250000.00',
        locationId: fixtures.outletId,
      });
      expect(created.status).toBe('pending');

      // Session context must be restored to 'kasir' after the escalated INSERT — verify the very next
      // statement on this SAME client is still under the kasir's real (narrow) RLS scope, not left
      // running as the central-role bypass `escalatedInsert` used internally.
      const roleCheck = await client.query(`SELECT current_setting('app.role', true) AS role`);
      expect(roleCheck.rows[0].role).toBe(RoleKey.KASIR);
    });
  });

  // ── payment verification ladder (FR-ACCT-01..04), real finance role ────

  it('Pending -> Verified -> Paid ladder: verify without proof is ERR_PROOF_REQUIRED; the happy path completes and dispatches the right journal.action', async () => {
    await withRollbackAs({ role: RoleKey.FINANCE, userId: fixtures.usersByRole[RoleKey.FINANCE], locationIds: [] }, async (client) => {
      const financeActor = actor(RoleKey.FINANCE);
      const pv = await payments.create(client, financeActor, {
        refType: PaymentVerificationRefType.OTHER,
        payeeType: PayeeType.OTHER,
        amount: '500000.00',
        locationId: fixtures.outletId,
      });

      await expect(payments.verify(client, financeActor, pv.id, undefined)).rejects.toMatchObject({ response: { code: ERR_PROOF_REQUIRED } });

      // Attach proof via a real attachments row (owner pool would be needed for a genuine upload;
      // here a lightweight fixture row is enough to satisfy the FK + ERR_PROOF_REQUIRED gate).
      const attachment = await client.query<{ id: string }>(
        `INSERT INTO attachments (object_key, file_name, mime_type, size_bytes, kind, uploaded_by)
         VALUES ($1,'proof.jpg','image/jpeg',12345,'payment_proof',$2) RETURNING id`,
        [`test/proof-${Date.now()}.jpg`, fixtures.usersByRole[RoleKey.FINANCE]],
      );
      await payments.uploadProof(client, financeActor, pv.id, attachment.rows[0]!.id);

      const verified = await payments.verify(client, financeActor, pv.id, 'ok');
      expect(verified.status).toBe('verified');

      let publishedEventType: string | undefined;
      const unsubscribe = eventBus.subscribe('journal.action', (e) => {
        publishedEventType = e.payload.eventType;
      });
      try {
        const paid = await payments.pay(client, financeActor, pv.id, { paidVia: 'cash' });
        expect(paid.status).toBe('paid');
        // ref_type='other' + a real outlet location -> JOUT-09 outlet_operating_expense (§6.2).
        expect(publishedEventType).toBe('outlet_operating_expense');
      } finally {
        unsubscribe();
      }
    });
  });

  // ── the posting engine: every one of the 16 PRD + 7 system extension event
  // types, from a constructed-but-realistic domain event, produces a
  // balanced entry (module "done when" bar). Driven via `postForEvent`
  // directly on THIS rolled-back client (see that method's doc comment) so
  // nothing here durably writes outside the transaction. ─────────────────

  const cases: { eventType: string; amount: string; context: Record<string, unknown> }[] = [
    { eventType: 'gudang_purchase', amount: '1200000.00', context: {} },
    { eventType: 'gudang_goods_in', amount: '300000.00', context: {} },
    { eventType: 'gudang_goods_out_to_outlet', amount: '450000.00', context: {} },
    { eventType: 'gudang_return_to_supplier', amount: '80000.00', context: {} },
    { eventType: 'gudang_waste', amount: '60000.00', context: {} },
    { eventType: 'gudang_stock_adjustment', amount: '15000.00', context: { direction: 'shortage' } },
    { eventType: 'gudang_stock_adjustment', amount: '15000.00', context: { direction: 'overage' } },
    { eventType: 'gudang_stock_revaluation', amount: '9000.00', context: { direction: 'up' } },
    { eventType: 'outlet_goods_in_from_warehouse', amount: '450000.00', context: { discrepancy: false, shortfall: '0.00' } },
    { eventType: 'outlet_ingredient_usage', amount: '220000.00', context: {} },
    { eventType: 'outlet_sales', amount: '100000.00', context: { method: 'cash' } },
    { eventType: 'outlet_waste', amount: '30000.00', context: {} },
    { eventType: 'outlet_return_to_warehouse', amount: '40000.00', context: {} },
    { eventType: 'outlet_stock_adjustment', amount: '12000.00', context: { direction: 'overage' } },
    { eventType: 'outlet_direct_purchase', amount: '95000.00', context: { source: 'petty_cash' } },
    { eventType: 'outlet_petty_cash', amount: '50000.00', context: {} },
    { eventType: 'outlet_operating_expense', amount: '75000.00', context: { paidVia: 'cash' } },
    { eventType: 'payroll_payment', amount: '2000000.00', context: {} },
    { eventType: 'qris_settlement', amount: '300000.00', context: {} },
    { eventType: 'transfer_verified', amount: '400000.00', context: {} },
    { eventType: 'platform_settlement', amount: '600000.00', context: {} },
    { eventType: 'offline_auth_rejected', amount: '45000.00', context: { source: 'refund_or_void' } },
    { eventType: 'petty_cash_topup', amount: '500000.00', context: {} },
    { eventType: 'employee_loan_disbursement', amount: '1000000.00', context: {} },
  ];

  it.each(cases)('posting engine: $eventType produces a balanced posted entry', async ({ eventType, amount, context }) => {
    await withRollbackAs({ role: RoleKey.OWNER, userId: fixtures.usersByRole[RoleKey.OWNER], locationIds: [] }, async (client) => {
      const documentId = fixtures.itemId; // any real UUID works as ref_id — engine never dereferences it except for sale_void_reversal
      await postingEngine.postForEvent(client, {
        type: 'journal.action',
        occurredAt: new Date().toISOString(),
        payload: { eventType, documentType: 'test_fixture', documentId, locationId: fixtures.outletId, amount, context, occurredAt: new Date().toISOString() },
      });

      const res = await client.query<{ id: string }>(
        `SELECT id FROM journal_entries WHERE event_type = $1 AND ref_type = 'test_fixture' AND ref_id = $2`,
        [eventType, documentId],
      );
      expect(res.rows.length).toBe(1);
      const detail = await journal.getDetail(client, res.rows[0]!.id);
      expect(detail.status).toBe('posted');
      const debitTotal = detail.lines.reduce((s, l) => s + Number(l.debit), 0);
      const creditTotal = detail.lines.reduce((s, l) => s + Number(l.credit), 0);
      expect(debitTotal).toBeCloseTo(creditTotal, 5);
      expect(debitTotal).toBeGreaterThan(0);
    });
  });

  // ── payroll_accrual (X1/X1s, multi-leg) and sale_void_reversal (X6, DB-dependent) get their own
  // dedicated cases — the former needs a richer context, the latter needs real fixture rows. ──────

  it('posting engine: payroll_accrual (X1) combines gross + net + loan + SO-shortfall legs into ONE balanced entry', async () => {
    await withRollbackAs({ role: RoleKey.OWNER, userId: fixtures.usersByRole[RoleKey.OWNER], locationIds: [] }, async (client) => {
      const documentId = fixtures.itemId;
      await postingEngine.postForEvent(client, {
        type: 'journal.action',
        occurredAt: new Date().toISOString(),
        payload: {
          eventType: 'payroll_accrual', documentType: 'test_fixture', documentId, locationId: null,
          amount: '0.00',
          context: { grossAmount: '50000000.00', loanDeductionTotal: '3000000.00', soShortfallDeductionTotal: '2000000.00' },
          occurredAt: new Date().toISOString(),
        },
      });
      const res = await client.query<{ id: string }>(`SELECT id FROM journal_entries WHERE event_type = 'payroll_accrual' AND ref_id = $1`, [documentId]);
      const detail = await journal.getDetail(client, res.rows[0]!.id);
      expect(detail.lines).toHaveLength(6); // 3 legs x 2 lines
      const debitTotal = detail.lines.reduce((s, l) => s + Number(l.debit), 0);
      const creditTotal = detail.lines.reduce((s, l) => s + Number(l.credit), 0);
      // Each leg is independently balanced (gross->2100, then 2100->1210, then 2100->1220), so the
      // entry's TURNOVER is gross + loanDeduction + soShortfall (55M), not gross alone (50M) — the
      // 2100 account nets to 45M across its two credit-side legs plus one debit-side leg, which is
      // the correct liability balance even though total DEBIT/CREDIT turnover is larger than gross.
      expect(debitTotal).toBe(creditTotal);
      expect(debitTotal).toBe(55_000_000);
    });
  });

  it('posting engine: sale_void_reversal (X6) resolves payment method + HPP cost from real sale_payments/stock_movements rows', async () => {
    await withRollbackAs({ role: RoleKey.OWNER, userId: fixtures.usersByRole[RoleKey.OWNER], locationIds: [] }, async (client) => {
      const saleRes = await client.query<{ id: string }>(
        `INSERT INTO sales (receipt_number, client_id, location_id, shift_id, kasir_id, status, subtotal, discount, total, paid_amount, change_amount, occurred_at)
         SELECT 'TEST-VOID-0001', gen_random_uuid(), $1, ps.id, $2, 'voided', 80000, 0, 80000, 80000, 0, NOW()
           FROM pos_shifts ps WHERE ps.location_id = $1 LIMIT 1
         RETURNING id`,
        [fixtures.outletId, fixtures.usersByRole[RoleKey.KASIR]],
      );
      const saleId = saleRes.rows[0]!.id;
      await client.query(`INSERT INTO sale_payments (sale_id, method, amount, payment_status) VALUES ($1,'qris',80000,'paid')`, [saleId]);
      await client.query(
        `INSERT INTO stock_movements (location_id, storage_area_id, item_id, movement_type, qty, unit_cost, ref_type, ref_id, occurred_at)
         SELECT $1, sa.id, $2, 'return_in', 2.000, 15000, 'void_refund', $3, NOW() FROM storage_areas sa WHERE sa.location_id = $1 LIMIT 1`,
        [fixtures.outletId, fixtures.itemId, saleId],
      );

      await postingEngine.postForEvent(client, {
        type: 'journal.action',
        occurredAt: new Date().toISOString(),
        payload: { eventType: 'sale_void_reversal', documentType: 'void_refund', documentId: saleId, locationId: fixtures.outletId, amount: '80000.00', context: { saleId, type: 'void' }, occurredAt: new Date().toISOString() },
      });

      const res = await client.query<{ id: string }>(`SELECT id FROM journal_entries WHERE event_type = 'sale_void_reversal' AND ref_id = $1`, [saleId]);
      const detail = await journal.getDetail(client, res.rows[0]!.id);
      expect(detail.lines.find((l) => l.accountCode === '1031')).toBeTruthy(); // QRIS receivable leg, resolved from real sale_payments.method
      expect(detail.lines.find((l) => l.accountCode === '1110')?.debit).toBe('30000.00'); // 2.000 x 15000 HPP reversal, from real stock_movements
      const debitTotal = detail.lines.reduce((s, l) => s + Number(l.debit), 0);
      const creditTotal = detail.lines.reduce((s, l) => s + Number(l.credit), 0);
      expect(debitTotal).toBe(creditTotal);
    });
  });

  it('idempotency: replaying the SAME (eventType, refType, refId) does not double-post', async () => {
    await withRollbackAs({ role: RoleKey.OWNER, userId: fixtures.usersByRole[RoleKey.OWNER], locationIds: [] }, async (client) => {
      const documentId = fixtures.itemId;
      const event = {
        type: 'journal.action' as const,
        occurredAt: new Date().toISOString(),
        payload: { eventType: 'gudang_waste', documentType: 'test_idempotency', documentId, locationId: fixtures.warehouseId, amount: '10000.00', context: {}, occurredAt: new Date().toISOString() },
      };
      await postingEngine.postForEvent(client, event);
      await postingEngine.postForEvent(client, event); // replay
      const res = await client.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM journal_entries WHERE event_type = 'gudang_waste' AND ref_type = 'test_idempotency' AND ref_id = $1`, [documentId]);
      expect(res.rows[0]!.count).toBe('1');
    });
  });
});
