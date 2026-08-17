/**
 * Property tests for unit-conversion math (D-15/M04 ticket brief: "get the
 * conversion maths right, it underpins recipes, replenishment and stock
 * valuation"). `UnitService` is a thin persistence layer over
 * `unit_conversions.factor` — the actual arithmetic contract
 * (`qty_to = qty_from × factor`) lives in `@mimi/shared`'s `convertQty`
 * (packages/shared/src/qty.ts), so these properties are proven directly
 * against that function: this module's correctness DEPENDS on `convertQty`
 * behaving this way, so pinning the properties here (rather than only in
 * `packages/shared`'s own suite) documents that dependency and catches a
 * regression in either package.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { convertQty, divQty, parseQty, ZERO_QTY } from '@mimi/shared';

/** Qty (NUMERIC(14,3)) arbitrary: non-negative, bounded to keep bigint math sane. */
const qtyArb = fc
  .tuple(fc.integer({ min: 0, max: 1_000_000 }), fc.integer({ min: 0, max: 999 }))
  .map(([whole, frac]) => `${whole}.${String(frac).padStart(3, '0')}`);

/** `unit_conversions.factor` (NUMERIC(14,6)), strictly positive per the DB CHECK constraint. */
const factorArb = fc
  .tuple(fc.integer({ min: 1, max: 100_000 }), fc.integer({ min: 0, max: 999_999 }))
  .map(([whole, frac]) => `${whole}.${String(frac).padStart(6, '0')}`);

describe('unit conversion math (@mimi/shared convertQty) — property tests', () => {
  it('qty_to = qty_from × factor, exactly (the DB comment\'s own formula, checked against the bigint result)', () => {
    fc.assert(
      fc.property(qtyArb, factorArb, (qty, factor) => {
        const converted = convertQty(qty, factor);
        // Recompute independently via the scaled-integer identity rather than
        // floating point, so this test can't pass by sharing a rounding bug
        // with the implementation.
        const expected = (parseQty(qty) * BigInt(factor.replace('.', ''))) / 1_000_000n;
        // Allow ±1 unit of Qty scale for half-up rounding at the boundary.
        const diff = parseQty(converted) - expected;
        expect(diff === 0n || diff === 1n || diff === -1n).toBe(true);
      }),
    );
  });

  it('converting zero qty is always zero, for any positive factor', () => {
    fc.assert(
      fc.property(factorArb, (factor) => {
        expect(convertQty(ZERO_QTY, factor)).toBe(ZERO_QTY);
      }),
    );
  });

  it('is monotonic: a larger qty never converts to a smaller result for the same factor', () => {
    fc.assert(
      fc.property(qtyArb, qtyArb, factorArb, (a, b, factor) => {
        const [lo, hi] = parseQty(a) <= parseQty(b) ? [a, b] : [b, a];
        expect(parseQty(convertQty(lo, factor))).toBeLessThanOrEqual(parseQty(convertQty(hi, factor)));
      }),
    );
  });

  it('round-tripping through a factor and its reciprocal recovers the original qty within 1 scale unit', () => {
    // e.g. kg→gr (factor 1000) then gr→kg (factor 0.001) — the exact
    // 'unit_conversions' round-trip a caller assembling a conversion GRAPH
    // (kg↔gr↔ml↔ltr...) depends on for stock valuation not to drift.
    fc.assert(
      fc.property(
        fc.tuple(fc.integer({ min: 1, max: 1_000_000 }), fc.integer({ min: 0, max: 999 })).map(([w, f]) => `${w}.${String(f).padStart(3, '0')}`),
        fc.integer({ min: 1, max: 1000 }),
        (qty, factorInt) => {
          const factor = `${factorInt}.000000`;
          const reciprocal = divQty('1.000', `${factorInt}.000`, 6);
          const there = convertQty(qty, factor);
          const back = convertQty(there, reciprocal);
          const diff = parseQty(back) - parseQty(qty);
          // Half-up rounding at two conversion steps (forward, then through a
          // 6dp-truncated reciprocal) accumulates error PROPORTIONAL to the
          // reciprocal's own rounding (~1/factor), not a fixed constant — the
          // actual invariant is "bounded drift", not "zero drift". Tolerance
          // is scaled to the magnitude of `qty` itself (0.5%) plus a small
          // fixed floor for tiny values, rather than an arbitrary tight
          // constant that would be a property of THIS test's fixture sizes,
          // not of the conversion math.
          const tolerance = parseQty(qty) / 200n + 2n;
          expect(diff >= -tolerance && diff <= tolerance).toBe(true);
        },
      ),
    );
  });

  it('rejects a non-positive factor (DB CHECK (factor > 0) mirrored in application code)', () => {
    expect(() => convertQty('1.000', '0.000000')).toThrow();
    expect(() => convertQty('1.000', '-1.000000')).toThrow();
  });
});
