import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { explodeRecipeLines, ERR_NOT_FOUND, SyncEntity, type Qty, type UUID } from '@mimi/shared';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';
import { withWrite } from './db-tx';
import { PutRecipeDto } from './dto/recipe.dto';

export interface RecipeLine {
  itemId: UUID;
  itemName: string;
  qty: Qty;
  unitId: UUID;
  unitCode: string;
}

export interface Recipe {
  productId: UUID;
  yieldQty: Qty;
  lines: RecipeLine[];
}

/** One line of the ingredient consumption estimate FR-POS-06 needs at sale time. */
export interface UsageLine {
  itemId: UUID;
  qty: Qty;
}

/**
 * Recipes / BOM (`recipes`, `recipe_lines`) — CONTRACTS.md §4.5, FR-POS-06.
 * This is THE structure that converts a sold product into raw-material
 * (`items`) consumption — `explodeForSale()` is the reusable seam a future
 * POS sale-posting flow (M13, Wave 4) calls into rather than re-deriving the
 * math; it is exported from `ProductModule` for exactly that purpose.
 *
 * `recipe_lines.qty` is "per 1 execution of the recipe" and `recipes.yield_qty`
 * is how many product units one execution yields (CONTRACTS.md §1.2) — so the
 * per-sold-unit consumption of an ingredient is `line.qty × (qtySold /
 * yieldQty)`, computed via `@mimi/shared`'s `convertQty`/`divQty` (the exact
 * same decimal-safe scaling `unit_conversions.factor` uses) rather than raw
 * floating-point arithmetic, so a batch recipe (yieldQty > 1) scales
 * correctly and rounds half-up to `Qty` (NUMERIC(14,3)) scale, never silently
 * drifting across many sales.
 *
 * No RLS on `recipes`/`recipe_lines` (§1.14 NONE), but reads are additionally
 * gated by `recipe.read` at the API layer (a recipe is cost structure).
 */
@Injectable()
export class RecipeService {
  constructor(private readonly sync: SyncEmitService) {}

  private async ensureProductExists(client: PoolClient, productId: string): Promise<void> {
    const res = await client.query(`SELECT 1 FROM products WHERE id = $1`, [productId]);
    if (res.rowCount === 0)
      throw new NotFoundException({ code: ERR_NOT_FOUND, message: 'Product not found' });
  }

  async getRecipe(client: PoolClient, productId: string): Promise<Recipe> {
    await this.ensureProductExists(client, productId);
    const recipeRes = await client.query<{ yield_qty: string }>(
      `SELECT yield_qty FROM recipes WHERE product_id = $1 AND is_active = true`,
      [productId],
    );
    if (!recipeRes.rows[0]) return { productId, yieldQty: '1.000', lines: [] };

    const linesRes = await client.query<{
      item_id: string;
      item_name: string;
      qty: string;
      unit_id: string;
      unit_code: string;
    }>(
      `SELECT rl.item_id, i.name AS item_name, rl.qty, rl.unit_id, u.code AS unit_code
       FROM recipe_lines rl
       JOIN items i ON i.id = rl.item_id
       JOIN units u ON u.id = rl.unit_id
       WHERE rl.recipe_id = (SELECT id FROM recipes WHERE product_id = $1 AND is_active = true)
       ORDER BY i.name ASC`,
      [productId],
    );

    return {
      productId,
      yieldQty: recipeRes.rows[0].yield_qty,
      lines: linesRes.rows.map((r) => ({
        itemId: r.item_id,
        itemName: r.item_name,
        qty: r.qty,
        unitId: r.unit_id,
        unitCode: r.unit_code,
      })),
    };
  }

  /** Full replace of the product's BOM (CONTRACTS.md §4.5 `PUT .../recipe`). Upserts the `recipes` row, replaces every line. */
  async putRecipe(
    client: PoolClient,
    productId: string,
    dto: PutRecipeDto,
    actorUserId: string,
  ): Promise<Recipe> {
    return withWrite(client, async () => {
      await this.ensureProductExists(client, productId);

      const itemIds = new Set(dto.lines.map((l) => l.itemId));
      if (itemIds.size !== dto.lines.length) {
        throw new BadRequestException({
          code: 'ERR_VALIDATION',
          message: 'Duplicate itemId in recipe lines',
        });
      }

      const recipeRes = await client.query<{ id: string }>(
        `INSERT INTO recipes (product_id, yield_qty)
         VALUES ($1, $2)
         ON CONFLICT (product_id) DO UPDATE SET yield_qty = EXCLUDED.yield_qty, is_active = true
         RETURNING id`,
        [productId, dto.yieldQty],
      );
      const recipeId = recipeRes.rows[0]!.id;

      await client.query(`DELETE FROM recipe_lines WHERE recipe_id = $1`, [recipeId]);
      for (const line of dto.lines) {
        await client.query(
          `INSERT INTO recipe_lines (recipe_id, item_id, qty, unit_id) VALUES ($1,$2,$3,$4)`,
          [recipeId, line.itemId, line.qty, line.unitId],
        );
      }

      const recipe = await this.getRecipe(client, productId);
      // RECIPES embeds recipe_lines (@mimi/sync-protocol authority matrix) — one event carries both.
      await this.sync.emit(client, {
        entity: SyncEntity.RECIPES,
        op: 'updated',
        entityId: recipeId,
        locationId: null,
        actorUserId,
        data: recipe,
      });
      return recipe;
    });
  }

  /**
   * FR-POS-06: explodes a sold quantity of a product into per-item ingredient
   * consumption. Pure function of an already-loaded `Recipe` — no DB access —
   * so it is directly property-testable and directly reusable by a future
   * POS sale-posting flow without that caller needing its own DB round trip
   * shape.
   */
  static explodeForSale(recipe: Recipe, qtySold: Qty): UsageLine[] {
    // The zero-sale special case (a sale of zero consumes nothing, which
    // `convertQty`'s factor > 0 guard would otherwise reject) moved into the
    // shared helper along with the rest of the formula — see its header.
    //
    // D-27 — the formula itself lives in `@mimi/shared`'s `explodeRecipeLines`.
    // It used to be written out here AND again in `modules/pos`'s
    // `recipe-usage.util`, and the two had already diverged: the POS copy
    // dropped the yield division, mis-posting stock for every batch recipe.
    // Both now call the same function, so a future change lands in one place.
    return explodeRecipeLines(recipe.lines, qtySold, recipe.yieldQty).map(({ line, qty }) => ({
      itemId: line.itemId,
      qty,
    }));
  }

  /** DB-backed convenience wrapper: loads the recipe then explodes it. */
  async explodeForSale(client: PoolClient, productId: string, qtySold: Qty): Promise<UsageLine[]> {
    const recipe = await this.getRecipe(client, productId);
    return RecipeService.explodeForSale(recipe, qtySold);
  }
}
