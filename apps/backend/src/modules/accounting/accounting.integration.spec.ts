/**
 * Integration tests against the LIVE database (BUILD-PLAN §5/§8 idiom,
 * mirrored from `kernel/stock-opname/stock-opname.integration.spec.ts`).
 *
 * BE-TXN-ROLLBACK REWRITE: every mutating method this module's services
 * expose now SELF-COMMITS (`db-tx.ts`'s `withWrite()` — see that file's doc
 * comment for the bug this fixes: 19 raw `INSERT`/`UPDATE` writes across this
 * module ran with zero real `COMMIT`, silently discarded by
 * `RlsCleanupInterceptor`'s unconditional post-request `ROLLBACK`). That
 * changes this suite's OWN shape: a `withRollbackAs` block that chains two or
 * more mutating calls on the SAME connection no longer works — the first
 * call's real `COMMIT` ends the transaction and reverts `SET LOCAL ROLE`/the
 * `app.*` session GUCs, so anything run afterward on that same client (even a
 * plain read) fails with `permission denied for table ...`. Every test below
 * now opens ONE `asRequest`/`withRollbackAs` connection PER mutating call —
 * one call = one simulated HTTP request, exactly `waste-return`/
 * `stock-opname`'s established convention (see either module's own spec
 * header) — and the new `describe('write-then-read-back ...')` block proves
 * each fixed service's writes actually survive past the request that made
 * them, which is the only thing that can catch this bug class at all.
 *
 * REAL roles (`finance`, `owner`, `kasir`) in session context throughout,
 * never hardcoded `'owner'`, per this module's brief.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AccountType,
  ERR_PROOF_REQUIRED,
  ERR_UNBALANCED_ENTRY,
  PayeeType,
  PaymentVerificationRefType,
  RoleKey,
} from '@mimi/shared';

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
import { ExceptionsService } from './exceptions.service';

import {
  appPoolForDi,
  asCommittedRequest,
  asRequest,
  closePool,
  loadFixtures,
  withRollbackAs,
  type Fixtures,
} from './test-support/live-db';

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
  const exceptions = new ExceptionsService(eventBus);

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
    await withRollbackAs(
      { role: RoleKey.FINANCE, userId: fixtures.usersByRole[RoleKey.FINANCE], locationIds: [] },
      async (client) => {
        const accounts = await coa.list(client, {});
        expect(accounts.length).toBeGreaterThanOrEqual(28); // §6.1 seeds 29 codes
        expect(accounts.find((a) => a.code === '1100')?.name).toBe('Persediaan Gudang');
        expect(accounts.every((a) => a.isSystem)).toBe(true); // none of the §6.1 seed rows are manual additions
      },
    );
  });

  // ── fiscal periods: camelCase wire shape (coordinator-flagged regression — the finance UI's
  // `FiscalPeriodRow` was coded against a live snake_case leak; `list`/`close`/`reopen` must return
  // exactly CONTRACTS.md §4.17's `{id; periodCode; startDate; endDate; status}`, never the raw
  // `pg` row (`period_code`/`start_date`/`closed_at`), matching every other endpoint in this module.
  it('GET periods returns camelCase, never the raw snake_case pg row', async () => {
    await withRollbackAs(
      { role: RoleKey.FINANCE, userId: fixtures.usersByRole[RoleKey.FINANCE], locationIds: [] },
      async (client) => {
        const list = await periods.list(client);
        expect(list.length).toBeGreaterThan(0);
        const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
        for (const p of list) {
          expect(p).toEqual(
            expect.objectContaining({
              id: expect.any(String),
              periodCode: expect.any(String),
              startDate: expect.stringMatching(dateOnly),
              endDate: expect.stringMatching(dateOnly),
              status: expect.any(String),
            }),
          );
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
      },
    );
  });

  // BE-TXN-ROLLBACK: `close` then `reopen` were chained on ONE `withRollbackAs` connection —
  // `close`'s now-real `COMMIT` would end that transaction before `reopen` ever ran on it. Split
  // into separate `asRequest` connections (own read for the target period, own connection per
  // mutation); `fiscal_periods` is SHARED state (not per-test fixture data), so the period is
  // guaranteed back to 'open' in a `finally`, same discipline `stock-opname`'s harness uses for its
  // shared approval-threshold setting.
  it('POST periods/:id/close and /reopen also return camelCase, and both persist past their own request', async () => {
    const owner = {
      role: RoleKey.OWNER,
      userId: fixtures.usersByRole[RoleKey.OWNER],
      locationIds: [],
    };

    const openPeriod = await asRequest(owner, async (client) => {
      const list = await periods.list(client);
      return list.find((p) => p.status === 'open');
    });
    expect(openPeriod).toBeTruthy();

    try {
      const closed = await asRequest(owner, (client) =>
        periods.close(client, openPeriod!.id, fixtures.usersByRole[RoleKey.OWNER], undefined),
      );
      expect(closed.status).toBe('closed');
      expect(closed.periodCode).toBe(openPeriod!.periodCode);
      expect(closed).not.toHaveProperty('period_code');

      // A genuinely separate connection sees the close — proves it committed, not merely visible
      // within `close`'s own (now-closed) transaction.
      const rereadClosed = await asRequest(owner, (client) => periods.get(client, openPeriod!.id));
      expect(rereadClosed.status).toBe('closed');

      const reopened = await asRequest(owner, (client) =>
        periods.reopen(client, openPeriod!.id, 'test: verifying camelCase shape'),
      );
      expect(reopened.status).toBe('open');
      expect(reopened).not.toHaveProperty('closed_at');

      const rereadReopened = await asRequest(owner, (client) =>
        periods.get(client, openPeriod!.id),
      );
      expect(rereadReopened.status).toBe('open');
    } finally {
      // SETTINGS-LEAK guard: `fiscal_periods` is shared, durable state — restore to 'open'
      // unconditionally so a failure mid-test never leaves this period closed for every later test/run.
      const finalState = await asRequest(owner, (client) => periods.get(client, openPeriod!.id));
      if (finalState.status === 'closed') {
        await asRequest(owner, (client) =>
          periods.reopen(client, openPeriod!.id, 'test cleanup: restore to open'),
        );
      }
    }
  });

  // ── manual journal entry: balanced succeeds, unbalanced is rejected ─────

  // BE-TXN-ROLLBACK: the unbalanced case is genuinely safe to keep on a second call against the
  // same (now-committed-and-reverted) client — `validateJournalEntry` rejects BEFORE `postManual`
  // ever touches `client` (see `journal.service.ts`), so no query runs against the reverted session.
  // Split anyway, for clarity and so this test does not rely on that subtlety holding forever.
  it('a balanced manual entry posts and persists past its own request', async () => {
    const finance = {
      role: RoleKey.FINANCE,
      userId: fixtures.usersByRole[RoleKey.FINANCE],
      locationIds: [],
    };
    const entryDate = new Date().toISOString().slice(0, 10);

    const entry = await asRequest(finance, (client) =>
      journal.postManual(client, fixtures.usersByRole[RoleKey.FINANCE], {
        entryDate,
        description: 'Test: pembelian tunai perlengkapan',
        lines: [
          { accountCode: '6100', debit: '150000.00' },
          { accountCode: '1000', credit: '150000.00' },
        ],
      }),
    );
    expect(entry.status).toBe('posted');
    // `entryDate` must round-trip exactly as submitted, never shifted by a day (the same `pg`
    // DATE-parsing/local-timezone gotcha `formatDateOnly` exists to close — see periods' test above).
    expect(entry.entryDate).toBe(entryDate);
    expect(entry.lines).toHaveLength(2);
    const debitTotal = entry.lines.reduce((s, l) => s + Number(l.debit), 0);
    const creditTotal = entry.lines.reduce((s, l) => s + Number(l.credit), 0);
    expect(debitTotal).toBe(creditTotal);

    // Separate connection: a service that only wrote inside the harness's own transaction (no
    // `withWrite`) would 404 here.
    const reread = await asRequest(finance, (client) => journal.getDetail(client, entry.id));
    expect(reread.id).toBe(entry.id);
    expect(reread.status).toBe('posted');
  });

  it('an unbalanced manual entry is rejected with ERR_UNBALANCED_ENTRY (rejected before any write)', async () => {
    const finance = {
      role: RoleKey.FINANCE,
      userId: fixtures.usersByRole[RoleKey.FINANCE],
      locationIds: [],
    };
    await asRequest(finance, (client) =>
      expect(
        journal.postManual(client, fixtures.usersByRole[RoleKey.FINANCE], {
          entryDate: new Date().toISOString().slice(0, 10),
          description: 'Test: unbalanced entry must be rejected, never auto-corrected',
          lines: [
            { accountCode: '6100', debit: '150000.00' },
            { accountCode: '1000', credit: '100000.00' },
          ],
        }),
      ).rejects.toMatchObject({ response: { code: ERR_UNBALANCED_ENTRY } }),
    );
  });

  it('write-then-read-back: reverse() posts a swapped-legs entry and flips the original to reversed, both surviving past their own requests', async () => {
    const finance = {
      role: RoleKey.FINANCE,
      userId: fixtures.usersByRole[RoleKey.FINANCE],
      locationIds: [],
    };
    const entryDate = new Date().toISOString().slice(0, 10);

    const original = await asRequest(finance, (client) =>
      journal.postManual(client, fixtures.usersByRole[RoleKey.FINANCE], {
        entryDate,
        description: 'Test: entry to be reversed',
        lines: [
          { accountCode: '6100', debit: '80000.00' },
          { accountCode: '1000', credit: '80000.00' },
        ],
      }),
    );

    const reversal = await asRequest(finance, (client) =>
      journal.reverse(
        client,
        fixtures.usersByRole[RoleKey.FINANCE],
        original.id,
        'test: reversing entry',
      ),
    );
    expect(reversal.status).toBe('posted');
    const swappedDebit = reversal.lines.find((l) => l.accountCode === '1000')?.debit;
    const swappedCredit = reversal.lines.find((l) => l.accountCode === '6100')?.credit;
    expect(swappedDebit).toBe('80000.00');
    expect(swappedCredit).toBe('80000.00');

    // A THIRD, separate connection: proves both the reversal insert AND the original's status flip
    // committed for real, not merely visible inside `reverse`'s own (now-closed) transaction.
    const rereadOriginal = await asRequest(finance, (client) =>
      journal.getDetail(client, original.id),
    );
    expect(rereadOriginal.status).toBe('reversed');
    const rereadReversal = await asRequest(finance, (client) =>
      journal.getDetail(client, reversal.id),
    );
    expect(rereadReversal.status).toBe('posted');
  });

  // ── the "permission denied" pin (carried item #3's actual RLS gap) ──────

  it('PERMISSION DENIED PIN: a raw INSERT into payment_verifications under a real kasir session is rejected by RLS', async () => {
    await withRollbackAs(
      {
        role: RoleKey.KASIR,
        userId: fixtures.usersByRole[RoleKey.KASIR],
        locationIds: [fixtures.outletId],
      },
      async (client) => {
        await expect(
          client.query(
            `INSERT INTO payment_verifications (pv_number, ref_type, payee_type, amount, submitted_by, location_id)
           VALUES ('PV/TEST/00001', 'sale_payment', 'other', '75000.00', $1, $2)`,
            [fixtures.usersByRole[RoleKey.KASIR], fixtures.outletId],
          ),
        ).rejects.toThrow(/row-level security|permission denied/i);
      },
    );
  });

  // BE-TXN-ROLLBACK: `create()` now really commits (its own `withWrite`), so the post-write
  // `current_setting('app.role')` check that used to run on the SAME (still-open) connection is no
  // longer observable — that COMMIT ends the transaction and reverts the session GUCs before this
  // test function gets control back, regardless of what `escalatedInsert` restored moments earlier
  // (verified internally, pre-commit, by `payment-verifications.service.ts` itself). Replaced with a
  // STRONGER, genuinely cross-connection check: the PV a `kasir` session creates (escalated insert)
  // is readable by a separate CENTRAL-role session afterward — proving the write survived past the
  // request that made it, which the original single-connection check could not have caught at all.
  it('CARRIED ITEM #3 FIX: PaymentVerificationsService.create() succeeds for a real kasir session (escalated insert) and the row persists for a later central-role read', async () => {
    const kasir = {
      role: RoleKey.KASIR,
      userId: fixtures.usersByRole[RoleKey.KASIR],
      locationIds: [fixtures.outletId],
    };
    const created = await asRequest(kasir, (client) =>
      payments.create(client, actor(RoleKey.KASIR, [fixtures.outletId]), {
        refType: PaymentVerificationRefType.SALE_PAYMENT,
        payeeType: PayeeType.OTHER,
        amount: '250000.00',
        locationId: fixtures.outletId,
      }),
    );
    expect(created.status).toBe('pending');

    // `payment_verifications_role`'s RLS is central-role-only for SELECT — a kasir's OWN later
    // session (even a fresh one) could never read this row back; a central role's session can, and
    // only can if the kasir's escalated INSERT genuinely committed.
    const reread = await asRequest(
      { role: RoleKey.FINANCE, userId: fixtures.usersByRole[RoleKey.FINANCE], locationIds: [] },
      (client) => payments.getDetail(client, created.id),
    );
    expect(reread.id).toBe(created.id);
    expect(reread.amount).toBe('250000.00');
  });

  // ── payment verification ladder (FR-ACCT-01..04), real finance role ────
  //
  // BE-TXN-ROLLBACK: this was ONE `withRollbackAs` block chaining create -> verify(rejected) ->
  // raw attachment insert -> uploadProof -> verify -> pay, all on the SAME connection. Every
  // mutating call in that chain now self-commits, so each step below opens its OWN connection —
  // the "money" path this ticket's brief flags as needing the write-then-read-back proof most.

  it('Pending -> Verified -> Paid ladder: verify without proof is ERR_PROOF_REQUIRED; the happy path completes end to end across separate requests, dispatching the right journal.action', async () => {
    const finance = {
      role: RoleKey.FINANCE,
      userId: fixtures.usersByRole[RoleKey.FINANCE],
      locationIds: [],
    };
    const financeActor = actor(RoleKey.FINANCE);

    const pv = await asRequest(finance, (client) =>
      payments.create(client, financeActor, {
        refType: PaymentVerificationRefType.OTHER,
        payeeType: PayeeType.OTHER,
        amount: '500000.00',
        locationId: fixtures.outletId,
      }),
    );

    await asRequest(finance, (client) =>
      expect(payments.verify(client, financeActor, pv.id, undefined)).rejects.toMatchObject({
        response: { code: ERR_PROOF_REQUIRED },
      }),
    );

    // Attach proof via a real attachments row — its own connection/commit (a fixture write, not the
    // behavior under test), so `uploadProof`'s later, separate connection genuinely sees it.
    const attachmentId = await asCommittedRequest(finance, async (client) => {
      const res = await client.query<{ id: string }>(
        `INSERT INTO attachments (object_key, file_name, mime_type, size_bytes, kind, uploaded_by)
         VALUES ($1,'proof.jpg','image/jpeg',12345,'payment_proof',$2) RETURNING id`,
        [`test/proof-${Date.now()}.jpg`, fixtures.usersByRole[RoleKey.FINANCE]],
      );
      return res.rows[0]!.id;
    });

    await asRequest(finance, (client) =>
      payments.uploadProof(client, financeActor, pv.id, attachmentId),
    );

    const verified = await asRequest(finance, (client) =>
      payments.verify(client, financeActor, pv.id, 'ok'),
    );
    expect(verified.status).toBe('verified');

    // Separate connection: proves `uploadProof` + `verify` both persisted, not merely visible to
    // each other inside one still-open transaction.
    const rereadVerified = await asRequest(finance, (client) => payments.getDetail(client, pv.id));
    expect(rereadVerified.status).toBe('verified');

    let publishedEventType: string | undefined;
    const unsubscribe = eventBus.subscribe('journal.action', (e) => {
      publishedEventType = e.payload.eventType;
    });
    try {
      const paid = await asRequest(finance, (client) =>
        payments.pay(client, financeActor, pv.id, { paidVia: 'cash' }),
      );
      expect(paid.status).toBe('paid');
      // ref_type='other' + a real outlet location -> JOUT-09 outlet_operating_expense (§6.2).
      expect(publishedEventType).toBe('outlet_operating_expense');
    } finally {
      unsubscribe();
    }

    // Final independent read (a FIFTH connection): the whole ladder's cumulative effect —
    // paid_via/paid_by/paid_at — genuinely committed.
    const rereadPaid = await asRequest(finance, (client) => payments.getDetail(client, pv.id));
    expect(rereadPaid.status).toBe('paid');
    expect(rereadPaid.paidVia).toBe('cash');
  });

  it('write-then-read-back: reject() persists past its own request and never transitions to paid', async () => {
    const finance = {
      role: RoleKey.FINANCE,
      userId: fixtures.usersByRole[RoleKey.FINANCE],
      locationIds: [],
    };
    const financeActor = actor(RoleKey.FINANCE);

    const pv = await asRequest(finance, (client) =>
      payments.create(client, financeActor, {
        refType: PaymentVerificationRefType.OTHER,
        payeeType: PayeeType.OTHER,
        amount: '120000.00',
        locationId: fixtures.outletId,
      }),
    );

    const rejected = await asRequest(finance, (client) =>
      payments.reject(client, financeActor, pv.id, 'test: rejecting this PV'),
    );
    expect(rejected.status).toBe('rejected');

    const reread = await asRequest(finance, (client) => payments.getDetail(client, pv.id));
    expect(reread.status).toBe('rejected');
  });

  // ── the posting engine: every one of the 16 PRD + 7 system extension event
  // types, from a constructed-but-realistic domain event, produces a
  // balanced entry (module "done when" bar). Driven via `postForEvent`
  // directly on THIS rolled-back client (see that method's doc comment) so
  // nothing here durably writes outside the transaction. Deliberately
  // UNCHANGED by BE-TXN-ROLLBACK: `postSystemEntry` (which `postForEvent`
  // calls) is NOT wrapped in `withWrite` — it runs exclusively inside
  // `PostingEngineService`'s own `withSystemContext`, a different,
  // already-correct commit mechanism for that path — so chaining several
  // `postForEvent` calls on one connection here is still safe. ─────────────

  const cases: { eventType: string; amount: string; context: Record<string, unknown> }[] = [
    { eventType: 'gudang_purchase', amount: '1200000.00', context: {} },
    { eventType: 'gudang_goods_in', amount: '300000.00', context: {} },
    { eventType: 'gudang_goods_out_to_outlet', amount: '450000.00', context: {} },
    { eventType: 'gudang_return_to_supplier', amount: '80000.00', context: {} },
    { eventType: 'gudang_waste', amount: '60000.00', context: {} },
    {
      eventType: 'gudang_stock_adjustment',
      amount: '15000.00',
      context: { direction: 'shortage' },
    },
    { eventType: 'gudang_stock_adjustment', amount: '15000.00', context: { direction: 'overage' } },
    { eventType: 'gudang_stock_revaluation', amount: '9000.00', context: { direction: 'up' } },
    {
      eventType: 'outlet_goods_in_from_warehouse',
      amount: '450000.00',
      context: { discrepancy: false, shortfall: '0.00' },
    },
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
    {
      eventType: 'offline_auth_rejected',
      amount: '45000.00',
      context: { source: 'refund_or_void' },
    },
    { eventType: 'petty_cash_topup', amount: '500000.00', context: {} },
    { eventType: 'employee_loan_disbursement', amount: '1000000.00', context: {} },
  ];

  it.each(cases)(
    'posting engine: $eventType produces a balanced posted entry',
    async ({ eventType, amount, context }) => {
      await withRollbackAs(
        { role: RoleKey.OWNER, userId: fixtures.usersByRole[RoleKey.OWNER], locationIds: [] },
        async (client) => {
          const documentId = fixtures.itemId; // any real UUID works as ref_id — engine never dereferences it except for sale_void_reversal
          await postingEngine.postForEvent(client, {
            type: 'journal.action',
            occurredAt: new Date().toISOString(),
            payload: {
              eventType,
              documentType: 'test_fixture',
              documentId,
              locationId: fixtures.outletId,
              amount,
              context,
              occurredAt: new Date().toISOString(),
            },
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
        },
      );
    },
  );

  // ── payroll_accrual (X1/X1s, multi-leg) and sale_void_reversal (X6, DB-dependent) get their own
  // dedicated cases — the former needs a richer context, the latter needs real fixture rows. ──────

  it('posting engine: payroll_accrual (X1) combines gross + net + loan + SO-shortfall legs into ONE balanced entry', async () => {
    await withRollbackAs(
      { role: RoleKey.OWNER, userId: fixtures.usersByRole[RoleKey.OWNER], locationIds: [] },
      async (client) => {
        const documentId = fixtures.itemId;
        await postingEngine.postForEvent(client, {
          type: 'journal.action',
          occurredAt: new Date().toISOString(),
          payload: {
            eventType: 'payroll_accrual',
            documentType: 'test_fixture',
            documentId,
            locationId: null,
            amount: '0.00',
            context: {
              grossAmount: '50000000.00',
              loanDeductionTotal: '3000000.00',
              soShortfallDeductionTotal: '2000000.00',
            },
            occurredAt: new Date().toISOString(),
          },
        });
        const res = await client.query<{ id: string }>(
          `SELECT id FROM journal_entries WHERE event_type = 'payroll_accrual' AND ref_id = $1`,
          [documentId],
        );
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
      },
    );
  });

  it('posting engine: sale_void_reversal (X6) resolves payment method + HPP cost from real sale_payments/stock_movements rows', async () => {
    await withRollbackAs(
      { role: RoleKey.OWNER, userId: fixtures.usersByRole[RoleKey.OWNER], locationIds: [] },
      async (client) => {
        const saleRes = await client.query<{ id: string }>(
          `INSERT INTO sales (receipt_number, client_id, location_id, shift_id, kasir_id, status, subtotal, discount, total, paid_amount, change_amount, occurred_at)
         SELECT 'TEST-VOID-0001', gen_random_uuid(), $1, ps.id, $2, 'voided', 80000, 0, 80000, 80000, 0, NOW()
           FROM pos_shifts ps WHERE ps.location_id = $1 LIMIT 1
         RETURNING id`,
          [fixtures.outletId, fixtures.usersByRole[RoleKey.KASIR]],
        );
        const saleId = saleRes.rows[0]!.id;
        await client.query(
          `INSERT INTO sale_payments (sale_id, method, amount, payment_status) VALUES ($1,'qris',80000,'paid')`,
          [saleId],
        );
        await client.query(
          `INSERT INTO stock_movements (location_id, storage_area_id, item_id, movement_type, qty, unit_cost, ref_type, ref_id, occurred_at)
         SELECT $1, sa.id, $2, 'return_in', 2.000, 15000, 'void_refund', $3, NOW() FROM storage_areas sa WHERE sa.location_id = $1 LIMIT 1`,
          [fixtures.outletId, fixtures.itemId, saleId],
        );

        await postingEngine.postForEvent(client, {
          type: 'journal.action',
          occurredAt: new Date().toISOString(),
          payload: {
            eventType: 'sale_void_reversal',
            documentType: 'void_refund',
            documentId: saleId,
            locationId: fixtures.outletId,
            amount: '80000.00',
            context: { saleId, type: 'void' },
            occurredAt: new Date().toISOString(),
          },
        });

        const res = await client.query<{ id: string }>(
          `SELECT id FROM journal_entries WHERE event_type = 'sale_void_reversal' AND ref_id = $1`,
          [saleId],
        );
        const detail = await journal.getDetail(client, res.rows[0]!.id);
        expect(detail.lines.find((l) => l.accountCode === '1031')).toBeTruthy(); // QRIS receivable leg, resolved from real sale_payments.method
        expect(detail.lines.find((l) => l.accountCode === '1110')?.debit).toBe('30000.00'); // 2.000 x 15000 HPP reversal, from real stock_movements
        const debitTotal = detail.lines.reduce((s, l) => s + Number(l.debit), 0);
        const creditTotal = detail.lines.reduce((s, l) => s + Number(l.credit), 0);
        expect(debitTotal).toBe(creditTotal);
      },
    );
  });

  it('idempotency: replaying the SAME (eventType, refType, refId) does not double-post', async () => {
    await withRollbackAs(
      { role: RoleKey.OWNER, userId: fixtures.usersByRole[RoleKey.OWNER], locationIds: [] },
      async (client) => {
        const documentId = fixtures.itemId;
        const event = {
          type: 'journal.action' as const,
          occurredAt: new Date().toISOString(),
          payload: {
            eventType: 'gudang_waste',
            documentType: 'test_idempotency',
            documentId,
            locationId: fixtures.warehouseId,
            amount: '10000.00',
            context: {},
            occurredAt: new Date().toISOString(),
          },
        };
        await postingEngine.postForEvent(client, event);
        await postingEngine.postForEvent(client, event); // replay
        const res = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM journal_entries WHERE event_type = 'gudang_waste' AND ref_type = 'test_idempotency' AND ref_id = $1`,
          [documentId],
        );
        expect(res.rows[0]!.count).toBe('1');
      },
    );
  });

  // ── BE-TXN-ROLLBACK regression: writes must survive past the request that made them ──
  //
  // Every mutating call above already runs its own `asRequest` connection; this block is the
  // dedicated, explicit "does it actually persist" proof per fixed service, prioritizing
  // `payment-verifications` (real money) and `journal` (GL integrity) per this ticket's brief —
  // both already covered above, plus the two remaining fixed services (`chart-of-accounts`,
  // `exceptions`) get their own dedicated case here.
  describe('write-then-read-back across SEPARATE connections (each simulating one real HTTP request)', () => {
    it('chart-of-accounts: create() persists past its own request, and update() persists past ITS own separate request', async () => {
      const finance = {
        role: RoleKey.FINANCE,
        userId: fixtures.usersByRole[RoleKey.FINANCE],
        locationIds: [],
      };
      const code = `T${Date.now().toString().slice(-6)}`; // VARCHAR(10), unique per run

      try {
        const created = await asRequest(finance, (client) =>
          coa.create(client, {
            code,
            name: 'BE-TXN-ROLLBACK test account',
            type: AccountType.EXPENSE,
            normalBalance: 'debit',
            isPostable: true,
          }),
        );
        expect(created.code).toBe(code);

        // Separate connection: a `create()` that only wrote inside the harness's own transaction
        // (no `withWrite`) would 404 here.
        const reread = await asRequest(finance, (client) => coa.get(client, created.id));
        expect(reread.id).toBe(created.id);
        expect(reread.name).toBe('BE-TXN-ROLLBACK test account');

        const updated = await asRequest(finance, (client) =>
          coa.update(client, created.id, { name: 'BE-TXN-ROLLBACK renamed' }),
        );
        expect(updated.name).toBe('BE-TXN-ROLLBACK renamed');

        const rereadAfterUpdate = await asRequest(finance, (client) => coa.get(client, created.id));
        expect(rereadAfterUpdate.name).toBe('BE-TXN-ROLLBACK renamed');
      } finally {
        // SETTINGS-LEAK guard: `chart_of_accounts` is shared, durable state, and this file's OWN
        // "finance can read the seeded chart of accounts" test asserts `every(a => a.isSystem)` —
        // a manually-created account (`is_system=false` always, per `create()`) that outlived this
        // test would break that assertion on every LATER run in the same DB, not just this one.
        // `ChartOfAccountsService` exposes no `delete` (accounts are append-only in the real API), so
        // cleanup goes through a raw DELETE on a committed owner-role connection — test-only, never
        // production code's own path.
        await asCommittedRequest(
          { role: RoleKey.OWNER, userId: fixtures.usersByRole[RoleKey.OWNER], locationIds: [] },
          (client) => client.query(`DELETE FROM chart_of_accounts WHERE code = $1`, [code]),
        );
      }
    });

    it('exceptions: recordVerdict() persists past its own request (D-17 finance exception queue)', async () => {
      const approverId = fixtures.usersByRole[RoleKey.KEPALA_GUDANG];
      const owner = {
        role: RoleKey.OWNER,
        userId: fixtures.usersByRole[RoleKey.OWNER],
        locationIds: [],
      };

      // Fixture setup (NOT the behavior under test): a real, committed `offline_credentials` +
      // `offline_authorizations` + `sync_conflicts` trio seeded via a genuine app-pool session — own
      // connection, own commit — so the LATER, separate `recordVerdict`/read-back connections below
      // genuinely see it. `offline_credentials`' RLS is `app_is_self(user_id)`, so this seed session's
      // `app.user_id` is set to the SAME id as the credential's own `user_id` (the approver), not
      // `owner`, to satisfy that check; `sync_conflicts`/`offline_authorizations` themselves carry NO
      // RLS at all (migration 126: "API-gated ... never raw CRUD"), so the actual write is unrestricted
      // once the FK-referenced `offline_credentials` row exists.
      const { caseId, oaId } = await asCommittedRequest(
        { role: RoleKey.OWNER, userId: approverId, locationIds: [] },
        async (client) => {
          const device = await client.query<{ id: string }>(`SELECT id FROM devices LIMIT 1`);
          const deviceId = device.rows[0]!.id;
          const credentialId = crypto.randomUUID();
          await client.query(
            `INSERT INTO offline_credentials (credential_id, user_id, device_id, role_key, location_ids, scopes, binding_secret_enc, pin_verifier, expires_at)
           VALUES ($1,$2,$3,'kepala_gudang','{}','{}', $4, 'test-verifier-hash', NOW() + interval '1 day')`,
            [credentialId, approverId, deviceId, Buffer.from('test-secret')],
          );
          const oaRes = await client.query<{ id: string }>(
            `INSERT INTO offline_authorizations (credential_id, user_id, device_id, document_type, document_id, action, amount, binding_hmac, granted_at, outcome)
           VALUES ($1,$2,$3,'waste',$4,'waste.approve','50000.00','test-hmac',NOW(),'failed') RETURNING id`,
            [credentialId, approverId, deviceId, crypto.randomUUID()],
          );
          const oaId2 = oaRes.rows[0]!.id;
          const scRes = await client.query<{ id: string }>(
            `INSERT INTO sync_conflicts (kind, queue, entity, entity_id, physical_effect_suspected, status)
           VALUES ('offline_auth','finance','offline_authorizations',$1, true, 'open') RETURNING id`,
            [oaId2],
          );
          return { caseId: scRes.rows[0]!.id, oaId: oaId2 };
        },
      );

      const verdict = await asRequest(owner, (client) =>
        exceptions.recordVerdict(client, fixtures.usersByRole[RoleKey.OWNER], caseId, {
          verdict: 'rejected',
          reason: 'test: rejecting this case',
        }),
      );
      expect(verdict.verdict).toBe('rejected');

      // Separate connection: `recordVerdict`'s two UPDATEs (offline_authorizations + sync_conflicts)
      // must both have committed for real, not merely be visible inside its own now-closed transaction.
      const reread = await asRequest(owner, async (client) => {
        const oa = await client.query<{ verdict: string | null; reviewed_by: string | null }>(
          `SELECT verdict, reviewed_by FROM offline_authorizations WHERE id = $1`,
          [oaId],
        );
        const sc = await client.query<{ status: string; resolution: string | null }>(
          `SELECT status, resolution FROM sync_conflicts WHERE id = $1`,
          [caseId],
        );
        return { oa: oa.rows[0], sc: sc.rows[0] };
      });
      expect(reread.oa?.verdict).toBe('rejected');
      expect(reread.oa?.reviewed_by).toBe(fixtures.usersByRole[RoleKey.OWNER]);
      expect(reread.sc?.status).toBe('resolved');
    });
  });
});
