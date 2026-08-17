import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { parseFixed, formatFixed, addFixed, subFixed, rescale } from './fixed-point';

/** Arbitrary decimal strings at a given scale, canonical (no leading zeros beyond '0', no trailing junk). */
function decimalStringArb(scale: number, maxDigits = 12) {
  return fc
    .tuple(fc.boolean(), fc.bigInt({ min: 0n, max: 10n ** BigInt(maxDigits) }))
    .map(([negative, magnitude]) => {
      const scaled = negative && magnitude !== 0n ? -magnitude : magnitude;
      return formatFixed(scaled, scale);
    });
}

describe('property: wire round-trip', () => {
  it('parse(format(x)) === x for any scaled integer, for every field scale', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(0, 1, 2, 3, 4),
        fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n }),
        (scale, scaled) => {
          const wire = formatFixed(scaled, scale);
          expect(parseFixed(wire, scale)).toBe(scaled);
        },
      ),
    );
  });

  it('format(parse(s)) === s for any canonical decimal string', () => {
    fc.assert(
      fc.property(decimalStringArb(2), (s) => {
        expect(formatFixed(parseFixed(s, 2), 2)).toBe(s);
      }),
    );
    fc.assert(
      fc.property(decimalStringArb(3), (s) => {
        expect(formatFixed(parseFixed(s, 3), 3)).toBe(s);
      }),
    );
  });
});

describe('property: arithmetic laws (money scale, no float drift)', () => {
  const money = () => fc.bigInt({ min: -(10n ** 12n), max: 10n ** 12n });

  it('addition is commutative', () => {
    fc.assert(
      fc.property(money(), money(), (a, b) => {
        expect(addFixed(a, b)).toBe(addFixed(b, a));
      }),
    );
  });

  it('addition is associative', () => {
    fc.assert(
      fc.property(money(), money(), money(), (a, b, c) => {
        expect(addFixed(addFixed(a, b), c)).toBe(addFixed(a, addFixed(b, c)));
      }),
    );
  });

  it('a + b - b === a (no drift across many operations)', () => {
    fc.assert(
      fc.property(fc.array(money(), { minLength: 0, maxLength: 200 }), (values) => {
        let acc = 0n;
        for (const v of values) acc = addFixed(acc, v);
        for (const v of values) acc = subFixed(acc, v);
        expect(acc).toBe(0n);
      }),
    );
  });

  it('summing in any order gives the same total (order-insensitive, unlike float sums)', () => {
    fc.assert(
      fc.property(fc.array(money(), { minLength: 0, maxLength: 50 }), (values) => {
        const forward = values.reduce(addFixed, 0n);
        const shuffled = [...values].reverse();
        const backward = shuffled.reduce(addFixed, 0n);
        expect(forward).toBe(backward);
      }),
    );
  });
});

describe('property: rescale is idempotent once at the target scale', () => {
  it('rescaling twice to the same target scale is a no-op the second time', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 12n), max: 10n ** 12n }),
        fc.constantFrom(0, 1, 2, 3, 4),
        fc.constantFrom(0, 1, 2, 3, 4),
        (value, fromScale, toScale) => {
          const once = rescale(value, fromScale, toScale, 'half_up');
          const twice = rescale(once, toScale, toScale, 'half_up');
          expect(twice).toBe(once);
        },
      ),
    );
  });
});
