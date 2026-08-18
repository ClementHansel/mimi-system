import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  computeAreaBalanceChecksums,
  computeStateChecksum,
  fnv1a64Hex,
  combineChecksums,
  canonicalRowString,
} from './checksum';

describe('fnv1a64Hex', () => {
  it('is deterministic', () => {
    expect(fnv1a64Hex('hello')).toBe(fnv1a64Hex('hello'));
  });

  it('differs for different inputs (no trivial collisions on short strings)', () => {
    expect(fnv1a64Hex('hello')).not.toBe(fnv1a64Hex('world'));
  });

  it('always returns a 16-hex-char string', () => {
    expect(fnv1a64Hex('')).toHaveLength(16);
    expect(fnv1a64Hex('x'.repeat(1000))).toHaveLength(16);
  });
});

describe('combineChecksums / computeStateChecksum — order independence', () => {
  it('combining the same set of hashes in any order gives the same result', () => {
    const hashes = [fnv1a64Hex('a'), fnv1a64Hex('b'), fnv1a64Hex('c')];
    expect(combineChecksums(hashes)).toBe(combineChecksums([...hashes].reverse()));
  });

  it('computeStateChecksum is order-independent over a list of rows', () => {
    const rows = [
      { id: '1', qty: '10.000' },
      { id: '2', qty: '5.000' },
      { id: '3', qty: '0.000' },
    ];
    expect(computeStateChecksum(rows)).toBe(computeStateChecksum([...rows].reverse()));
  });

  it('is independent of key order WITHIN a row too', () => {
    const a = computeStateChecksum([{ id: '1', qty: '10.000' }]);
    const b = computeStateChecksum([{ qty: '10.000', id: '1' }]);
    expect(a).toBe(b);
  });

  it('changes when the data actually changes', () => {
    const before = computeStateChecksum([{ id: '1', qty: '10.000' }]);
    const after = computeStateChecksum([{ id: '1', qty: '10.001' }]);
    expect(before).not.toBe(after);
  });

  it('property: shuffled row order never changes the checksum', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ id: fc.string(), qty: fc.string() }), { minLength: 0, maxLength: 30 }),
        (rows) => {
          const shuffled = [...rows].reverse();
          expect(computeStateChecksum(rows)).toBe(computeStateChecksum(shuffled));
        },
      ),
    );
  });
});

describe('canonicalRowString / computeStateChecksum — must survive a bigint field (e.g. a client_seq folded into a canary row)', () => {
  it('does not throw when a row contains a bigint value', () => {
    expect(() => canonicalRowString({ id: '1', clientSeq: 42n })).not.toThrow();
    expect(() => computeStateChecksum([{ id: '1', clientSeq: 42n }])).not.toThrow();
  });

  it('does not throw for a bigint beyond Number.MAX_SAFE_INTEGER', () => {
    expect(() =>
      computeStateChecksum([{ id: '1', clientSeq: 9_007_199_254_740_993n }]),
    ).not.toThrow();
  });

  it('two rows differing only in a bigint field produce different checksums (the field is not silently dropped)', () => {
    const a = computeStateChecksum([{ id: '1', clientSeq: 1n }]);
    const b = computeStateChecksum([{ id: '1', clientSeq: 2n }]);
    expect(a).not.toBe(b);
  });

  it('stays order-independent (both by row order and by key order) even with a bigint field present', () => {
    const rows = [
      { id: '1', clientSeq: 5n },
      { id: '2', clientSeq: 9_007_199_254_740_993n },
    ];
    expect(computeStateChecksum(rows)).toBe(computeStateChecksum([...rows].reverse()));

    const forward = canonicalRowString({ id: '1', clientSeq: 5n });
    const backward = canonicalRowString({ clientSeq: 5n, id: '1' });
    expect(forward).toBe(backward);
  });
});

describe('computeAreaBalanceChecksums', () => {
  it('groups by storage area and produces one checksum per area', () => {
    const rows = [
      { storageAreaId: 'area-1', itemId: 'i1', qtyOnHand: '10.000' },
      { storageAreaId: 'area-1', itemId: 'i2', qtyOnHand: '5.000' },
      { storageAreaId: 'area-2', itemId: 'i1', qtyOnHand: '3.000' },
    ];
    const result = computeAreaBalanceChecksums(rows);
    expect(Object.keys(result).sort()).toEqual(['area-1', 'area-2']);
    expect(result['area-1']).not.toBe(result['area-2']);
  });

  it("a divergence in one area does not change the other area's checksum", () => {
    const base = [
      { storageAreaId: 'area-1', itemId: 'i1', qtyOnHand: '10.000' },
      { storageAreaId: 'area-2', itemId: 'i1', qtyOnHand: '3.000' },
    ];
    const changed = [
      { storageAreaId: 'area-1', itemId: 'i1', qtyOnHand: '11.000' }, // diverges
      { storageAreaId: 'area-2', itemId: 'i1', qtyOnHand: '3.000' },
    ];
    const before = computeAreaBalanceChecksums(base);
    const after = computeAreaBalanceChecksums(changed);
    expect(after['area-2']).toBe(before['area-2']);
    expect(after['area-1']).not.toBe(before['area-1']);
  });
});
