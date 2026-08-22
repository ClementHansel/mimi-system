import { describe, expect, it } from 'vitest';
import { explodeRecipeLineQty, explodeRecipeLines, recipeScaleRatio } from './explosion';

/**
 * D-27 — the shared recipe-explosion formula.
 *
 * The property worth protecting is the one that was ALREADY BROKEN once: the
 * yield division. `modules/pos` omitted it, so every batch recipe mis-posted
 * stock on every sale, and it stayed invisible for waves because all 39 seeded
 * recipes yield 1 — where the division is a no-op (D-28). Every test below that
 * uses a yield other than 1 exists specifically because the seed cannot catch
 * this class of bug.
 */
describe('recipe explosion', () => {
  it('yield 1 is the identity case — the one the seed exercises, and the one that hides bugs', () => {
    expect(explodeRecipeLineQty('2.000', '3.000', '1.000')).toBe('6.000');
  });

  it('DIVIDES by yield — a batch of 10 consumes a tenth per unit sold', () => {
    // The regression that shipped: without the division this returns '5.000',
    // ten times the real consumption, on every sale of a batch recipe.
    expect(explodeRecipeLineQty('5.000', '1.000', '10.000')).toBe('0.500');
    expect(explodeRecipeLineQty('5.000', '10.000', '10.000')).toBe('5.000');
  });

  it('selling exactly one yield returns exactly the stored line quantity', () => {
    expect(explodeRecipeLineQty('1.250', '4.000', '4.000')).toBe('1.250');
  });

  it('carries a non-terminating ratio at 6 places, not at Qty scale', () => {
    // 1/3 at Qty scale (0.333) would drift; the ratio keeps 0.333333.
    expect(recipeScaleRatio('1.000', '3.000')).toBe('0.333333');
    // 3 kg per batch of 3 → 1 kg per unit, which only comes out exact because
    // the ratio kept its extra places.
    expect(explodeRecipeLineQty('3.000', '1.000', '3.000')).toBe('1.000');
  });

  it('a sale of zero consumes nothing, and still returns one line per recipe line', () => {
    const out = explodeRecipeLines([{ qty: '2.000' }, { qty: '0.500' }], '0.000', '1.000');
    expect(out.map((o) => o.qty)).toEqual(['0.000', '0.000']);
    // Shape matters: an empty array here would make every caller special-case
    // the zero sale instead of just multiplying by nothing.
    expect(out).toHaveLength(2);
  });

  it('THE SCALE TRAP — the ratio is not a Qty, and Qty helpers reject it', () => {
    const ratio = recipeScaleRatio('1.000', '3.000');
    expect(ratio.split('.')[1]).toHaveLength(6);
    // This is the mistake that broke four property tests when this module was
    // first written: `isZeroQty(ratio)` throws rather than returning false,
    // because `Qty` parsing is fixed at 3 places. Pinned so the next person to
    // "tidy up" the zero check finds out here instead of in the POS suite.
    expect(() => explodeRecipeLines([{ qty: ratio }], '1.000', '1.000')).toThrow(
      /fractional digits/,
    );
  });

  it('preserves the item set and order, so callers can zip results back to lines', () => {
    const lines = [
      { qty: '1.000', itemId: 'a' },
      { qty: '2.000', itemId: 'b' },
      { qty: '3.000', itemId: 'c' },
    ];
    const out = explodeRecipeLines(lines, '2.000', '1.000');
    expect(out.map((o) => o.line.itemId)).toEqual(['a', 'b', 'c']);
    expect(out.map((o) => o.qty)).toEqual(['2.000', '4.000', '6.000']);
  });

  it('scales linearly — twice the sale consumes twice the ingredient', () => {
    const once = explodeRecipeLineQty('1.500', '4.000', '7.000');
    const twice = explodeRecipeLineQty('1.500', '8.000', '7.000');
    // Within one Qty unit of rounding; exact linearity is not available at a
    // fixed scale and claiming it would be the wrong assertion.
    const diff = Math.abs(Number(twice) - 2 * Number(once));
    expect(diff).toBeLessThanOrEqual(0.001);
  });
});
