import type { PoolClient } from 'pg';
import type { Money, Qty, UUID } from '@mimi/shared';
import { convertQty, formatQty, isZeroQty, parseQty, recipeScaleRatio } from '@mimi/shared';

/**
 * Recipe explosion (FR-POS-06) — turns a set of sold/voided `{productId,
 * qty}` lines into ingredient consumption, aggregated per item, for
 * `StockLedgerService.post()` to apply as `usage_out` (sale) or `return_in`
 * (void/refund reversal). A PACKAGE line is rewritten into its member products
 * first (`expandPackages`, migration 248) so a bundle consumes exactly what its
 * members' recipes consume. Shared by `PosSaleService` and
 * `PosVoidRefundService` — the reversal walks the SAME sale's own
 * `sale_lines`, not a re-declared quantity, so a void always reverses
 * exactly what was consumed.
 *
 * `recipe_lines.qty` is "per 1 execution of the recipe" and `recipes.yield_qty`
 * is how many product units one execution yields (CONTRACTS.md §1.2,
 * `modules/product/recipe.service.ts`'s `RecipeService.explodeForSale` —
 * THE authoritative seam for this math) — so the per-sold-unit consumption
 * of an ingredient is `line.qty × (qtySold / yieldQty)`, via the same
 * `divQty`/`convertQty` decimal-safe scaling `RecipeService` uses, NOT a
 * flat `recipe_qty × qtySold` (a previous version of this file scaled that
 * way and silently over/under-posted stock for any batch recipe with
 * `yield_qty != 1` — corrected here to match the one true formula rather
 * than re-deriving it a second, divergent way).
 *
 * Unit handling: `recipe_lines.unit_id` is not always the ingredient's own
 * `items.base_unit_id` (e.g. a recipe line may be authored in `kg` while the
 * item's stocked unit is `pcs`) — `stock_movements.qty` carries no unit
 * column of its own, so everything must land in the item's base unit before
 * `StockLedgerService` ever sees it. A conversion path
 * (`unit_conversions`, item-specific row preferred over the generic
 * `item_id IS NULL` row) is looked up per ingredient; when NONE exists (a
 * master-data gap — e.g. seed data pairs a `kg`-authored recipe line with a
 * `pcs`-based packaging item and no `kg→pcs` conversion is meaningful), that
 * ingredient's usage is SKIPPED rather than failing the whole sale — FR-
 * POS-06 is explicitly an "estimate", and a real sale must never be blocked
 * by a recipe/unit master-data mismatch (the same D-17a spirit as fact-mode
 * ledger posting: the chicken was still really sold).
 */

export interface UsageLine {
  productId: UUID;
  qty: Qty;
}

export interface IngredientUsage {
  itemId: UUID;
  /** Already in the item's own `base_unit_id`. */
  qty: Qty;
  /** `items.avg_cost` snapshot at explosion time. */
  unitCost: Money;
}

export interface SkippedIngredient {
  productId: UUID;
  itemId: UUID;
  reason: string;
}

export interface RecipeExplosionResult {
  usages: IngredientUsage[];
  skipped: SkippedIngredient[];
}

interface RecipeLineRow {
  item_id: UUID;
  recipe_qty: Qty;
  recipe_unit_id: UUID;
  base_unit_id: UUID;
  avg_cost: Money;
}

async function resolveUnitConversion(
  client: PoolClient,
  itemId: UUID,
  fromUnitId: UUID,
  toUnitId: UUID,
): Promise<string | null> {
  if (fromUnitId === toUnitId) return '1.000000';
  const res = await client.query<{ factor: string }>(
    `SELECT factor FROM unit_conversions
      WHERE from_unit_id = $2 AND to_unit_id = $3 AND (item_id = $1 OR item_id IS NULL)
      ORDER BY item_id NULLS LAST
      LIMIT 1`,
    [itemId, fromUnitId, toUnitId],
  );
  return res.rows[0]?.factor ?? null;
}

/**
 * Rewrites any package line into its MEMBER product lines before explosion
 * (migration 248).
 *
 * A package is a `products` row with `kind = 'package'` that carries no recipe
 * of its own — selling one consumes whatever its members' recipes consume. So
 * `{ package, qty: 2 }` where the package contains 3 × Ayam becomes
 * `{ ayam, qty: 6 }`, and the existing per-product recipe explosion below
 * handles it unchanged.
 *
 * ONE LEVEL ONLY, and that is enforced, not assumed: migration 248's triggers
 * refuse a package as a member of another package, so a member is always a
 * plain product and this needs no recursion or depth guard.
 *
 * A package with NO members contributes nothing, exactly as a product with no
 * recipe does — `PutPackageDto` requires at least one member, so this only
 * happens to a row that predates its membership being set.
 *
 * Member qtys are folded into the SAME `{productId, qty}` shape the caller
 * passed, so a sale that contains both a bundle and a loose Ayam aggregates
 * that ingredient once rather than posting two movements for it.
 */
async function expandPackages(
  client: PoolClient,
  lines: readonly UsageLine[],
): Promise<UsageLine[]> {
  if (lines.length === 0) return [];

  const packageRes = await client.query<{ id: UUID }>(
    `SELECT id FROM products WHERE id = ANY($1::uuid[]) AND kind = 'package'`,
    [lines.map((l) => l.productId)],
  );
  if (packageRes.rows.length === 0) return [...lines];

  const packageIds = new Set(packageRes.rows.map((r) => r.id));
  const memberRes = await client.query<{
    package_product_id: UUID;
    member_product_id: UUID;
    qty: Qty;
  }>(
    `SELECT package_product_id, member_product_id, qty
       FROM product_package_lines
      WHERE package_product_id = ANY($1::uuid[])`,
    [[...packageIds]],
  );
  const membersByPackage = new Map<UUID, { memberProductId: UUID; qty: Qty }[]>();
  for (const row of memberRes.rows) {
    const members = membersByPackage.get(row.package_product_id) ?? [];
    members.push({ memberProductId: row.member_product_id, qty: row.qty });
    membersByPackage.set(row.package_product_id, members);
  }

  // Aggregate in the scaled-integer domain (`parseQty`/`formatQty`) rather than
  // summing decimal strings — same decimal-safety rule the rest of this file
  // follows, and it matters here because a member qty is multiplied by a sold
  // qty before anything else sees it.
  const scaledByProduct = new Map<UUID, bigint>();
  const add = (productId: UUID, qty: Qty) => {
    scaledByProduct.set(productId, (scaledByProduct.get(productId) ?? 0n) + parseQty(qty));
  };

  for (const line of lines) {
    if (!packageIds.has(line.productId)) {
      add(line.productId, line.qty);
      continue;
    }
    // A zero-qty line consumes nothing, and `convertQty` REJECTS a zero factor
    // (`RangeError`) rather than returning zero — reaching it with one would
    // throw out of the whole sale posting, not just skip a line. The recipe
    // loop below has the same guard for the same reason.
    if (isZeroQty(line.qty)) continue;
    for (const member of membersByPackage.get(line.productId) ?? []) {
      // members-per-package × packages-sold, via the same decimal-safe
      // multiply `recipeScaleRatio`/`convertQty` use for recipe scaling.
      add(member.memberProductId, convertQty(member.qty, line.qty));
    }
  }

  return [...scaledByProduct.entries()].map(([productId, scaled]) => ({
    productId,
    qty: formatQty(scaled),
  }));
}

/**
 * Explodes `lines` through each product's active recipe. A product with no
 * `recipes` row (e.g. a straight-resale bottled drink never given a BOM) is
 * silently skipped — that is a valid master-data choice (`recipes` is
 * optional per product), not an error.
 */
export async function explodeRecipeUsage(
  client: PoolClient,
  lines: readonly UsageLine[],
): Promise<RecipeExplosionResult> {
  const scaledByItem = new Map<UUID, bigint>();
  const costByItem = new Map<UUID, Money>();
  const skipped: SkippedIngredient[] = [];

  const effectiveLines = await expandPackages(client, lines);

  for (const line of effectiveLines) {
    if (isZeroQty(line.qty)) continue; // a zero-qty line consumes nothing; also sidesteps convertQty's factor>0 guard below

    const recipeRes = await client.query<{ id: UUID; yield_qty: Qty }>(
      `SELECT id, yield_qty FROM recipes WHERE product_id = $1 AND is_active LIMIT 1`,
      [line.productId],
    );
    const recipeRow = recipeRes.rows[0];
    if (!recipeRow) continue;

    // D-27 — the ratio comes from `@mimi/shared`, not from a second copy of
    // the arithmetic written out here. THIS call site is the one that had
    // diverged: it omitted the yield division entirely, so every batch recipe
    // mis-posted stock on every sale, invisible only because all 39 seeded
    // recipes yield 1. Sharing the function is what stops that recurring.
    const ratio = recipeScaleRatio(line.qty, recipeRow.yield_qty);

    const linesRes = await client.query<RecipeLineRow>(
      `SELECT rl.item_id, rl.qty AS recipe_qty, rl.unit_id AS recipe_unit_id, i.base_unit_id, i.avg_cost
         FROM recipe_lines rl
         JOIN items i ON i.id = rl.item_id
        WHERE rl.recipe_id = $1`,
      [recipeRow.id],
    );

    for (const row of linesRes.rows) {
      const totalInRecipeUnit = convertQty(row.recipe_qty, ratio);

      let baseQty: Qty;
      if (row.recipe_unit_id === row.base_unit_id) {
        baseQty = totalInRecipeUnit;
      } else {
        const factor = await resolveUnitConversion(
          client,
          row.item_id,
          row.recipe_unit_id,
          row.base_unit_id,
        );
        if (!factor) {
          skipped.push({
            productId: line.productId,
            itemId: row.item_id,
            reason: `no unit_conversions path from ${row.recipe_unit_id} to ${row.base_unit_id} for item ${row.item_id}`,
          });
          continue;
        }
        baseQty = convertQty(totalInRecipeUnit, factor);
      }

      scaledByItem.set(row.item_id, (scaledByItem.get(row.item_id) ?? 0n) + parseQty(baseQty));
      costByItem.set(row.item_id, row.avg_cost);
    }
  }

  const usages: IngredientUsage[] = [...scaledByItem.entries()]
    .map(([itemId, scaled]) => ({
      itemId,
      qty: formatQty(scaled),
      unitCost: costByItem.get(itemId)!,
    }))
    .filter((u) => parseQty(u.qty) > 0n);

  return { usages, skipped };
}

/** The outlet's `kitchen_line` storage area — where recipe-explosion usage is consumed from/returned to (CONTRACTS.md §1.6 comment). Picks the first active one; a location with none configured yields `null` (caller decides whether to skip posting). */
export async function findKitchenLineAreaId(
  client: PoolClient,
  locationId: UUID,
): Promise<UUID | null> {
  const res = await client.query<{ id: UUID }>(
    `SELECT id FROM storage_areas WHERE location_id = $1 AND type = 'kitchen_line' AND is_active ORDER BY sort_order LIMIT 1`,
    [locationId],
  );
  return res.rows[0]?.id ?? null;
}
