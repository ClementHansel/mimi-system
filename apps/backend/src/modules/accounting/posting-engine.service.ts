import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { mulMoneyByQty, sumMoney, ZERO_MONEY, type Money } from '@mimi/shared';
import { DATABASE_POOL } from '../../common/database/database-pool.provider';
import { withSystemContext, SYSTEM_CENTRAL_ROLE } from '../../common/database/system-context';
import { EventBus } from '../../kernel/events/event-bus.service';
import type { DomainEvent } from '../../kernel/events/domain-events';
import { JournalService } from './journal.service';
import type { DraftLine } from './accounting.types';

export interface JournalLeg {
  debit: string;
  credit: string;
  amount: Money;
  memo?: string;
}

/**
 * M17 posting engine (D-04; CONTRACTS.md §6.2/§6.3) — the ONE subscriber
 * `EventBus`'s doc comment names ("W4-03 is expected to subscribe once via
 * `subscribe('journal.action', ...)` in its module's `onModuleInit`").
 *
 * ACCOUNT ROUTING vs. AMOUNT RESOLUTION, deliberately split:
 *   - Which accounts a given (eventType, condition) pair debits/credits is
 *     genuinely declarative data — `posting_rules` (DB, editable by
 *     Finance/Owner per §4.17's `GET .../posting-rules`) is authoritative,
 *     read via `JournalService.postingRules()`.
 *   - HOW MUCH each leg is worth is not: it requires a bespoke join per
 *     event (a void's HPP-reversal leg needs the original sale's stock
 *     movements; payroll's legs need totals grouped by component) that a
 *     generic `amount_source` string cannot execute by itself. `resolvePureLegs`
 *     below is that per-event-type resolver — verified line-by-line against
 *     the REAL publishers already live in this codebase (`surat-jalan
 *     .service.ts`, `drop.service.ts`, `pos-void-refund.service.ts`) rather
 *     than against `packages/shared/src/gl/posting-rules.ts`'s reference
 *     shapes alone, per the carried item #4 brief ("verify each against the
 *     real domain-event shapes now that the modules exist"). Two real
 *     mismatches found this way, both handled below (not by editing anyone
 *     else's migration): (1) `outlet_goods_in_from_warehouse`'s discrepancy
 *     leg amount is `context.shortfall` (already money), never a recomputed
 *     qty×cost; (2) `sale_void_reversal` carries only `{saleId, type}` in
 *     its context — no payment method, no cost — so `resolveSaleVoidReversalLegs`
 *     looks up `sale_payments`/`stock_movements` (ref_type='void_refund') itself.
 *
 * CROSS-CONNECTION CAVEAT (documented, not hidden): `EventBus.publish()` is
 * synchronous, in-process, no persistence (see that file's doc comment).
 * Real emitters call it INSIDE their own request transaction (on
 * `request.dbClient`), which this handler has no access to — only the
 * payload. Posting therefore runs in its OWN system-context transaction
 * (`withSystemContext`, central-role bypass — a GL posting is definitionally
 * cross-user), committed independently of the emitter's still-open
 * transaction. If the emitter's transaction later rolls back, this posting
 * does not unwind automatically. This is an inherent gap in a purely
 * in-process event bus with no outbox, not something this engine can close
 * alone — flagged in the module report as a follow-up (an outbox table, or
 * moving the publish() call to strictly after each emitter's own COMMIT,
 * are the two standard fixes). Idempotency (`ON CONFLICT ... DO NOTHING` in
 * `JournalService.postSystemEntry`) at least makes a retry-after-failure
 * safe either way.
 */
@Injectable()
export class PostingEngineService implements OnModuleInit {
  private readonly logger = new Logger(PostingEngineService.name);

  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly eventBus: EventBus,
    private readonly journal: JournalService,
  ) {}

  onModuleInit(): void {
    this.eventBus.subscribe('journal.action', (event) => this.handle(event));
  }

  /** Exposed for tests that want to drive the engine directly against a supplied transaction (the live-db harness's rolled-back transaction) rather than through a separate `withSystemContext` connection. */
  async postForEvent(client: PoolClient, event: DomainEvent<'journal.action'>): Promise<void> {
    const legs = await this.resolveLegs(client, event);
    if (!legs || legs.length === 0) return;

    const lines: DraftLine[] = [];
    for (const leg of legs) {
      if (leg.amount === ZERO_MONEY || leg.amount === '0.00') continue;
      lines.push({ accountCode: leg.debit, debit: leg.amount, credit: ZERO_MONEY, memo: leg.memo ?? null });
      lines.push({ accountCode: leg.credit, debit: ZERO_MONEY, credit: leg.amount, memo: leg.memo ?? null });
    }
    if (lines.length === 0) return;

    await this.journal.postSystemEntry(client, {
      entryDate: event.payload.occurredAt.slice(0, 10),
      eventType: event.payload.eventType,
      refType: event.payload.documentType,
      refId: event.payload.documentId,
      locationId: event.payload.locationId,
      description: `${event.payload.eventType} — ${event.payload.documentType} ${event.payload.documentId}`,
      lines,
    });
  }

  private async handle(event: DomainEvent<'journal.action'>): Promise<void> {
    try {
      await withSystemContext(this.pool, { role: SYSTEM_CENTRAL_ROLE }, (client) => this.postForEvent(client, event));
    } catch (err) {
      // EventBus already logs+swallows handler errors so a posting failure never breaks the emitting
      // module's own request — this log is for finding the failure at all (no other surface sees it).
      this.logger.error(
        `Posting engine failed for '${event.payload.eventType}' (${event.payload.documentType}/${event.payload.documentId}): ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
    }
  }

  private async resolveLegs(client: PoolClient, event: DomainEvent<'journal.action'>): Promise<JournalLeg[] | null> {
    const { eventType, amount, context, documentId } = event.payload;
    if (eventType === 'sale_void_reversal') {
      return resolveSaleVoidReversalLegs(client, amount, documentId);
    }
    if (!resolveEventTypes.has(eventType)) {
      this.logger.warn(`No posting resolver for eventType '${eventType}' — ignoring (not one of the 16 PRD + 7 system extension types)`);
      return null;
    }
    return resolvePureLegs(eventType, amount, context ?? {});
  }
}

const resolveEventTypes = new Set([
  'gudang_purchase', 'gudang_goods_in', 'gudang_goods_out_to_outlet', 'gudang_return_to_supplier', 'gudang_waste',
  'gudang_stock_adjustment', 'gudang_stock_revaluation', 'outlet_goods_in_from_warehouse', 'outlet_ingredient_usage',
  'outlet_waste', 'outlet_return_to_warehouse', 'outlet_sales', 'outlet_stock_adjustment', 'outlet_direct_purchase',
  'outlet_petty_cash', 'outlet_operating_expense', 'payroll_accrual', 'payroll_payment', 'qris_settlement',
  'transfer_verified', 'platform_settlement', 'offline_auth_rejected', 'petty_cash_topup', 'employee_loan_disbursement',
]);

/**
 * The account-routing half of every posting rule EXCEPT `sale_void_reversal`
 * (the one case that genuinely needs a DB lookup — see the class doc). Pure
 * function (no I/O) precisely so `posting-engine.property.test.ts` can
 * assert, without a live database, that every leg set this engine can
 * possibly produce for the 16 PRD + 7 system-extension event types (minus
 * that one) is balanced by construction — the property the module's "done
 * when" bar requires. Exported for that test; `PostingEngineService` is the
 * only production caller.
 */
export function resolvePureLegs(eventType: string, amount: Money, context: Record<string, unknown>): JournalLeg[] | null {
  const ctx = context;
  switch (eventType) {
    // ── JGUD-01..05: single unconditional pair ──────────────────────────
    case 'gudang_purchase': return [{ debit: '1100', credit: '2000', amount }];
    case 'gudang_goods_in': return [{ debit: '1100', credit: '1120', amount }];
    case 'gudang_goods_out_to_outlet': return [{ debit: '1120', credit: '1100', amount }];
    case 'gudang_return_to_supplier': return [{ debit: '2000', credit: '1100', amount }];
    case 'gudang_waste': return [{ debit: '5100', credit: '1100', amount }];

    // ── JGUD-06/07: direction-conditioned single pair ───────────────────
    case 'gudang_stock_adjustment':
      return ctx.direction === 'shortage' ? [{ debit: '6400', credit: '1100', amount }] : [{ debit: '1100', credit: '4100', amount }];
    case 'gudang_stock_revaluation':
      return ctx.direction === 'up' ? [{ debit: '1100', credit: '5090', amount }] : [{ debit: '5090', credit: '1100', amount }];

    // ── JOUT-01/01b: base leg always; discrepancy leg uses context.shortfall (already money, per
    // the REAL publisher drop.service.ts — not a recomputed qty×cost) ───
    case 'outlet_goods_in_from_warehouse': {
      const legs: JournalLeg[] = [{ debit: '1110', credit: '1120', amount }];
      const shortfall = typeof ctx.shortfall === 'string' ? (ctx.shortfall as Money) : ZERO_MONEY;
      if (ctx.discrepancy === true && shortfall !== '0.00') {
        legs.push({ debit: '6400', credit: '1120', amount: shortfall, memo: 'Selisih kekurangan barang dalam perjalanan' });
      }
      return legs;
    }

    // ── JOUT-02/04/05: single unconditional pair ─────────────────────────
    case 'outlet_ingredient_usage': return [{ debit: '5000', credit: '1110', amount }];
    case 'outlet_waste': return [{ debit: '5100', credit: '1110', amount }];
    case 'outlet_return_to_warehouse': return [{ debit: '1120', credit: '1110', amount }];

    // ── JOUT-03: method-conditioned; caller (daily aggregator) supplies context.byMethod ─────────
    case 'outlet_sales':
      return resolveOutletSalesLegs(amount, ctx);

    // ── JOUT-06: direction + attributable ────────────────────────────────
    case 'outlet_stock_adjustment':
      if (ctx.direction === 'overage') return [{ debit: '1110', credit: '4100', amount }];
      return ctx.attributable === true ? [{ debit: '1210', credit: '1110', amount }] : [{ debit: '6400', credit: '1110', amount }];

    // ── JOUT-07: source-conditioned ──────────────────────────────────────
    case 'outlet_direct_purchase':
      return ctx.source === 'po_receipt' || ctx.source === 'po' ? [{ debit: '1110', credit: '2000', amount }] : [{ debit: '1110', credit: '1010', amount }];

    // ── JOUT-08: default 6100 (expense_category account mapping is a future refinement, noted at §6.2) ──
    case 'outlet_petty_cash':
      return [{ debit: typeof ctx.expenseAccountCode === 'string' ? (ctx.expenseAccountCode as string) : '6100', credit: '1010', amount }];

    // ── JOUT-09 ───────────────────────────────────────────────────────────
    case 'outlet_operating_expense':
      return [{ debit: '6100', credit: ctx.paidVia === 'cash' ? '1000' : '1020', amount }];

    // ── X1/X1s: payroll accrual — genuinely multi-leg, engine-combined from context totals ────────
    case 'payroll_accrual':
      return resolvePayrollAccrualLegs(ctx);

    // ── X2..X5: single unconditional pair ────────────────────────────────
    case 'payroll_payment': return [{ debit: '2100', credit: '1020', amount }];
    case 'qris_settlement': return [{ debit: '1020', credit: '1031', amount }];
    case 'transfer_verified': return [{ debit: '1020', credit: '1032', amount }];
    case 'platform_settlement': return [{ debit: '1020', credit: '1030', amount }];

    // ── X7: offline_auth_rejected ─────────────────────────────────────────
    case 'offline_auth_rejected':
      return ctx.source === 'waste' ? [{ debit: '1220', credit: '5100', amount }] : [{ debit: '1220', credit: '4000', amount }];

    // ── local extensions (prose-only in §6.3; not in the frozen JournalSystemEventType enum —
    // carried item #2, reported not fixed) ──────────────────────────────
    case 'petty_cash_topup': return [{ debit: '1010', credit: '1020', amount }];
    case 'employee_loan_disbursement': return [{ debit: '1210', credit: '1020', amount }];

    default:
      return null;
  }
}

function resolveOutletSalesLegs(amount: Money, ctx: Record<string, unknown>): JournalLeg[] {
  const byMethod = ctx.byMethod as Record<string, string> | undefined;
  if (!byMethod) {
    // Single-method shorthand (e.g. a test or a caller that already knows it is all-cash) — 'method' is honored directly.
    const acct = ctx.method === 'qris' ? '1031' : ctx.method === 'bank_transfer' ? '1032' : '1000';
    return [{ debit: acct, credit: '4000', amount }];
  }
  const legs: JournalLeg[] = [];
  for (const [method, methodAmount] of Object.entries(byMethod)) {
    if (methodAmount === '0.00') continue;
    const acct = method === 'qris' ? '1031' : method === 'bank_transfer' ? '1032' : method === 'online' ? '1030' : '1000';
    legs.push({ debit: acct, credit: '4000', amount: methodAmount as Money, memo: `Penjualan ${method}` });
  }
  const onlineFees = ctx.onlineFees as string | undefined;
  if (onlineFees && onlineFees !== '0.00') {
    legs.push({ debit: '6300', credit: '1030', amount: onlineFees as Money, memo: 'Komisi platform + diskon' });
  }
  return legs;
}

function resolvePayrollAccrualLegs(ctx: Record<string, unknown>): JournalLeg[] {
  const num = (key: string): Money => (typeof ctx[key] === 'string' ? (ctx[key] as Money) : ZERO_MONEY);
  const legs: JournalLeg[] = [];
  const gross = num('grossAmount');
  const loanDeduction = num('loanDeductionTotal');
  const soShortfall = num('soShortfallDeductionTotal');
  // X1: gross debited to Beban Gaji; the SAME gross is credited to Hutang Gaji minus whatever is
  // immediately re-routed to the loan/claim legs below (net-of-deductions liability, §6.3 X1).
  if (gross !== '0.00') legs.push({ debit: '6000', credit: '2100', amount: gross, memo: 'Akrual gaji (gross)' });
  if (loanDeduction !== '0.00') legs.push({ debit: '2100', credit: '1210', amount: loanDeduction, memo: 'Potongan cicilan kasbon' });
  if (soShortfall !== '0.00') legs.push({ debit: '2100', credit: '1220', amount: soShortfall, memo: 'Potongan selisih stok (piutang klaim)' });

  if (ctx.statutoryMode === true) {
    const employerCost = num('employerCostTotal');
    const bpjsEmployeeDeduction = num('bpjsEmployeeDeductionTotal');
    const pph21Deduction = num('pph21DeductionTotal');
    if (employerCost !== '0.00') legs.push({ debit: '6010', credit: '2110', amount: employerCost, memo: 'Akrual BPJS perusahaan' });
    if (bpjsEmployeeDeduction !== '0.00') legs.push({ debit: '2100', credit: '2110', amount: bpjsEmployeeDeduction, memo: 'Potongan BPJS karyawan' });
    if (pph21Deduction !== '0.00') legs.push({ debit: '2100', credit: '2120', amount: pph21Deduction, memo: 'Potongan PPh21' });
  }
  return legs;
}

async function resolveSaleVoidReversalLegs(client: PoolClient, amount: Money, saleId: string): Promise<JournalLeg[]> {
  const legs: JournalLeg[] = [];

  // Leg group 1: revenue reversal + payment-method cash-back. `sale_payments` (not the event
  // context, which carries only {saleId, type} per the real publisher) is the actual method source.
  const payments = await client.query<{ method: string; amount: Money }>(
    `SELECT method, amount FROM sale_payments WHERE sale_id = $1 ORDER BY amount DESC`,
    [saleId],
  );
  const primaryMethod = payments.rows[0]?.method ?? 'cash';
  const acct = primaryMethod === 'qris' ? '1031' : primaryMethod === 'bank_transfer' ? '1032' : '1000';
  legs.push({ debit: '4000', credit: acct, amount, memo: 'Reversal pendapatan (void/refund)' });

  // Leg group 2: inventory/HPP reversal, valued from the RETURN_IN stock movements
  // `pos-void-refund.service.ts` already posted with ref_type='void_refund', ref_id=saleId — the
  // one place the actual cost basis is recorded for this reversal.
  const movements = await client.query<{ qty: string; unit_cost: Money }>(
    `SELECT qty, unit_cost FROM stock_movements WHERE ref_type = 'void_refund' AND ref_id = $1 AND movement_type = 'return_in'`,
    [saleId],
  );
  if (movements.rows.length > 0) {
    const costAmount = sumMoney(movements.rows.map((m) => mulMoneyByQty(m.unit_cost, m.qty)));
    if (costAmount !== '0.00') legs.push({ debit: '1110', credit: '5000', amount: costAmount, memo: 'Reversal HPP - bahan baku kembali ke outlet' });
  }

  return legs;
}
