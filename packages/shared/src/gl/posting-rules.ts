/**
 * The posting-rule table — CONTRACTS.md §6.2 (the 16 PRD journal event types)
 * and §6.3 (D-04 system extensions X1..X7, including X1s for statutory
 * payroll legs, Amendment 1) — transcribed as executable data. This is a
 * DESCRIPTION of which accounts a domain event debits/credits and where the
 * amount comes from; it is deliberately not a posting ENGINE (that consumes
 * applied domain events at runtime, in `apps/backend/src/modules/accounting`,
 * against real rows this zero-I/O package never sees). `./validator` is the
 * part of this package that actually executes: it checks any journal entry
 * the engine assembles is balanced.
 *
 * A rule's debit/credit account can depend on a condition (e.g. JGUD-06 posts
 * to different accounts for a shortage vs. an overage) — modeled as an
 * `AccountSelector`, resolved by `resolvePostingAccounts`.
 */
import { JournalEventType, JournalSystemEventType } from '../enums';

export type AccountSelector = string | { by: string; cases: Record<string, string> };

export function resolvePostingAccount(
  selector: AccountSelector,
  condition: Record<string, unknown> | undefined,
): string {
  if (typeof selector === 'string') return selector;
  const value = condition?.[selector.by];
  const resolved = value === undefined ? undefined : selector.cases[String(value)];
  if (resolved === undefined) {
    throw new RangeError(
      `Cannot resolve posting account: condition key "${selector.by}" = ${JSON.stringify(value)} has no matching case`,
    );
  }
  return resolved;
}

export interface PostingRule {
  eventType: JournalEventType | JournalSystemEventType;
  /** Disambiguates events with more than one applicable rule (e.g. JOUT-01 has a base rule and a discrepancy rule). */
  ruleSeq: number;
  /** Human-readable condition key this rule fires under, e.g. `{ direction: 'shortage' }`; `null` = unconditional. */
  condition: Record<string, string> | null;
  debitAccountCode: AccountSelector;
  creditAccountCode: AccountSelector;
  /** Descriptive formula — the actual computation happens in the posting engine, not here. */
  amountSource: string;
  note?: string;
}

// prettier-ignore
export const POSTING_RULES: readonly PostingRule[] = [
  // ── §6.2 — the 16 PRD journal event types ──────────────────────────────────
  { eventType: JournalEventType.GUDANG_PURCHASE, ruleSeq: 1, condition: null, debitAccountCode: '1100', creditAccountCode: '2000', amountSource: 'Σ receipt_line.qty_received × po_line.unit_price', note: 'JGUD-01' },
  { eventType: JournalEventType.GUDANG_GOODS_IN, ruleSeq: 1, condition: null, debitAccountCode: '1100', creditAccountCode: '1120', amountSource: 'Σ line.qty_received × line.unit_cost', note: 'JGUD-02' },
  { eventType: JournalEventType.GUDANG_GOODS_OUT_TO_OUTLET, ruleSeq: 1, condition: null, debitAccountCode: '1120', creditAccountCode: '1100', amountSource: 'Σ sj_line.qty × items.avg_cost at dispatch', note: 'JGUD-03' },
  { eventType: JournalEventType.GUDANG_RETURN_TO_SUPPLIER, ruleSeq: 1, condition: null, debitAccountCode: '2000', creditAccountCode: '1100', amountSource: 'Σ line.qty × line.unit_cost', note: 'JGUD-04' },
  { eventType: JournalEventType.GUDANG_WASTE, ruleSeq: 1, condition: null, debitAccountCode: '5100', creditAccountCode: '1100', amountSource: 'Σ qty × unit_cost (at approval)', note: 'JGUD-05' },
  { eventType: JournalEventType.GUDANG_STOCK_ADJUSTMENT, ruleSeq: 1, condition: { direction: 'shortage' }, debitAccountCode: '6400', creditAccountCode: '1100', amountSource: '|qty_delta| × unit_cost', note: 'JGUD-06 shortage' },
  { eventType: JournalEventType.GUDANG_STOCK_ADJUSTMENT, ruleSeq: 2, condition: { direction: 'overage' }, debitAccountCode: '1100', creditAccountCode: '4100', amountSource: '|qty_delta| × unit_cost', note: 'JGUD-06 overage' },
  { eventType: JournalEventType.GUDANG_STOCK_REVALUATION, ruleSeq: 1, condition: { direction: 'up' }, debitAccountCode: '1100', creditAccountCode: '5090', amountSource: 'Σ qty_on_hand × Δcost', note: 'JGUD-07 up (Appendix A-8: primarily a report)' },
  { eventType: JournalEventType.GUDANG_STOCK_REVALUATION, ruleSeq: 2, condition: { direction: 'down' }, debitAccountCode: '5090', creditAccountCode: '1100', amountSource: 'Σ qty_on_hand × Δcost', note: 'JGUD-07 down' },
  { eventType: JournalEventType.OUTLET_GOODS_IN_FROM_WAREHOUSE, ruleSeq: 1, condition: null, debitAccountCode: '1110', creditAccountCode: '1120', amountSource: 'Σ line.qty_received × cost', note: 'JOUT-01 base' },
  { eventType: JournalEventType.OUTLET_GOODS_IN_FROM_WAREHOUSE, ruleSeq: 2, condition: { discrepancy: 'true' }, debitAccountCode: '6400', creditAccountCode: '1120', amountSource: 'Σ (qty − qty_received) × cost', note: 'JOUT-01b shortfall in transit; pending C2/C6 investigation' },
  { eventType: JournalEventType.OUTLET_INGREDIENT_USAGE, ruleSeq: 1, condition: null, debitAccountCode: '5000', creditAccountCode: '1110', amountSource: 'Σ usage_out.qty × unit_cost for the day', note: 'JOUT-02' },
  { eventType: JournalEventType.OUTLET_SALES, ruleSeq: 1, condition: { method: 'cash' }, debitAccountCode: '1000', creditAccountCode: '4000', amountSource: 'Σ payments.amount (cash)', note: 'JOUT-03' },
  { eventType: JournalEventType.OUTLET_SALES, ruleSeq: 2, condition: { method: 'qris' }, debitAccountCode: '1031', creditAccountCode: '4000', amountSource: 'Σ payments.amount (qris)', note: 'JOUT-03' },
  { eventType: JournalEventType.OUTLET_SALES, ruleSeq: 3, condition: { method: 'bank_transfer' }, debitAccountCode: '1032', creditAccountCode: '4000', amountSource: 'Σ payments.amount (bank_transfer)', note: 'JOUT-03' },
  { eventType: JournalEventType.OUTLET_SALES, ruleSeq: 4, condition: { source: 'online_order' }, debitAccountCode: '1030', creditAccountCode: '4000', amountSource: 'gross to 4000 (net leg 1030, fee leg 6300 below)', note: 'JOUT-03 online — net leg' },
  { eventType: JournalEventType.OUTLET_SALES, ruleSeq: 5, condition: { source: 'online_order_fee' }, debitAccountCode: '6300', creditAccountCode: '1030', amountSource: 'fees + discount', note: 'JOUT-03 online — platform fee leg' },
  { eventType: JournalEventType.OUTLET_WASTE, ruleSeq: 1, condition: null, debitAccountCode: '5100', creditAccountCode: '1110', amountSource: 'Σ qty × unit_cost', note: 'JOUT-04' },
  { eventType: JournalEventType.OUTLET_RETURN_TO_WAREHOUSE, ruleSeq: 1, condition: null, debitAccountCode: '1120', creditAccountCode: '1110', amountSource: 'Σ qty × unit_cost', note: 'JOUT-05' },
  { eventType: JournalEventType.OUTLET_STOCK_ADJUSTMENT, ruleSeq: 1, condition: { direction: 'shortage', attributable: 'false' }, debitAccountCode: '6400', creditAccountCode: '1110', amountSource: '|qty_delta| × unit_cost', note: 'JOUT-06 shortage, non-attributable' },
  { eventType: JournalEventType.OUTLET_STOCK_ADJUSTMENT, ruleSeq: 2, condition: { direction: 'shortage', attributable: 'true' }, debitAccountCode: '1210', creditAccountCode: '1110', amountSource: '|qty_delta| × unit_cost', note: 'JOUT-06 shortage, attributable → POUT-05 source' },
  { eventType: JournalEventType.OUTLET_STOCK_ADJUSTMENT, ruleSeq: 3, condition: { direction: 'overage' }, debitAccountCode: '1110', creditAccountCode: '4100', amountSource: '|qty_delta| × unit_cost', note: 'JOUT-06 overage' },
  { eventType: JournalEventType.OUTLET_DIRECT_PURCHASE, ruleSeq: 1, condition: { source: 'petty_cash' }, debitAccountCode: '1110', creditAccountCode: '1010', amountSource: 'Σ stockable line amount', note: 'JOUT-07 via petty cash' },
  { eventType: JournalEventType.OUTLET_DIRECT_PURCHASE, ruleSeq: 2, condition: { source: 'po_receipt' }, debitAccountCode: '1110', creditAccountCode: '2000', amountSource: 'Σ stockable line amount', note: 'JOUT-07 via PO' },
  { eventType: JournalEventType.OUTLET_PETTY_CASH, ruleSeq: 1, condition: null, debitAccountCode: '6100', creditAccountCode: '1010', amountSource: 'Σ non-stockable line amount', note: 'JOUT-08 (debit account varies per expense_category mapping; 6100 is the default)' },
  { eventType: JournalEventType.OUTLET_OPERATING_EXPENSE, ruleSeq: 1, condition: { paidVia: 'bank' }, debitAccountCode: '6100', creditAccountCode: '1020', amountSource: 'pv.amount', note: 'JOUT-09 via bank' },
  { eventType: JournalEventType.OUTLET_OPERATING_EXPENSE, ruleSeq: 2, condition: { paidVia: 'cash' }, debitAccountCode: '6100', creditAccountCode: '1000', amountSource: 'pv.amount', note: 'JOUT-09 via kas' },

  // ── §6.3 — system extensions beyond the PRD's 16 ───────────────────────────
  { eventType: JournalSystemEventType.PAYROLL_ACCRUAL, ruleSeq: 1, condition: null, debitAccountCode: '6000', creditAccountCode: '2100', amountSource: 'run totals (gross debited; net credited to Hutang Gaji)', note: 'X1' },
  { eventType: JournalSystemEventType.PAYROLL_ACCRUAL, ruleSeq: 2, condition: { statutoryMode: 'true' }, debitAccountCode: '6010', creditAccountCode: '2110', amountSource: 'Σ statutory lines by component (BPJS employer legs; BPJS employee shares also credit 2110)', note: 'X1s — Amendment 1, only on statutory_mode=true runs' },
  { eventType: JournalSystemEventType.PAYROLL_ACCRUAL, ruleSeq: 3, condition: { statutoryMode: 'true', component: 'pph21' }, debitAccountCode: '2100', creditAccountCode: '2120', amountSource: 'Σ pph21 deduction lines', note: 'X1s — PPh21 leg' },
  { eventType: JournalSystemEventType.PAYROLL_PAYMENT, ruleSeq: 1, condition: null, debitAccountCode: '2100', creditAccountCode: '1020', amountSource: 'total_net', note: 'X2 — BPJS/PPh21 remittances post separately as PV paid, ref_type=other' },
  { eventType: JournalSystemEventType.QRIS_SETTLEMENT, ruleSeq: 1, condition: null, debitAccountCode: '1020', creditAccountCode: '1031', amountSource: 'settled amount', note: 'X3' },
  { eventType: JournalSystemEventType.TRANSFER_VERIFIED, ruleSeq: 1, condition: null, debitAccountCode: '1020', creditAccountCode: '1032', amountSource: 'payment amount', note: 'X4' },
  { eventType: JournalSystemEventType.PLATFORM_SETTLEMENT, ruleSeq: 1, condition: null, debitAccountCode: '1020', creditAccountCode: '1030', amountSource: 'payout amount', note: 'X5' },
  { eventType: JournalSystemEventType.SALE_VOID_REVERSAL, ruleSeq: 1, condition: null, debitAccountCode: '4000', creditAccountCode: '1000', amountSource: 'sale amounts — revenue Dr reversal, cash/QRIS/transfer Cr back (account per method)', note: 'X6 revenue+payment legs' },
  { eventType: JournalSystemEventType.SALE_VOID_REVERSAL, ruleSeq: 2, condition: null, debitAccountCode: '1110', creditAccountCode: '5000', amountSource: 'sale amounts — usage back Dr, HPP Cr', note: 'X6 inventory+HPP legs' },
  { eventType: JournalSystemEventType.OFFLINE_AUTH_REJECTED, ruleSeq: 1, condition: { source: 'refund_or_void' }, debitAccountCode: '1220', creditAccountCode: '4000', amountSource: 'document amount', note: 'X7 — refund/void unwind: claim receivable vs. re-recognized revenue' },
  { eventType: JournalSystemEventType.OFFLINE_AUTH_REJECTED, ruleSeq: 2, condition: { source: 'waste' }, debitAccountCode: '1220', creditAccountCode: '5100', amountSource: 'document amount', note: 'X7 — waste unwind: claim receivable vs. waste expense reversal' },
  // §6.3 closing paragraph (X-family; named in prose but, until this fix, absent from both the
  // §2 enum listing and this table — the same gap independently hit by W4-03 and flagged by
  // W1-C's migration 093 comment).
  { eventType: JournalSystemEventType.PETTY_CASH_TOPUP, ruleSeq: 1, condition: null, debitAccountCode: '1010', creditAccountCode: '1020', amountSource: 'top-up amount', note: 'petty cash float top-up, posted from its payment_verifications.paid event' },
  { eventType: JournalSystemEventType.EMPLOYEE_LOAN_DISBURSEMENT, ruleSeq: 1, condition: null, debitAccountCode: '1210', creditAccountCode: '1020', amountSource: 'loan principal', note: 'kasbon disbursement, posted from its payment_verifications.paid event; the recurring installment leg is separate, folded into PAYROLL_ACCRUAL (POUT-06)' },
];

export function postingRulesFor(
  eventType: JournalEventType | JournalSystemEventType,
): readonly PostingRule[] {
  return POSTING_RULES.filter((r) => r.eventType === eventType);
}
