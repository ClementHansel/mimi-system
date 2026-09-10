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
  expect(
    result.ok,
    `eventType='${eventType}' context=${JSON.stringify(context)} legs=${JSON.stringify(legs)}: ${!result.ok ? result.message : ''}`,
  ).toBe(true);
}

describe('property: every posting-rule resolver produces a balanced entry', () => {
  const simpleEventTypes = [
    'gudang_purchase',
    'gudang_goods_in',
    'gudang_goods_out_to_outlet',
    'gudang_return_to_supplier',
    'gudang_waste',
    'outlet_ingredient_usage',
    'outlet_waste',
    'outlet_return_to_warehouse',
    'payroll_payment',
    'qris_settlement',
    'transfer_verified',
    'platform_settlement',
    'petty_cash_topup',
    'employee_loan_disbursement',
  ];

  it.each(simpleEventTypes)('%s (unconditional single pair) always balances', (eventType) => {
    fc.assert(fc.property(money, (amount) => assertBalances(eventType, amount, {})));
  });

  it('gudang_stock_adjustment balances for both shortage and overage', () => {
    fc.assert(
      fc.property(money, fc.constantFrom('shortage', 'overage'), (amount, direction) =>
        assertBalances('gudang_stock_adjustment', amount, { direction }),
      ),
    );
  });

  it('gudang_stock_revaluation balances for both up and down', () => {
    fc.assert(
      fc.property(money, fc.constantFrom('up', 'down'), (amount, direction) =>
        assertBalances('gudang_stock_revaluation', amount, { direction }),
      ),
    );
  });

  it('outlet_goods_in_from_warehouse balances with and without a discrepancy leg', () => {
    fc.assert(
      fc.property(money, fc.boolean(), smallMoney, (amount, discrepancy, shortfall) =>
        assertBalances('outlet_goods_in_from_warehouse', amount, { discrepancy, shortfall }),
      ),
    );
  });

  it('outlet_sales balances for the single-method shorthand', () => {
    fc.assert(
      fc.property(money, fc.constantFrom('cash', 'qris', 'bank_transfer'), (amount, method) =>
        assertBalances('outlet_sales', amount, { method }),
      ),
    );
  });

  it('outlet_sales balances for a multi-method daily aggregate (JOUT-03, incl. online fee leg)', () => {
    fc.assert(
      fc.property(smallMoney, smallMoney, smallMoney, smallMoney, (cash, qris, online, fees) => {
        // amount is irrelevant when byMethod is present — resolveOutletSalesLegs ignores it in that branch.
        assertBalances('outlet_sales', '0.00', {
          byMethod: { cash, qris, online },
          onlineFees: fees,
        });
      }),
    );
  });

  it('outlet_stock_adjustment balances for shortage (attributable + non-attributable) and overage', () => {
    fc.assert(
      fc.property(
        money,
        fc.constantFrom('shortage', 'overage'),
        fc.boolean(),
        (amount, direction, attributable) =>
          assertBalances('outlet_stock_adjustment', amount, { direction, attributable }),
      ),
    );
  });

  it('outlet_direct_purchase balances for petty-cash and PO sources', () => {
    fc.assert(
      fc.property(money, fc.constantFrom('petty_cash', 'po', 'po_receipt'), (amount, source) =>
        assertBalances('outlet_direct_purchase', amount, { source }),
      ),
    );
  });

  it('outlet_petty_cash balances regardless of expense account override', () => {
    fc.assert(
      fc.property(money, fc.constantFrom(undefined, '6100', '6200'), (amount, expenseAccountCode) =>
        assertBalances('outlet_petty_cash', amount, { expenseAccountCode }),
      ),
    );
  });

  it('outlet_operating_expense balances for both paidVia', () => {
    fc.assert(
      fc.property(money, fc.constantFrom('cash', 'bank_transfer'), (amount, paidVia) =>
        assertBalances('outlet_operating_expense', amount, { paidVia }),
      ),
    );
  });

  /**
   * The three PV-`paid` postings added with migration 267. `undefined` is in
   * the generator on purpose: `creditCashAccount` has to produce a real
   * account for a caller that passed no `paidVia` at all, and returning
   * `undefined` there would build a leg crediting account "undefined" — an
   * entry that balances arithmetically while pointing at nothing, which is
   * precisely the failure `validateJournalEntry` alone would not catch.
   */
  const paidViaEventTypes = [
    'supplier_payment',
    'maintenance_payment',
    'employee_compensation_payment',
    // Migration 268. `supplier_advance_offset` is deliberately NOT here: it
    // moves no cash and takes no paidVia, so feeding it this generator would
    // assert a property it does not have. It gets its own test below.
    'supplier_advance_payment',
  ];

  it.each(paidViaEventTypes)('%s balances for every paidVia (and for none)', (eventType) => {
    fc.assert(
      fc.property(
        money,
        fc.constantFrom(undefined, 'cash', 'bank_transfer', 'qris'),
        (amount, paidVia) => assertBalances(eventType, amount, { paidVia }),
      ),
    );
  });

  it.each(paidViaEventTypes)('%s credits a real 4-digit account, never undefined', (eventType) => {
    fc.assert(
      fc.property(
        money,
        fc.constantFrom(undefined, 'cash', 'bank_transfer', 'qris'),
        (amount, paidVia) => {
          const legs = resolvePureLegs(eventType, amount, { paidVia });
          expect(legs).not.toBeNull();
          for (const leg of legs!) {
            expect(leg.debit).toMatch(/^\d{4}$/);
            expect(leg.credit).toMatch(/^\d{4}$/);
          }
        },
      ),
    );
  });

  it('supplier_payment debits 2000 so the JGUD-01 payable actually clears', () => {
    // The whole point of the rule: `gudang_purchase` credits 2000 at receipt,
    // and before this nothing debited it back, so Hutang Supplier only ever
    // grew. Asserting the direction here — not just that it balances — is what
    // makes this test about the bug rather than about arithmetic.
    const accrual = resolvePureLegs('gudang_purchase', '1000000.00', {})!;
    const payment = resolvePureLegs('supplier_payment', '1000000.00', {
      paidVia: 'bank_transfer',
    })!;
    expect(accrual[0]!.credit).toBe('2000');
    expect(payment[0]!.debit).toBe('2000');
  });

  it('a PO advance debits 1130, never 2000 — the payable does not exist yet', () => {
    // The reason SUPPLIER_PAYMENT could not simply be reused for a down
    // payment. `gudang_purchase` is what CREATES the 2000 credit, and it has
    // not run when a DP is paid; debiting 2000 here would drive Hutang
    // Supplier to a debit balance for the whole time the order is in transit.
    const advance = resolvePureLegs('supplier_advance_payment', '5000000.00', {
      paidVia: 'bank_transfer',
    })!;
    expect(advance[0]!.debit).toBe('1130');
    expect(advance[0]!.debit).not.toBe('2000');
  });

  it('the advance offset turns 1130 into the 2000 the receipt accrued, moving no cash', () => {
    // Dr 2000 / Cr 1130. Paired with the accrual, a fully prepaid and fully
    // received PO leaves 2000 and 1130 both flat: the receipt credits 2000,
    // this debits it back, the advance debited 1130 and this credits it back.
    const accrual = resolvePureLegs('gudang_purchase', '5000000.00', {})!;
    const offset = resolvePureLegs('supplier_advance_offset', '5000000.00', {})!;
    expect(accrual[0]!.credit).toBe('2000');
    expect(offset[0]!.debit).toBe('2000');
    expect(offset[0]!.credit).toBe('1130');
    // No cash account on either leg — this is a reclassification, not a payment.
    expect([offset[0]!.debit, offset[0]!.credit]).not.toContain('1020');
    expect([offset[0]!.debit, offset[0]!.credit]).not.toContain('1000');
  });

  it('supplier_advance_offset balances regardless of a stray paidVia', () => {
    fc.assert(
      fc.property(money, fc.constantFrom(undefined, 'cash', 'bank_transfer', 'qris'), (amount, paidVia) =>
        assertBalances('supplier_advance_offset', amount, { paidVia }),
      ),
    );
  });

  it('offline_auth_rejected (X7) balances for both refund/void and waste sources', () => {
    fc.assert(
      fc.property(money, fc.constantFrom('refund_or_void', 'waste'), (amount, source) =>
        assertBalances('offline_auth_rejected', amount, { source }),
      ),
    );
  });

  it('payroll_accrual (X1/X1s, genuinely multi-leg) balances for any combination of present legs', () => {
    fc.assert(
      fc.property(
        smallMoney,
        smallMoney,
        smallMoney,
        fc.boolean(),
        smallMoney,
        smallMoney,
        smallMoney,
        (
          grossAmount,
          loanDeductionTotal,
          soShortfallDeductionTotal,
          statutoryMode,
          employerCostTotal,
          bpjsEmployeeDeductionTotal,
          pph21DeductionTotal,
        ) =>
          assertBalances('payroll_accrual', '0.00', {
            grossAmount,
            loanDeductionTotal,
            soShortfallDeductionTotal,
            statutoryMode,
            employerCostTotal,
            bpjsEmployeeDeductionTotal,
            pph21DeductionTotal,
          }),
      ),
    );
  });

  it('an unknown eventType returns null (no posting, not a crash)', () => {
    expect(resolvePureLegs('not_a_real_event_type', '1.00', {})).toBeNull();
  });
});
