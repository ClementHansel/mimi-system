import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { CatalogRecipeLine, Product, Qty, UUID } from '@mimi/shared';

export interface CatalogResponse {
  products: Product[];
  categories: string[];
  version: string;
}

interface ProductRow {
  id: UUID;
  code: string;
  name: string;
  category: string;
  price: string;
  sort_order: number;
  is_active: boolean;
  has_recipe: boolean;
}

interface RecipeLineRow {
  product_id: UUID;
  yield_qty: Qty;
  item_id: UUID;
  qty: Qty;
  unit_id: UUID;
}

/**
 * `GET /api/pos/catalog` (FR-POS-01) — the device precache payload: every
 * active menu product plus its distinct categories. `version` is a cheap
 * cache-busting token (max `products.updated_at`) so the offline runtime
 * (W2-E) can skip a re-download when nothing changed.
 *
 * Photo URLs are intentionally omitted (`photoUrl: null` always) — resolving
 * one requires either a public MinIO read policy or a per-request presigned
 * URL (`kernel/storage`'s `StorageService.getUrl`), and neither fits a
 * long-lived offline precache payload (a presigned URL expires long before
 * a cached catalog does). Flagged as a follow-up in the module report.
 */
@Injectable()
export class PosCatalogService {
  async getCatalog(client: PoolClient): Promise<CatalogResponse> {
    const res = await client.query<ProductRow & { max_updated_at: Date | null }>(
      `SELECT p.id, p.code, p.name, p.category, p.price, p.sort_order, p.is_active,
              (r.id IS NOT NULL) AS has_recipe,
              MAX(p.updated_at) OVER () AS max_updated_at
         FROM products p
         LEFT JOIN recipes r ON r.product_id = p.id AND r.is_active
        WHERE p.is_active
        ORDER BY p.sort_order, p.name`,
    );

    // Recipe lines for every active-recipe product in one query (FR-POS-06 —
    // lets an offline device fold a sale into local stock consumption without
    // a round trip; see `Product.recipeLines`'s doc). Minimal projection only:
    // item id, qty, unit id — no item name/unit code (payload-size discipline
    // for a payload that is precached on every tablet).
    const recipeLinesRes = await client.query<RecipeLineRow>(
      `SELECT r.product_id, r.yield_qty, rl.item_id, rl.qty, rl.unit_id
         FROM recipes r
         JOIN recipe_lines rl ON rl.recipe_id = r.id
         JOIN products p ON p.id = r.product_id
        WHERE r.is_active AND p.is_active`,
    );
    const yieldQtyByProduct = new Map<UUID, Qty>();
    const linesByProduct = new Map<UUID, CatalogRecipeLine[]>();
    for (const row of recipeLinesRes.rows) {
      yieldQtyByProduct.set(row.product_id, row.yield_qty);
      const lines = linesByProduct.get(row.product_id) ?? [];
      lines.push({ itemId: row.item_id, qty: row.qty, unitId: row.unit_id });
      linesByProduct.set(row.product_id, lines);
    }

    const products: Product[] = res.rows.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      category: r.category,
      price: r.price,
      photoUrl: null,
      sortOrder: r.sort_order,
      isActive: r.is_active,
      hasRecipe: r.has_recipe,
      ...(r.has_recipe
        ? {
            recipeYieldQty: yieldQtyByProduct.get(r.id),
            recipeLines: linesByProduct.get(r.id) ?? [],
          }
        : {}),
    }));

    const categories = [...new Set(products.map((p) => p.category))].sort();
    const version = res.rows[0]?.max_updated_at
      ? new Date(res.rows[0].max_updated_at).toISOString()
      : '0';

    return { products, categories, version };
  }
}
