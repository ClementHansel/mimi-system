import type { Money, UUID } from '@mimi/shared';

/**
 * M17 `accounting` — shared row/internal shapes (CONTRACTS.md §1.10 block
 * 090-099, §4.17). Kept local to this module rather than `@mimi/shared`
 * because `Account`/`JournalEntry`/`PaymentVerification` wire DTOs already
 * live there (`packages/shared/src/interfaces/index.ts`) — these are the raw
 * `pg` row shapes underneath them, which is this module's own concern, not a
 * cross-module contract.
 */

/**
 * `node-pg` parses a `DATE` column into a JS `Date` constructed via the
 * LOCAL-timezone constructor (`new Date(year, month-1, day)`, confirmed by
 * this exact off-by-one-day symptom surfacing in
 * `accounting.integration.spec.ts`'s periods test) — not UTC, and there is
 * no global `types.setTypeParser` override anywhere in this backend
 * (`modules/report/report.types.ts` documents the same absence for
 * `TIMESTAMPTZ`). Calling `.toISOString()` on that value re-reads it as UTC,
 * which SHIFTS the calendar date by the server process's UTC offset — under
 * `Asia/Makassar` (UTC+8, D-11's mandated timezone), a `fiscal_periods.end_date`
 * of June 30 serializes as `"2026-06-29T16:00:00.000Z"`, one full day off
 * from the `ISODate` (`YYYY-MM-DD`, no time component) CONTRACTS.md
 * documents for this field. Every `DATE` column this module returns over
 * HTTP (`fiscal_periods.start_date`/`end_date`, `journal_entries.entry_date`)
 * must go through this helper — reading the Date's LOCAL calendar
 * components (which is what recovers the ORIGINAL y/m/d pg's local
 * constructor encoded) rather than its UTC ones. Passing a value pg has NOT
 * converted (already a plain string — a defensive case, not the expected
 * one on this backend today) is a safe no-op.
 */
export function formatDateOnly(value: unknown): string {
  if (!(value instanceof Date)) return String(value);
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, '0');
  const d = String(value.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export interface AccountRow {
  id: UUID;
  code: string;
  name: string;
  type: string;
  normal_balance: 'debit' | 'credit';
  parent_id: UUID | null;
  is_postable: boolean;
  is_system: boolean;
  is_active: boolean;
}

export interface FiscalPeriodRow {
  id: UUID;
  period_code: string;
  start_date: string;
  end_date: string;
  status: 'open' | 'closed' | 'locked';
  closed_by: UUID | null;
  closed_at: string | null;
}

/**
 * The wire shape CONTRACTS.md §4.17 documents for `GET/POST
 * /api/accounting/periods*` — camelCase, exactly the 5 fields listed there
 * (`{id; periodCode; startDate; endDate; status}`), never the raw
 * `FiscalPeriodRow`. Found leaking as snake_case (`FiscalPeriodsService`
 * returning `FiscalPeriodRow` straight to the controller) by the finance UI
 * build — every other §4.17 endpoint in this module already maps through a
 * `toX()` function before returning; this was the one that didn't.
 */
export interface FiscalPeriod {
  id: UUID;
  periodCode: string;
  startDate: string;
  endDate: string;
  status: 'open' | 'closed' | 'locked';
}

export function toFiscalPeriod(row: FiscalPeriodRow): FiscalPeriod {
  return { id: row.id, periodCode: row.period_code, startDate: formatDateOnly(row.start_date), endDate: formatDateOnly(row.end_date), status: row.status };
}

export interface JournalEntryRow {
  id: UUID;
  entry_number: string;
  entry_date: string;
  fiscal_period_id: UUID;
  event_type: string | null;
  source: 'system' | 'manual';
  ref_type: string | null;
  ref_id: UUID | null;
  location_id: UUID | null;
  location_name: string | null;
  description: string;
  status: 'posted' | 'reversed';
  reversed_by_entry_id: UUID | null;
  posted_by: UUID | null;
  posted_at: string;
}

export interface JournalLineRow {
  id: UUID;
  entry_id: UUID;
  line_no: number;
  account_id: UUID;
  account_code: string;
  account_name: string;
  debit: Money;
  credit: Money;
  location_id: UUID | null;
  memo: string | null;
}

/** One Dr/Cr pair the posting engine (or a manual entry) is about to insert — pre-account-lookup. */
export interface DraftLine {
  accountCode: string;
  debit: Money;
  credit: Money;
  memo?: string | null;
}

export interface PaymentVerificationRow {
  id: UUID;
  pv_number: string;
  ref_type: string;
  ref_id: UUID | null;
  ref_number: string | null;
  payee_type: string;
  payee_id: UUID | null;
  payee_name: string | null;
  amount: Money;
  status: 'pending' | 'verified' | 'paid' | 'rejected';
  proof_attachment_id: UUID | null;
  proof_url: string | null;
  reference_number: string | null;
  submitted_by: UUID;
  verified_by: UUID | null;
  verified_at: string | null;
  approval_id: UUID | null;
  paid_by: UUID | null;
  paid_at: string | null;
  paid_via: string | null;
  rejection_reason: string | null;
  location_id: UUID | null;
  location_name: string | null;
  notes: string | null;
}

/**
 * Machine-parseable marker this module writes into `payment_verifications
 * .notes` to distinguish the two D-04 "prose-only" postings (petty-cash
 * float top-up, employee loan disbursement — CONTRACTS.md §6.3 closing
 * paragraph) from an ordinary payment. NOT a schema change: `ref_type`'s DB
 * CHECK constraint (migration 094) has no 'petty_cash_topup'/'employee_loan'
 * values, and `JournalSystemEventType` (`@mimi/shared`, frozen) has no
 * matching enum members either (carried item #2 — reported, not fixed here).
 * This prefix is the workaround that needs neither: it rides inside the
 * existing free-text `notes` column and is parsed back out in
 * `PaymentVerificationsService.pay()`. See that method's doc comment for the
 * full reasoning and the follow-up this leaves for senior-db/the coordinator.
 */
export const PV_KIND_MARKER = {
  PETTY_CASH_TOPUP: '#kind:petty_cash_topup',
  EMPLOYEE_LOAN_DISBURSEMENT: '#kind:employee_loan_disbursement',
} as const;

export function extractPvKind(notes: string | null): 'petty_cash_topup' | 'employee_loan_disbursement' | null {
  if (!notes) return null;
  if (notes.includes(PV_KIND_MARKER.PETTY_CASH_TOPUP)) return 'petty_cash_topup';
  if (notes.includes(PV_KIND_MARKER.EMPLOYEE_LOAN_DISBURSEMENT)) return 'employee_loan_disbursement';
  return null;
}
