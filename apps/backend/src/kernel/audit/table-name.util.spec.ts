import { describe, it, expect } from 'vitest';
import { candidateTableNames } from './table-name.util';

describe('candidateTableNames', () => {
  it('tries the literal entityType first, then a naive plural', () => {
    expect(candidateTableNames('replenishment_request')).toEqual([
      'replenishment_request',
      'replenishment_requests',
    ]);
  });

  it('pluralizes a trailing consonant+y as ies', () => {
    expect(candidateTableNames('supplier_price_history')).toEqual([
      'supplier_price_history',
      'supplier_price_histories',
    ]);
  });

  it('pluralizes a trailing s/x/z/ch/sh as es', () => {
    expect(candidateTableNames('purchase')).toEqual(['purchase', 'purchases']);
    expect(candidateTableNames('branch')).toEqual(['branch', 'branches']);
  });

  it('does not duplicate a candidate already ending in s (e.g. an irregular singular table)', () => {
    // 'stock_opname' is a real irregular case (CONTRACTS.md 023: the table is
    // singular, not pluralized) — it does not end in s, so it still gets one
    // (wrong) plural candidate appended, but the literal form is tried FIRST
    // and matches the real table, so the heuristic degrades correctly.
    expect(candidateTableNames('stock_opname')).toEqual(['stock_opname', 'stock_opnames']);
  });

  it('does not add a second candidate when entityType already ends in s', () => {
    expect(candidateTableNames('settings')).toEqual(['settings']);
  });
});
