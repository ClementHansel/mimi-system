import type { Money, UUID, ISODate, ISODateTime } from '@/lib/shared-types';

/**
 * Wire shapes for F07 finance (CONTRACTS.md §4.17). `Account`/`JournalEntry`/
 * `PaymentVerification`/`OfflineAuthCase` plus the enums are imported straight
 * from `@mimi/shared` — the module's real DTOs live there, per the pattern
 * `components/approvals/lib/types.ts` set (import the canonical shape rather
 * than fork a local copy that drifts).
 *
 * `FiscalPeriodRow` is declared locally, snake_case, NOT camelCase — despite
 * CONTRACTS.md §4.17 documenting `{id; periodCode; startDate; endDate;
 * status}`, `PeriodsController`'s `list()`/`close()`/`reopen()` return
 * `FiscalPeriodsService`'s raw `pg` rows verbatim (`apps/backend/.../
 * fiscal-periods.service.ts` — no camelCase mapping step exists for this one
 * resource, unlike every other §4.17 endpoint). Typed to match the actual
 * live response, with the mismatch flagged in the build report rather than
 * silently coded around.
 */
export type { Account, JournalEntry, PaymentVerification, OfflineAuthCase } from '@mimi/shared';
export { AccountType, PaymentVerificationRefType, PayeeType } from '@mimi/shared';

export interface FiscalPeriodRow {
  id: UUID;
  period_code: string;
  start_date: ISODate;
  end_date: ISODate;
  status: 'open' | 'closed' | 'locked';
  closed_by: UUID | null;
  closed_at: ISODateTime | null;
}

export interface PostingRule {
  eventType: string;
  ruleSeq: number;
  condition: object | null;
  debitAccountCode: string;
  creditAccountCode: string;
  amountSource: string;
  isActive: boolean;
}

export interface TrialBalanceLine {
  accountCode: string;
  accountName: string;
  type: string;
  debit: Money;
  credit: Money;
}

export interface TrialBalanceReport {
  rows: TrialBalanceLine[];
  totalDebit: Money;
  totalCredit: Money;
  balanced: boolean;
}

export interface PLLine {
  accountCode: string;
  name: string;
  amount: Money;
}

export interface ProfitLossReport {
  revenue: PLLine[];
  expenses: PLLine[];
  totalRevenue: Money;
  totalExpense: Money;
  netProfit: Money;
}

export interface BalanceSheetReport {
  assets: PLLine[];
  liabilities: PLLine[];
  equity: PLLine[];
  balanced: boolean;
}

export interface StockValueRow {
  locationId: UUID;
  locationName: string;
  value: Money;
  byCategory: { categoryName: string; value: Money }[];
}

export type { UUID, ISODate, ISODateTime, Money };
