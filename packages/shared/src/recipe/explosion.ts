import { convertQty, divQty, isZeroQty, ZERO_QTY } from '../qty';
import type { Qty } from '../types';

/**
 * D-27 — the recipe-explosion formula, defined ONCE.
 *
 * ## What it is
 *
 * `recipe_lines.qty` is "how much of this ingredient one EXECUTION of the
 * recipe consumes", and `recipes.yield_qty` is "how many product units one
 * execution yields" (CONTRACTS §1.2). So selling `qtySold` of the product
 * consumes `line.qty × (qtySold / yieldQty)` of each ingredient.
 *
 * ## Why it lives in `@mimi/shared`
 *
 * It was implemented twice — `modules/product`'s `RecipeService.explodeForSale`
 * and `modules/pos`'s `recipe-usage.util` — and the two HAD ALREADY DIVERGED:
 * the POS copy omitted the yield division entirely, so every batch recipe
 * mis-posted stock on every sale. It stayed invisible because all 39 seeded
 * recipes have `yield_qty = 1`, where the division is a no-op, and 13 tests
 * missed it for the same reason (D-28).
 *
 * Both call sites now import from here. That is the actual fix for D-27; the
 * earlier one corrected the arithmetic and left the duplication in place to
 * diverge again.
 *
 * ## THE SCALE TRAP (read before touching the ratio)
 *
 * The ratio is carried at SIX decimal places, deliberately: a batch recipe's
 * ratio is frequently non-terminating (1/3), and truncating it to `Qty`'s own
 * three places would drift measurably across a day of sales.
 *
 * That makes the ratio NOT a `Qty`, despite having the same TypeScript type.
 * Every `Qty` predicate — `isZeroQty`, `parseQty`, `addQty`, … — parses at
 * scale 3 and THROWS on a value with more fractional digits. Passing the ratio
 * to one of them is an easy mistake and it is not a quiet one; it took down
 * four property tests the first time this module was written. Zero is therefore
 * tested on `qtySold`, which really is a `Qty`, never on the ratio.
 */

/** Six places: enough that a 1/3 batch ratio does not drift over a day of sales. */
const RATIO_SCALE = 6;

/**
 * `qtySold / yieldQty` — how many recipe executions this sale represents.
 *
 * **The result is a 6-decimal scaling factor, not a `Qty`.** Feed it only to
 * `convertQty`; see the scale trap above. Exported because
 * `recipe-usage.util` resolves it ONCE per sale line and then applies it across
 * every ingredient row of that recipe, so it needs the factor itself rather
 * than a per-line convenience — and having it here is what stops that call site
 * writing `divQty(...)` inline again, which is how the divergence started.
 *
 * Callers must have already excluded a zero `qtySold`: `convertQty` rejects a
 * zero factor, correctly, because its real callers pass a stored
 * `unit_conversions.factor` that the DB CHECK never allows to be zero.
 */
export function recipeScaleRatio(qtySold: Qty, yieldQty: Qty): Qty {
  return divQty(qtySold, yieldQty, RATIO_SCALE);
}

/**
 * How much of ONE ingredient line a sale of `qtySold` consumes, in that line's
 * own unit. Unit conversion to the item's base unit is the caller's job — the
 * two callers differ there (POS resolves `unit_conversions`, the product module
 * reports in recipe units) and that difference is real, not duplication.
 */
export function explodeRecipeLineQty(lineQty: Qty, qtySold: Qty, yieldQty: Qty): Qty {
  if (isZeroQty(qtySold)) return ZERO_QTY;
  return convertQty(lineQty, recipeScaleRatio(qtySold, yieldQty));
}

/**
 * Applies the explosion across a whole recipe, resolving the ratio once.
 *
 * A sale of zero consumes nothing, full stop — returned as explicit zero lines
 * rather than an empty array, so the caller still sees one usage line per
 * recipe line and downstream code does not have to special-case the shape.
 */
export function explodeRecipeLines<T extends { qty: Qty }>(
  lines: readonly T[],
  qtySold: Qty,
  yieldQty: Qty,
): Array<{ line: T; qty: Qty }> {
  if (isZeroQty(qtySold)) return lines.map((line) => ({ line, qty: ZERO_QTY }));
  const ratio = recipeScaleRatio(qtySold, yieldQty);
  return lines.map((line) => ({ line, qty: convertQty(line.qty, ratio) }));
}
