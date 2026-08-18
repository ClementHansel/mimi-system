import { describe, it, expect } from 'vitest';
import { isBalanced, validateJournalEntry, totalDebit, totalCredit } from './validator';

describe('isBalanced', () => {
  it('is true for a simple balanced entry', () => {
    expect(
      isBalanced({
        lines: [
          { accountCode: '1100', debit: '500000.00', credit: '0.00' },
          { accountCode: '2000', debit: '0.00', credit: '500000.00' },
        ],
      }),
    ).toBe(true);
  });

  it('is false when debits and credits differ', () => {
    expect(
      isBalanced({
        lines: [
          { accountCode: '1100', debit: '500000.00', credit: '0.00' },
          { accountCode: '2000', debit: '0.00', credit: '499999.99' },
        ],
      }),
    ).toBe(false);
  });

  it('sums multi-line entries correctly (JOUT-03 style: split across payment methods)', () => {
    const entry = {
      lines: [
        { accountCode: '1000', debit: '100000.00', credit: '0.00' },
        { accountCode: '1031', debit: '250000.00', credit: '0.00' },
        { accountCode: '4000', debit: '0.00', credit: '350000.00' },
      ],
    };
    expect(isBalanced(entry)).toBe(true);
    expect(totalDebit(entry)).toBe('350000.00');
    expect(totalCredit(entry)).toBe('350000.00');
  });
});

describe('validateJournalEntry', () => {
  it('accepts a well-formed balanced entry', () => {
    const result = validateJournalEntry({
      lines: [
        { accountCode: '1100', debit: '500000.00', credit: '0.00' },
        { accountCode: '2000', debit: '0.00', credit: '500000.00' },
      ],
    });
    expect(result).toMatchObject({ ok: true, totalDebit: '500000.00', totalCredit: '500000.00' });
  });

  it('rejects an unbalanced entry with ERR_UNBALANCED_ENTRY', () => {
    const result = validateJournalEntry({
      lines: [
        { accountCode: '1100', debit: '500000.00', credit: '0.00' },
        { accountCode: '2000', debit: '0.00', credit: '499999.99' },
      ],
    });
    expect(result).toMatchObject({ ok: false, code: 'ERR_UNBALANCED_ENTRY' });
  });

  it('rejects a line with both debit and credit set', () => {
    const result = validateJournalEntry({
      lines: [
        { accountCode: '1100', debit: '100.00', credit: '100.00' },
        { accountCode: '2000', debit: '0.00', credit: '0.00' },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a line with neither debit nor credit set', () => {
    const result = validateJournalEntry({
      lines: [
        { accountCode: '1100', debit: '100.00', credit: '0.00' },
        { accountCode: '2000', debit: '0.00', credit: '0.00' },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a negative amount', () => {
    const result = validateJournalEntry({
      lines: [
        { accountCode: '1100', debit: '-100.00', credit: '0.00' },
        { accountCode: '2000', debit: '0.00', credit: '100.00' },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it('rejects fewer than two lines', () => {
    const result = validateJournalEntry({
      lines: [{ accountCode: '1100', debit: '100.00', credit: '0.00' }],
    });
    expect(result.ok).toBe(false);
  });

  it('rejects an all-zero entry', () => {
    const result = validateJournalEntry({
      lines: [
        { accountCode: '1100', debit: '0.00', credit: '0.00' },
        { accountCode: '2000', debit: '0.00', credit: '0.00' },
      ],
    });
    expect(result.ok).toBe(false);
  });
});
