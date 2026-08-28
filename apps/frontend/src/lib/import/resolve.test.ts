import { describe, expect, it } from 'vitest';
import {
  buildItemIndex,
  buildNameIndex,
  resolveEnum,
  resolveItem,
  resolveNamed,
} from './resolve';

const ITEMS = [
  { id: 'i1', sku: 'AY-001', name: 'Ayam Paha Atas' },
  { id: 'i2', sku: 'AY-002', name: 'Ayam Paha Bawah' },
  { id: 'i3', sku: 'BR-001', name: 'Beras Premium' },
];

describe('resolveItem', () => {
  const index = buildItemIndex(ITEMS);

  it('matches by SKU', () => {
    expect(resolveItem(index, { sku: 'AY-002' })?.id).toBe('i2');
  });

  it('matches by name when no SKU column was filled in', () => {
    expect(resolveItem(index, { name: 'Beras Premium' })?.id).toBe('i3');
  });

  it('ignores case and stray whitespace', () => {
    expect(resolveItem(index, { sku: ' ay-001 ' })?.id).toBe('i1');
    expect(resolveItem(index, { name: 'ayam   paha   atas' })?.id).toBe('i1');
  });

  it('never falls back to the name when a SKU was given and missed', () => {
    // The two columns disagreeing is exactly when a fallback picks the wrong
    // item, so a filled-in-but-unknown SKU is a miss the operator must see.
    expect(resolveItem(index, { sku: 'NOPE', name: 'Beras Premium' })).toBeNull();
  });

  it('refuses to guess between two items with the same name', () => {
    const ambiguous = buildItemIndex([
      { id: 'a', sku: 'A-1', name: 'Ayam Utuh' },
      { id: 'b', sku: 'B-1', name: 'Ayam Utuh' },
    ]);
    expect(resolveItem(ambiguous, { name: 'Ayam Utuh' })).toBeNull();
    // ...but the SKU still disambiguates it.
    expect(resolveItem(ambiguous, { sku: 'B-1' })?.id).toBe('b');
  });

  it('does not near-match a similar name', () => {
    expect(resolveItem(index, { name: 'Ayam Paha' })).toBeNull();
  });

  it('is null for an empty row', () => {
    expect(resolveItem(index, {})).toBeNull();
    expect(resolveItem(index, { sku: '', name: '  ' })).toBeNull();
  });
});

describe('resolveNamed', () => {
  const index = buildNameIndex([
    { id: 'a1', name: 'Chiller' },
    { id: 'a2', name: 'Freezer Utama' },
  ]);

  it('matches, case- and whitespace-insensitively', () => {
    expect(resolveNamed(index, 'chiller')?.id).toBe('a1');
    expect(resolveNamed(index, ' Freezer  Utama ')?.id).toBe('a2');
  });

  it('is null for an unknown or blank name', () => {
    expect(resolveNamed(index, 'Dry Store')).toBeNull();
    expect(resolveNamed(index, '')).toBeNull();
  });

  it('refuses to guess between duplicates', () => {
    const dupes = buildNameIndex([
      { id: 'x', name: 'Chiller' },
      { id: 'y', name: 'Chiller' },
    ]);
    expect(resolveNamed(dupes, 'Chiller')).toBeNull();
  });
});

describe('resolveEnum', () => {
  const REASONS = ['expired', 'damaged', 'other'] as const;
  const LABELS: Record<(typeof REASONS)[number], string> = {
    expired: 'Kedaluwarsa',
    damaged: 'Rusak',
    other: 'Lainnya',
  };
  const labelOf = (value: (typeof REASONS)[number]) => LABELS[value];

  it('accepts the wire value', () => {
    expect(resolveEnum('expired', REASONS, labelOf)).toBe('expired');
  });

  it('accepts the Indonesian label the export writes', () => {
    // The round trip depends on this: an export shows "Kedaluwarsa", so the
    // import cannot demand `expired` back.
    expect(resolveEnum('Kedaluwarsa', REASONS, labelOf)).toBe('expired');
    expect(resolveEnum('  rusak ', REASONS, labelOf)).toBe('damaged');
  });

  it('is null for an unrecognised or blank value', () => {
    expect(resolveEnum('busuk', REASONS, labelOf)).toBeNull();
    expect(resolveEnum('', REASONS, labelOf)).toBeNull();
  });
});
