import { describe, it, expect } from 'vitest';
import { sumMoney, moneyEquals, isZeroMoney } from './money';

/**
 * F07 finance's one non-negotiable invariant is "debits equal credits" —
 * these helpers are what the manual-journal-entry form and the trial-
 * balance/balance-sheet reconciliation checks lean on to prove that without
 * ever routing a `Money` decimal string through `parseFloat`/`Number()`
 * (CONTRACTS §0). Covers the classic float trap (0.1 + 0.2) and negative/
 * blank inputs the UI can actually produce.
 */
describe('sumMoney', () => {
  it('sums plain decimal strings without float drift', () => {
    expect(sumMoney(['100000.00', '50000.00'])).toBe('150000.00');
  });

  it('avoids the classic float trap (0.10 + 0.20)', () => {
    expect(sumMoney(['0.10', '0.20'])).toBe('0.30');
  });

  it('treats null/undefined/blank entries as zero', () => {
    expect(sumMoney(['100.00', null, undefined, ''])).toBe('100.00');
  });

  it('handles negative amounts (e.g. a reversed line)', () => {
    expect(sumMoney(['100.00', '-40.00'])).toBe('60.00');
  });

  it('sums an empty list to zero', () => {
    expect(sumMoney([])).toBe('0.00');
  });

  it('handles large ledger totals without precision loss', () => {
    expect(sumMoney(['999999999999.99', '0.01'])).toBe('1000000000000.00');
  });
});

describe('moneyEquals', () => {
  it('treats differently-formatted equal amounts as equal', () => {
    expect(moneyEquals('0.00', '0')).toBe(true);
    expect(moneyEquals('125000.00', '125000')).toBe(true);
  });

  it('flags an unbalanced pair as unequal', () => {
    expect(moneyEquals('100.00', '100.01')).toBe(false);
  });
});

describe('isZeroMoney', () => {
  it('recognizes zero in any decimal-string shape', () => {
    expect(isZeroMoney('0.00')).toBe(true);
    expect(isZeroMoney(null)).toBe(true);
  });

  it('recognizes a non-zero amount', () => {
    expect(isZeroMoney('0.01')).toBe(false);
  });
});
