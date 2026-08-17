/**
 * The PRD's 7 income (PIN-01..07) and 9 deduction (POUT-01..09) components as
 * pure functions — CONTRACTS.md §1.7 (`salary_components.formula_key`) and
 * §4.15. Each function takes exactly the inputs its formula needs (attendance
 * counts, rates, prior balances) and returns a `Money` amount; none of them
 * read attendance/loan/opname state themselves — the caller (M15) assembles
 * the inputs from real rows. Always active regardless of the D-18 statutory
 * flag (that layer is additive, see `./statutory`).
 */
import { addMoney, isNegativeMoney, minMoney, mulMoneyByQty, subMoney, sumMoney, ZERO_MONEY, MONEY_SCALE } from '../money';
import { divFixed, formatFixed, parseFixed } from '../decimal/fixed-point';
import type { ISODate, Money } from '../types';

// ── PIN-01: base salary ───────────────────────────────────────────────────────

/** PIN-01 — the employee's current `employments.base_salary`, passed straight through. */
export function baseSalary(monthlyBaseSalary: Money): Money {
  return monthlyBaseSalary;
}

/**
 * A monthly salary's per-day equivalent, used by every day-counted deduction
 * below (POUT-01..04). Rounds UP (ceil) — a daily rate used for a deduction
 * must never understate what a day of pay is worth.
 */
export function dailyRateFromMonthlySalary(monthlyBaseSalary: Money, daysInMonth: number): Money {
  if (!Number.isInteger(daysInMonth) || daysInMonth <= 0) {
    throw new RangeError(`daysInMonth must be a positive integer, got ${daysInMonth}`);
  }
  return formatFixed(
    divFixed(parseFixed(monthlyBaseSalary, MONEY_SCALE), MONEY_SCALE, BigInt(daysInMonth), 0, MONEY_SCALE, 'ceil'),
    MONEY_SCALE,
  );
}

// ── PIN-02 / POUT-07: overtime & lateness (both read from `attendance`) ──────

/** PIN-02 — overtime pay from attendance's computed `overtime_minutes` (see `../wita`). */
export function overtimePay(overtimeMinutesTotal: number, ratePerHour: Money): Money {
  if (overtimeMinutesTotal <= 0) return ZERO_MONEY;
  const hours = (overtimeMinutesTotal / 60).toFixed(3);
  return mulMoneyByQty(ratePerHour, hours);
}

/** POUT-07 — late-arrival deduction from attendance's computed `late_minutes` total for the period. */
export function deductionLate(lateMinutesTotal: number, perLateMinuteRate: Money): Money {
  if (lateMinutesTotal <= 0) return ZERO_MONEY;
  return mulMoneyByQty(perLateMinuteRate, lateMinutesTotal.toFixed(3));
}

// ── PIN-03: attendance allowance ──────────────────────────────────────────────

/** PIN-03 — a flat bonus paid only when the employee had zero late/absent days in the period. */
export function attendanceAllowance(hasPerfectAttendance: boolean, allowanceAmount: Money): Money {
  return hasPerfectAttendance ? allowanceAmount : ZERO_MONEY;
}

// ── PIN-04: performance incentive (manual/fixed, per-employee assignment) ────

/** PIN-04 — manager-assigned amount; identity function kept for API symmetry with the rest of §1.7. */
export function performanceIncentive(assignedAmount: Money | null): Money {
  return assignedAmount ?? ZERO_MONEY;
}

// ── PIN-05: tenure allowance ───────────────────────────────────────────────────

export interface TenureTier {
  minYears: number;
  amount: Money;
}

/** Full years of service between join date and the payroll period's `asOfDate`. */
export function yearsOfService(joinDate: ISODate, asOfDate: ISODate): number {
  const join = new Date(`${joinDate}T00:00:00.000Z`);
  const asOf = new Date(`${asOfDate}T00:00:00.000Z`);
  if (Number.isNaN(join.getTime()) || Number.isNaN(asOf.getTime())) {
    throw new RangeError('Invalid date passed to yearsOfService');
  }
  let years = asOf.getUTCFullYear() - join.getUTCFullYear();
  const anniversaryThisYear = new Date(Date.UTC(asOf.getUTCFullYear(), join.getUTCMonth(), join.getUTCDate()));
  if (asOf < anniversaryThisYear) years -= 1;
  return Math.max(0, years);
}

/** PIN-05 — highest tier whose `minYears` the employee has reached; `0` when no tier matches (tiers sorted descending internally). */
export function tenureAllowance(joinDate: ISODate, asOfDate: ISODate, tiers: readonly TenureTier[]): Money {
  const years = yearsOfService(joinDate, asOfDate);
  const sorted = [...tiers].sort((a, b) => b.minYears - a.minYears);
  const matched = sorted.find((t) => years >= t.minYears);
  return matched?.amount ?? ZERO_MONEY;
}

// ── PIN-06: position allowance (manual/fixed, per-employee assignment) ───────

/** PIN-06 — manager-assigned amount; identity function kept for API symmetry. */
export function positionAllowance(assignedAmount: Money | null): Money {
  return assignedAmount ?? ZERO_MONEY;
}

// ── PIN-07: other earning (manual line items) ─────────────────────────────────

/** PIN-07 — Σ of any manually-added earning lines for the period. */
export function otherEarnings(amounts: readonly Money[]): Money {
  return sumMoney([...amounts]);
}

// ── POUT-01 / POUT-02: sick / permission deductions ───────────────────────────

/** POUT-01 — sick-day deduction; `sickPaid` (`settings['hr.deduction_rates'].sickPaid`) makes it a no-op when true. */
export function deductionSick(sickDays: number, dailyRate: Money, sickPaid: boolean): Money {
  if (sickPaid || sickDays <= 0) return ZERO_MONEY;
  return mulMoneyByQty(dailyRate, sickDays.toFixed(3));
}

/** POUT-02 — izin (permission) deduction; `permissionPaid` makes it a no-op when true. */
export function deductionPermission(permissionDays: number, dailyRate: Money, permissionPaid: boolean): Money {
  if (permissionPaid || permissionDays <= 0) return ZERO_MONEY;
  return mulMoneyByQty(dailyRate, permissionDays.toFixed(3));
}

// ── POUT-03: absence (alpha) ───────────────────────────────────────────────────

/** POUT-03 — unexcused absence ("alpha") is always deducted; there is no paid variant. */
export function deductionAbsence(absentDays: number, dailyRate: Money): Money {
  if (absentDays <= 0) return ZERO_MONEY;
  return mulMoneyByQty(dailyRate, absentDays.toFixed(3));
}

// ── POUT-04: leave beyond quota ────────────────────────────────────────────────

/** POUT-04 — only days taken beyond the annual/marriage quota are deducted. */
export function deductionLeaveExcess(daysTaken: number, quotaDays: number, dailyRate: Money): Money {
  const excessDays = Math.max(0, daysTaken - quotaDays);
  if (excessDays <= 0) return ZERO_MONEY;
  return mulMoneyByQty(dailyRate, excessDays.toFixed(3));
}

// ── POUT-05: stock shortfall (from an approved opname) ────────────────────────

/**
 * POUT-05 — an approved stock-opname shortfall attributed to this employee,
 * split per `settings['payroll.so_shortfall'].splitRule` (equal split among
 * on-shift staff by default). The split itself happens in the caller (it
 * needs the shift roster); this function only takes the employee's already-
 * apportioned share.
 */
export function deductionStockShortfall(apportionedShare: Money): Money {
  return isNegativeMoney(apportionedShare) ? ZERO_MONEY : apportionedShare;
}

/** Equal-split helper for `splitRule: 'equal_among_on_shift'` — cent-exact, no rounding leak (see `splitMoneyEvenly`). */
export { splitMoneyEvenly as splitStockShortfallEvenly } from '../money';

// ── POUT-06: loan (kasbon) amortization ────────────────────────────────────────

/** POUT-06 — this period's installment, capped at whatever principal remains (never overcollect). */
export function loanInstallment(outstanding: Money, monthlyInstallment: Money): Money {
  if (isNegativeMoney(outstanding)) return ZERO_MONEY;
  return minMoney(outstanding, monthlyInstallment);
}

/** The loan's remaining balance after this period's installment posts. */
export function loanOutstandingAfter(outstanding: Money, installmentTaken: Money): Money {
  return subMoney(outstanding, installmentTaken);
}

// ── POUT-09 (+ D-19's cash-variance family, Amendment 2): other deductions ────

/** POUT-09 — Σ of any manually-added deduction lines for the period. */
export function otherDeductions(amounts: readonly Money[]): Money {
  return sumMoney([...amounts]);
}

/**
 * D-19 / Amendment 2 — Σ of `cash_variance_proposals` approved this period and
 * not yet linked to a run (`source_ref_type='cash_variance_proposal'`). Lands
 * on the `deduction_cash_variance` component, a member of the POUT-09 family.
 */
export function deductionCashVariance(approvedProposalAmounts: readonly Money[]): Money {
  return sumMoney([...approvedProposalAmounts]);
}

/** Convenience: Σ of a set of earning amounts, e.g. combining PIN-04/06/07 manual lines for a total. */
export function sumEarnings(amounts: readonly Money[]): Money {
  return sumMoney([...amounts]);
}

export function sumDeductions(amounts: readonly Money[]): Money {
  return amounts.reduce((acc, a) => addMoney(acc, a), ZERO_MONEY);
}
