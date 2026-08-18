import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { formatMoney, addMoney } from '../money';
import { validateJournalEntry, isBalanced, type JournalEntryInput } from './validator';
import { splitMoneyEvenly, sumMoney } from '../money';

const cents = fc.bigInt({ min: 1n, max: 10n ** 10n });

/** Builds a random balanced entry: one debit line for the total, N credit lines splitting it evenly. */
function balancedEntryArb() {
  return fc
    .tuple(cents, fc.integer({ min: 1, max: 8 }))
    .map(([amountCents, splits]): JournalEntryInput => {
      const total = formatMoney(amountCents);
      // A split can produce a zero-value share (e.g. "0.01" split 2 ways -> ["0.01", "0.00"]); a zero
      // line has neither side set and is not a valid journal line (validateJournalEntry rejects it), so
      // it is filtered out here rather than fed to the validator as one of the entry's lines.
      const nonZeroShares = splitMoneyEvenly(total, splits).filter((share) => share !== '0.00');
      return {
        lines: [
          { accountCode: '1100', debit: total, credit: '0.00' },
          ...nonZeroShares.map((share, i) => ({
            accountCode: `20${i}0`,
            debit: '0.00',
            credit: share,
          })),
        ],
      };
    });
}

describe('property: every generated (constructed-balanced) journal entry validates as balanced', () => {
  it('validateJournalEntry always accepts entries built to balance by construction', () => {
    fc.assert(
      fc.property(balancedEntryArb(), (entry) => {
        expect(isBalanced(entry)).toBe(true);
        const result = validateJournalEntry(entry);
        expect(result.ok).toBe(true);
      }),
    );
  });

  it('Σdebit === Σcredit exactly for every generated entry (no rounding leak from the split)', () => {
    fc.assert(
      fc.property(balancedEntryArb(), (entry) => {
        const debitLines = entry.lines.filter((l) => l.debit !== '0.00').map((l) => l.debit);
        const creditLines = entry.lines.filter((l) => l.credit !== '0.00').map((l) => l.credit);
        expect(sumMoney(debitLines)).toBe(sumMoney(creditLines));
      }),
    );
  });
});

describe('property: perturbing a balanced entry by one cent always fails validation', () => {
  it('adding one cent to a single credit line breaks the balance', () => {
    fc.assert(
      fc.property(balancedEntryArb(), (entry) => {
        const lastIndex = entry.lines.length - 1;
        const perturbed: JournalEntryInput = {
          lines: entry.lines.map((l, i) =>
            i === lastIndex ? { ...l, credit: addMoney(l.credit, '0.01') } : l,
          ),
        };
        expect(isBalanced(perturbed)).toBe(false);
        expect(validateJournalEntry(perturbed).ok).toBe(false);
      }),
    );
  });
});
