/**
 * Property tests for recipe explosion (FR-POS-06 — "converts sold products
 * into ingredient consumption"). `RecipeService.explodeForSale` is a pure
 * function of an already-loaded `Recipe`, so these run entirely in-memory —
 * no DB needed to prove the scaling math is correct, which is exactly the
 * property a future POS sale-posting flow (W3-08/M13) depends on: get this
 * wrong and outlet stock tracking is wrong everywhere, and it will look like
 * a stock bug rather than a recipe bug (per the ticket brief).
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { addQty, compareQty, isZeroQty, parseQty, ZERO_QTY, type Qty } from '@mimi/shared';
import { RecipeService, type Recipe, type RecipeLine } from './recipe.service';

const qtyArb = (min: number, max: number) =>
  fc
    .tuple(fc.integer({ min, max }), fc.integer({ min: 0, max: 999 }))
    .map(([w, f]): Qty => `${w}.${String(f).padStart(3, '0')}`);

const recipeLineArb: fc.Arbitrary<RecipeLine> = fc.record({
  itemId: fc.uuid(),
  itemName: fc.constant('Test Item'),
  qty: qtyArb(1, 1000),
  unitId: fc.uuid(),
  unitCode: fc.constant('kg'),
});

const recipeArb: fc.Arbitrary<Recipe> = fc.record({
  productId: fc.uuid(),
  yieldQty: qtyArb(1, 100),
  lines: fc.uniqueArray(recipeLineArb, { minLength: 1, maxLength: 10, selector: (l) => l.itemId }),
});

describe('RecipeService.explodeForSale — property tests', () => {
  it('exploding a sale of exactly yieldQty returns exactly the stored line quantities', () => {
    fc.assert(
      fc.property(recipeArb, (recipe) => {
        const usage = RecipeService.explodeForSale(recipe, recipe.yieldQty);
        for (let i = 0; i < recipe.lines.length; i++) {
          // ratio = yieldQty/yieldQty = 1 exactly, so no rounding drift possible here.
          expect(usage[i]!.qty).toBe(recipe.lines[i]!.qty);
        }
      }),
    );
  });

  it('exploding a sale of zero always yields zero for every ingredient', () => {
    fc.assert(
      fc.property(recipeArb, (recipe) => {
        const usage = RecipeService.explodeForSale(recipe, ZERO_QTY);
        for (const line of usage) expect(isZeroQty(line.qty)).toBe(true);
      }),
    );
  });

  it('scales linearly: exploding 2×qtySold yields ~2× the per-item consumption of exploding qtySold (within rounding)', () => {
    fc.assert(
      fc.property(recipeArb, qtyArb(1, 50), (recipe, qtySold) => {
        const single = RecipeService.explodeForSale(recipe, qtySold);
        const doubled = RecipeService.explodeForSale(
          recipe,
          `${(parseQty(qtySold) * 2n) / 1000n}.${String((parseQty(qtySold) * 2n) % 1000n).padStart(3, '0')}` as Qty,
        );
        for (let i = 0; i < single.length; i++) {
          const expectedDoubled = addQty(single[i]!.qty, single[i]!.qty);
          const diff = parseQty(doubled[i]!.qty) - parseQty(expectedDoubled);
          // Two independent half-up roundings (one per explosion call) can
          // differ by at most a couple of Qty-scale units — bounded drift,
          // not exact equality, is the real invariant for decimal math.
          expect(diff >= -2n && diff <= 2n).toBe(true);
        }
      }),
    );
  });

  it('never returns a negative quantity for a non-negative qtySold', () => {
    fc.assert(
      fc.property(recipeArb, qtyArb(0, 1000), (recipe, qtySold) => {
        const usage = RecipeService.explodeForSale(recipe, qtySold);
        for (const line of usage) expect(compareQty(line.qty, ZERO_QTY)).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  it('preserves the item set: one usage line per recipe line, same itemIds, same order', () => {
    fc.assert(
      fc.property(recipeArb, qtyArb(0, 500), (recipe, qtySold) => {
        const usage = RecipeService.explodeForSale(recipe, qtySold);
        expect(usage.map((u) => u.itemId)).toEqual(recipe.lines.map((l) => l.itemId));
      }),
    );
  });

  it('a recipe with no lines explodes to no usage, for any qtySold', () => {
    fc.assert(
      fc.property(
        fc.record({ productId: fc.uuid(), yieldQty: qtyArb(1, 100), lines: fc.constant([]) }),
        qtyArb(0, 500),
        (recipe, qtySold) => {
          expect(RecipeService.explodeForSale(recipe, qtySold)).toEqual([]);
        },
      ),
    );
  });
});
