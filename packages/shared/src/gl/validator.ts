/**
 * GL balance validator (D-04). A journal entry is valid only if debits equal
 * credits — the one invariant double-entry accounting cannot compromise on.
 * `ERR_UNBALANCED_ENTRY` is the exact code CONTRACTS.md §4.17's
 * `POST /api/accounting/journal` rejects an unbalanced manual entry with.
 */
import { isZeroMoney, sumMoney, compareMoney, isNegativeMoney } from '../money';
import { ERR_UNBALANCED_ENTRY, ERR_VALIDATION } from '../error-codes';
import type { Money } from '../types';

export interface JournalLineInput {
  accountCode: string;
  /** Exactly one of `debit`/`credit` must be a positive amount; the other `"0.00"`. */
  debit: Money;
  credit: Money;
  memo?: string;
}

export interface JournalEntryInput {
  lines: JournalLineInput[];
}

export type JournalValidationResult =
  | { ok: true; totalDebit: Money; totalCredit: Money }
  | { ok: false; code: string; message: string };

/** Sum of all `debit` values across the entry's lines. */
export function totalDebit(entry: JournalEntryInput): Money {
  return sumMoney(entry.lines.map((l) => l.debit));
}

/** Sum of all `credit` values across the entry's lines. */
export function totalCredit(entry: JournalEntryInput): Money {
  return sumMoney(entry.lines.map((l) => l.credit));
}

/** `true` iff Σdebit === Σcredit. This is the ONE invariant a journal entry must satisfy. */
export function isBalanced(entry: JournalEntryInput): boolean {
  return compareMoney(totalDebit(entry), totalCredit(entry)) === 0;
}

/**
 * Full structural + balance validation. Structural checks (every line has
 * exactly one non-zero side, no negative amounts, at least two lines) exist
 * because a "balanced" entry of zero lines or all-zero lines is a
 * degenerate pass that would hide a bug upstream — this function refuses it.
 */
export function validateJournalEntry(entry: JournalEntryInput): JournalValidationResult {
  if (entry.lines.length < 2) {
    return { ok: false, code: ERR_VALIDATION, message: 'A journal entry needs at least two lines' };
  }

  for (const line of entry.lines) {
    if (isNegativeMoney(line.debit) || isNegativeMoney(line.credit)) {
      return {
        ok: false,
        code: ERR_VALIDATION,
        message: `Line on ${line.accountCode} has a negative amount`,
      };
    }
    const debitSet = !isZeroMoney(line.debit);
    const creditSet = !isZeroMoney(line.credit);
    if (debitSet === creditSet) {
      return {
        ok: false,
        code: ERR_VALIDATION,
        message: `Line on ${line.accountCode} must have exactly one of debit/credit set, got debit=${line.debit} credit=${line.credit}`,
      };
    }
  }

  const debit = totalDebit(entry);
  const credit = totalCredit(entry);
  if (compareMoney(debit, credit) !== 0) {
    return {
      ok: false,
      code: ERR_UNBALANCED_ENTRY,
      message: `Entry does not balance: debit ${debit} ≠ credit ${credit}`,
    };
  }
  if (isZeroMoney(debit)) {
    return { ok: false, code: ERR_VALIDATION, message: 'A journal entry cannot total zero' };
  }

  return { ok: true, totalDebit: debit, totalCredit: credit };
}
