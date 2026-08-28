/**
 * `sumDecimals` exists because Qty and Money are decimal STRINGS end-to-end
 * (CONTRACTS §0). The whole point is that a total in an export must equal the
 * total on screen exactly — so these cases are the ones a float would get
 * wrong, plus the null handling that decides whether "not approved yet" reads
 * as blank or as zero.
 */
import { describe, it, expect } from 'vitest';
import {
  sumDecimals,
  BALANCE_EXPORT_COLUMNS,
  WASTE_EXPORT_COLUMNS,
  PETTY_CASH_EXPORT_COLUMNS,
} from './outlet-export-columns';
import { toCsv } from '@/lib/export/csv';
import type { Balance } from './types';

describe('sumDecimals', () => {
  it('is exact where a float is not', () => {
    // 0.1 + 0.2 === 0.30000000000000004 in IEEE-754.
    expect(sumDecimals(['0.1', '0.2'])).toBe('0.3');
    expect(sumDecimals(['0.07', '0.07', '0.07'])).toBe('0.21');
    // A day of petty cash in rupiah — well past 2^53 if scaled naively.
    expect(sumDecimals(['9007199254740993.01', '0.02'])).toBe('9007199254740993.03');
  });

  it('carries across the decimal point', () => {
    expect(sumDecimals(['0.9', '0.1'])).toBe('1.0');
    expect(sumDecimals(['99.99', '0.01'])).toBe('100.00');
  });

  it('aligns mixed scales on the widest one', () => {
    expect(sumDecimals(['1', '2.5'])).toBe('3.5');
    expect(sumDecimals(['1.5', '2.250'])).toBe('3.750');
    expect(sumDecimals(['10', '20'])).toBe('30');
  });

  it('handles negatives, including a negative total', () => {
    // Opname variance is signed: a short count is negative.
    expect(sumDecimals(['-1.50', '0.25'])).toBe('-1.25');
    expect(sumDecimals(['1.00', '-3.50'])).toBe('-2.50');
    expect(sumDecimals(['-0.5', '0.5'])).toBe('0.0');
  });

  it('skips nulls rather than reading them as zero', () => {
    // A request line with no approved qty yet must not make the column say the
    // request was approved for nothing.
    expect(sumDecimals([null, undefined, ''])).toBe('');
    expect(sumDecimals(['2.5', null])).toBe('2.5');
    expect(sumDecimals([])).toBe('');
  });
});

describe('outlet export columns', () => {
  it('renders money and qty verbatim — no Rp, no thousands separator', () => {
    const rows: Balance[] = [
      {
        locationId: 'l1',
        storageAreaId: 'a1',
        storageAreaName: 'Freezer 1',
        storageAreaType: 'frozen',
        itemId: 'i1',
        sku: 'AYM-001',
        itemName: 'Ayam Utuh',
        unitCode: 'kg',
        qtyOnHand: '1250.500',
        minQty: '100.000',
        belowMin: false,
        value: '18750000.00',
      },
    ];
    const csv = toCsv(rows, BALANCE_EXPORT_COLUMNS);
    expect(csv).toContain('1250.500');
    expect(csv).toContain('18750000.00');
    expect(csv).not.toContain('Rp');
    expect(csv).not.toContain('18.750.000');
  });

  it('writes the below-minimum flag the screen shows as a badge', () => {
    const base: Balance = {
      locationId: 'l1',
      storageAreaId: 'a1',
      storageAreaName: 'Chiller',
      storageAreaType: 'chilled',
      itemId: 'i1',
      sku: 'S1',
      itemName: 'Sayur',
      unitCode: 'kg',
      qtyOnHand: '1.000',
      minQty: '5.000',
      belowMin: true,
    };
    const csv = toCsv([base, { ...base, belowMin: false }], BALANCE_EXPORT_COLUMNS);
    const [, low, ok] = csv.split('\r\n');
    expect(low).toContain('ya');
    expect(ok).toContain('tidak');
  });

  it('never emits the literal "null" for an absent optional', () => {
    const row: Balance = {
      locationId: 'l1',
      storageAreaId: 'a1',
      storageAreaName: 'Dry',
      storageAreaType: 'dry',
      itemId: 'i1',
      sku: 'S1',
      itemName: 'Beras',
      unitCode: 'kg',
      qtyOnHand: '10',
      minQty: null,
      belowMin: false,
      // `value` omitted — the API only includes it for callers with cost access.
    };
    const csv = toCsv([row], BALANCE_EXPORT_COLUMNS);
    expect(csv).not.toContain('null');
    expect(csv).not.toContain('undefined');
  });

  it('gives every column a distinct header', () => {
    // Several columns share `key: 'lines'` and differ only by `format`, so a
    // copy-paste slip would silently produce two identically-named columns.
    for (const columns of [
      BALANCE_EXPORT_COLUMNS,
      WASTE_EXPORT_COLUMNS,
      PETTY_CASH_EXPORT_COLUMNS,
    ]) {
      const headers = columns.map((c) => c.header);
      expect(new Set(headers).size).toBe(headers.length);
    }
  });
});
