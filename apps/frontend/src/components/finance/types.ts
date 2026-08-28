import type { Money, UUID, ISODate, ISODateTime } from '@/lib/shared-types';

/**
 * Wire shapes for F07 finance (CONTRACTS.md §4.17). `Account`/`JournalEntry`/
 * `PaymentVerification`/`OfflineAuthCase` plus the enums are imported straight
 * from `@mimi/shared` — the module's real DTOs live there, per the pattern
 * `components/approvals/lib/types.ts` set (import the canonical shape rather
 * than fork a local copy that drifts).
 *
 * `FiscalPeriod` is declared locally because it is not exported from
 * `@mimi/shared`, but it is now CAMELCASE, matching CONTRACTS.md §4.17 and the
 * live response.
 *
 * IT USED TO BE SNAKE_CASE, and that was correct at the time: this one resource
 * returned `FiscalPeriodsService`'s raw `pg` rows with no mapping step, and the
 * mismatch was flagged rather than coded around. The service has since grown
 * that mapping (`toFiscalPeriod`) — but nothing updated this type, and TypeScript
 * cannot catch a lie about the shape of a JSON response. So every field read
 * came back `undefined` and the UI degraded exactly as an untyped read does:
 * blank period codes and "— – —" date ranges on the Periode Fiskal tab, and an
 * empty period dropdown on Laporan (which then had no period to request, so the
 * reports underneath it never loaded either).
 */
export type { Account, JournalEntry, PaymentVerification, OfflineAuthCase } from '@mimi/shared';
export { AccountType, PaymentVerificationRefType, PayeeType } from '@mimi/shared';

export interface FiscalPeriod {
  id: UUID;
  periodCode: string;
  startDate: ISODate;
  endDate: ISODate;
  status: 'open' | 'closed' | 'locked';
  closedBy: UUID | null;
  closedAt: ISODateTime | null;
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
