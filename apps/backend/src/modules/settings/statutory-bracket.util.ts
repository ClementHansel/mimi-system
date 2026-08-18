/**
 * Bracket-contiguity validation shared by the D-18 statutory rate tables
 * (PPh21 TER, PPh21 Article-17) — CONTRACTS.md §4.15: "brackets must be
 * contiguous from 0" (TER, per category) / "brackets contiguous from 0, top
 * bracket open-ended" (Article-17). `ERR_BRACKET_GAP` on any violation.
 */
import { compareMoney, ZERO_MONEY, type Money } from '@mimi/shared';

export interface BracketLike {
  bracketMin: Money;
  bracketMax: Money | null;
}

/**
 * Sorts by `bracketMin` and checks: first row starts at 0, each row's
 * `bracketMax` equals the next row's `bracketMin` (no gap, no overlap), and
 * (when `requireOpenEndedTop`) the last row's `bracketMax` is `null`.
 * Returns a human-diagnostic error list — empty means valid.
 */
export function validateContiguousBrackets(
  rows: BracketLike[],
  opts: { requireOpenEndedTop: boolean },
): string[] {
  if (rows.length === 0) return ['at least one bracket is required'];

  const sorted = [...rows].sort((a, b) => compareMoney(a.bracketMin, b.bracketMin));
  const errors: string[] = [];

  if (compareMoney(sorted[0]!.bracketMin, ZERO_MONEY) !== 0) {
    errors.push(`the first bracket must start at 0 (got ${sorted[0]!.bracketMin})`);
  }

  for (let i = 0; i < sorted.length - 1; i++) {
    const current = sorted[i]!;
    const next = sorted[i + 1]!;
    if (current.bracketMax === null) {
      errors.push(
        `bracket starting at ${current.bracketMin} is open-ended but is not the last bracket`,
      );
      continue;
    }
    if (compareMoney(current.bracketMax, next.bracketMin) !== 0) {
      errors.push(
        `gap or overlap between bracket [${current.bracketMin}, ${current.bracketMax}) and the next bracket starting at ${next.bracketMin}`,
      );
    }
  }

  const last = sorted[sorted.length - 1]!;
  if (opts.requireOpenEndedTop && last.bracketMax !== null) {
    errors.push(
      `the top bracket (starting at ${last.bracketMin}) must be open-ended (bracketMax = null)`,
    );
  }

  return errors;
}
