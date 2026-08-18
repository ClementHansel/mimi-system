import { describe, expect, it } from 'vitest';
import {
  groupByEffectiveFrom,
  isEffectiveAt,
  sortByEffectiveFromDesc,
  validateNewEffectiveFrom,
  windowState,
} from './effective-window';

const row = (effectiveFrom: string, effectiveTo: string | null) => ({ effectiveFrom, effectiveTo });

describe('isEffectiveAt', () => {
  it('is true when asOf falls inside a closed window', () => {
    expect(isEffectiveAt(row('2025-01-01', '2025-12-31'), '2025-06-15')).toBe(true);
  });
  it('is true at both inclusive boundaries', () => {
    expect(isEffectiveAt(row('2025-01-01', '2025-12-31'), '2025-01-01')).toBe(true);
    expect(isEffectiveAt(row('2025-01-01', '2025-12-31'), '2025-12-31')).toBe(true);
  });
  it('is true for an open-ended window at any date on/after effectiveFrom', () => {
    expect(isEffectiveAt(row('2025-01-01', null), '2099-01-01')).toBe(true);
  });
  it('is false before effectiveFrom or after effectiveTo', () => {
    expect(isEffectiveAt(row('2025-01-01', '2025-12-31'), '2024-12-31')).toBe(false);
    expect(isEffectiveAt(row('2025-01-01', '2025-12-31'), '2026-01-01')).toBe(false);
  });
});

describe('windowState', () => {
  it('classifies a currently-active window', () => {
    expect(windowState(row('2025-01-01', null), '2025-06-01')).toBe('active');
  });
  it('classifies a not-yet-started window as future', () => {
    expect(windowState(row('2026-01-01', null), '2025-06-01')).toBe('future');
  });
  it('classifies a closed, elapsed window as past', () => {
    expect(windowState(row('2024-01-01', '2024-12-31'), '2025-06-01')).toBe('past');
  });
});

describe('sortByEffectiveFromDesc', () => {
  it('orders newest-first regardless of input order', () => {
    const rows = [
      row('2024-01-01', '2024-12-31'),
      row('2026-01-01', null),
      row('2025-01-01', '2025-12-31'),
    ];
    expect(sortByEffectiveFromDesc(rows).map((r) => r.effectiveFrom)).toEqual([
      '2026-01-01',
      '2025-01-01',
      '2024-01-01',
    ]);
  });
});

describe('groupByEffectiveFrom', () => {
  it('groups multiple rows sharing one vintage (e.g. a TER bracket set)', () => {
    const rows = [
      { ...row('2025-01-01', null), category: 'A' },
      { ...row('2025-01-01', null), category: 'B' },
      { ...row('2024-01-01', '2024-12-31'), category: 'A' },
    ];
    const grouped = groupByEffectiveFrom(rows);
    expect(grouped.size).toBe(2);
    expect(grouped.get('2025-01-01')?.length).toBe(2);
    expect(grouped.get('2024-01-01')?.length).toBe(1);
  });
});

describe('validateNewEffectiveFrom', () => {
  const existing = [row('2024-01-01', '2024-12-31'), row('2025-01-01', null)];

  it('rejects a duplicate effectiveFrom date', () => {
    expect(validateNewEffectiveFrom(existing, '2025-01-01')).toBe('duplicate');
  });
  it('rejects a date before the latest existing vintage (silent backdating)', () => {
    expect(validateNewEffectiveFrom(existing, '2024-06-01')).toBe('beforeLatest');
  });
  it('accepts a date after the latest existing vintage', () => {
    expect(validateNewEffectiveFrom(existing, '2026-01-01')).toBeNull();
  });
  it('accepts any date when there are no existing rows', () => {
    expect(validateNewEffectiveFrom([], '2020-01-01')).toBeNull();
  });
});
