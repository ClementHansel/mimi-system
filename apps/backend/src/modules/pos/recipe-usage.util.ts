import type { PoolClient } from 'pg';
import type { Money, Qty, UUID } from '@mimi/shared';
import { convertQty, divQty, formatQty, isZeroQty, parseQty } from '@mimi/shared';

/**
 * Recipe explosion (FR-POS-06) — turns a set of sold/voided `{productId,
 * qty}` lines into ingredient consumption, aggregated per item, for
 * `StockLedgerService.post()` to apply as `usage_out` (sale) or `return_in`
 * (void/refund reversal). Shared by `PosSaleService` and
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
 * Explodes `lines` through each product's active recipe. A product with no
 * `recipes` row (e.g. a straight-resale bottled drink never given a BOM) is
 * silently skipped — that is a valid master-data choice (`recipes` is
 * optional per product), not an error.
 */
export async function explodeRecipeUsage(client: PoolClient, lines: readonly UsageLine[]): Promise<RecipeExplosionResult> {
  const scaledByItem = new Map<UUID, bigint>();
  const costByItem = new Map<UUID, Money>();
  const skipped: SkippedIngredient[] = [];

  for (const line of lines) {
    if (isZeroQty(line.qty)) continue; // a zero-qty line consumes nothing; also sidesteps convertQty's factor>0 guard below

    const recipeRes = await client.query<{ id: UUID; yield_qty: Qty }>(
      `SELECT id, yield_qty FROM recipes WHERE product_id = $1 AND is_active LIMIT 1`,
      [line.productId],
    );
    const recipeRow = recipeRes.rows[0];
    if (!recipeRow) continue;

    // Same ratio `RecipeService.explodeForSale` computes: qtySold / yieldQty.
    const ratio = divQty(line.qty, recipeRow.yield_qty, 6);

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
        const factor = await resolveUnitConversion(client, row.item_id, row.recipe_unit_id, row.base_unit_id);
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
    .map(([itemId, scaled]) => ({ itemId, qty: formatQty(scaled), unitCost: costByItem.get(itemId)! }))
    .filter((u) => parseQty(u.qty) > 0n);

  return { usages, skipped };
}

/** The outlet's `kitchen_line` storage area — where recipe-explosion usage is consumed from/returned to (CONTRACTS.md §1.6 comment). Picks the first active one; a location with none configured yields `null` (caller decides whether to skip posting). */
export async function findKitchenLineAreaId(client: PoolClient, locationId: UUID): Promise<UUID | null> {
  const res = await client.query<{ id: UUID }>(
    `SELECT id FROM storage_areas WHERE location_id = $1 AND type = 'kitchen_line' AND is_active ORDER BY sort_order LIMIT 1`,
    [locationId],
  );
  return res.rows[0]?.id ?? null;
}
