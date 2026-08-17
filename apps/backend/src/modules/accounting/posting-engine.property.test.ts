import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { formatMoney, validateJournalEntry, type JournalEntryInput } from '@mimi/shared';
import { resolvePureLegs } from './posting-engine.service';

/**
 * Property test (module "done when" bar: "a property test asserting every
 * generated entry balances"). Covers every one of the 16 PRD + 7 system
 * extension event types EXCEPT `sale_void_reversal` (the one resolver that
 * needs a live DB lookup — exercised instead by
 * `accounting.integration.spec.ts`, against real `sale_payments`/
 * `stock_movements` rows, for the same balance property).
 *
 * The property under test: for ANY amount and ANY plausible context,
 * `resolvePureLegs` either returns `null` (unknown event type) or a leg set
 * that — once expanded into one Dr line + one Cr line per leg, exactly as
 * `PostingEngineService.postForEvent` does — passes
 * `@mimi/shared/gl/validator`'s `validateJournalEntry` (Σdebit === Σcredit).
 * This is the SAME validator the manual-entry endpoint enforces
 * (`ERR_UNBALANCED_ENTRY`) — one invariant, exercised from both directions.
 */

const money = fc.bigInt({ min: 1n, max: 10n ** 12n }).map((n) => formatMoney(n));
const smallMoney = fc.bigInt({ min: 0n, max: 10n ** 9n }).map((n) => formatMoney(n));

function assertBalances(eventType: string, amount: string, context: Record<string, unknown>): void {
  const legs = resolvePureLegs(eventType, amount, context);
  if (!legs || legs.length === 0) return; // no posting fired for this (eventType, context) combination — vacuously fine
  const entry: JournalEntryInput = {
    lines: legs.flatMap((leg) => [
      { accountCode: leg.debit, debit: leg.amount, credit: '0.00' },
      { accountCode: leg.credit, debit: '0.00', credit: leg.amount },
    ]),
  };
  const result = validateJournalEntry(entry);
  expect(result.ok, `eventType='${eventType}' context=${JSON.stringify(context)} legs=${JSON.stringify(legs)}: ${!result.ok ? result.message : ''}`).toBe(true);
}

describe('property: every posting-rule resolver produces a balanced entry', () => {
  const simpleEventTypes = [
    'gudang_purchase', 'gudang_goods_in', 'gudang_goods_out_to_outlet', 'gudang_return_to_supplier', 'gudang_waste',
    'outlet_ingredient_usage', 'outlet_waste', 'outlet_return_to_warehouse',
    'payroll_payment', 'qris_settlement', 'transfer_verified', 'platform_settlement',
    'petty_cash_topup', 'employee_loan_disbursement',
  ];

  it.each(simpleEventTypes)('%s (unconditional single pair) always balances', (eventType) => {
    fc.assert(fc.property(money, (amount) => assertBalances(eventType, amount, {})));
  });

  it('gudang_stock_adjustment balances for both shortage and overage', () => {
    fc.assert(fc.property(money, fc.constantFrom('shortage', 'overage'), (amount, direction) => assertBalances('gudang_stock_adjustment', amount, { direction })));
  });

  it('gudang_stock_revaluation balances for both up and down', () => {
    fc.assert(fc.property(money, fc.constantFrom('up', 'down'), (amount, direction) => assertBalances('gudang_stock_revaluation', amount, { direction })));
  });

  it('outlet_goods_in_from_warehouse balances with and without a discrepancy leg', () => {
    fc.assert(
      fc.property(money, fc.boolean(), smallMoney, (amount, discrepancy, shortfall) =>
        assertBalances('outlet_goods_in_from_warehouse', amount, { discrepancy, shortfall })),
    );
  });

  it('outlet_sales balances for the single-method shorthand', () => {
    fc.assert(fc.property(money, fc.constantFrom('cash', 'qris', 'bank_transfer'), (amount, method) => assertBalances('outlet_sales', amount, { method })));
  });

  it('outlet_sales balances for a multi-method daily aggregate (JOUT-03, incl. online fee leg)', () => {
    fc.assert(
      fc.property(smallMoney, smallMoney, smallMoney, smallMoney, (cash, qris, online, fees) => {
        // amount is irrelevant when byMethod is present — resolveOutletSalesLegs ignores it in that branch.
        assertBalances('outlet_sales', '0.00', { byMethod: { cash, qris, online }, onlineFees: fees });
      }),
    );
  });

  it('outlet_stock_adjustment balances for shortage (attributable + non-attributable) and overage', () => {
    fc.assert(
      fc.property(money, fc.constantFrom('shortage', 'overage'), fc.boolean(), (amount, direction, attributable) =>
        assertBalances('outlet_stock_adjustment', amount, { direction, attributable })),
    );
  });

  it('outlet_direct_purchase balances for petty-cash and PO sources', () => {
    fc.assert(fc.property(money, fc.constantFrom('petty_cash', 'po', 'po_receipt'), (amount, source) => assertBalances('outlet_direct_purchase', amount, { source })));
  });

  it('outlet_petty_cash balances regardless of expense account override', () => {
    fc.assert(fc.property(money, fc.constantFrom(undefined, '6100', '6200'), (amount, expenseAccountCode) => assertBalances('outlet_petty_cash', amount, { expenseAccountCode })));
  });

  it('outlet_operating_expense balances for both paidVia', () => {
    fc.assert(fc.property(money, fc.constantFrom('cash', 'bank_transfer'), (amount, paidVia) => assertBalances('outlet_operating_expense', amount, { paidVia })));
  });

  it('offline_auth_rejected (X7) balances for both refund/void and waste sources', () => {
    fc.assert(fc.property(money, fc.constantFrom('refund_or_void', 'waste'), (amount, source) => assertBalances('offline_auth_rejected', amount, { source })));
  });

  it('payroll_accrual (X1/X1s, genuinely multi-leg) balances for any combination of present legs', () => {
    fc.assert(
      fc.property(
        smallMoney, smallMoney, smallMoney, fc.boolean(), smallMoney, smallMoney, smallMoney,
        (grossAmount, loanDeductionTotal, soShortfallDeductionTotal, statutoryMode, employerCostTotal, bpjsEmployeeDeductionTotal, pph21DeductionTotal) =>
          assertBalances('payroll_accrual', '0.00', {
            grossAmount, loanDeductionTotal, soShortfallDeductionTotal, statutoryMode,
            employerCostTotal, bpjsEmployeeDeductionTotal, pph21DeductionTotal,
          }),
      ),
    );
  });

  it('an unknown eventType returns null (no posting, not a crash)', () => {
    expect(resolvePureLegs('not_a_real_event_type', '1.00', {})).toBeNull();
  });
});
