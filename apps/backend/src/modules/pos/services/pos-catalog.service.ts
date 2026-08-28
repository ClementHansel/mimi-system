import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type {
  CatalogRecipeLine,
  Product,
  ProductKind,
  ProductPackageLine,
  Qty,
  UUID,
} from '@mimi/shared';

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
  category_id: UUID;
  price: string;
  price_gofood: string | null;
  price_shopeefood: string | null;
  photo_attachment_id: UUID | null;
  sort_order: number;
  is_active: boolean;
  kind: ProductKind;
  has_recipe: boolean;
}

interface RecipeLineRow {
  product_id: UUID;
  yield_qty: Qty;
  item_id: UUID;
  qty: Qty;
  unit_id: UUID;
}

interface PackageLineRow {
  package_product_id: UUID;
  member_product_id: UUID;
  member_name: string;
  member_code: string;
  qty: Qty;
  sort_order: number;
}

/**
 * `GET /api/pos/catalog` (FR-POS-01) — the device precache payload: every
 * active menu product plus the categories in the order the back office
 * arranged them. `version` is a cheap cache-busting token over every input to
 * the payload, so the offline runtime (W2-E) can skip a re-download when
 * nothing changed.
 *
 * PHOTOS (`photoPath`): this used to send `photoUrl: null` always, because
 * resolving one meant a presigned url that expires in 10 minutes while a
 * precached catalog lives for as long as the device stays offline. Fixed by
 * serving a STABLE api path (`/products/:id/photo`) that streams a small
 * cached WebP thumbnail instead — the till fetches each once and keeps the
 * blob in IndexedDB, so a tile still renders on a dead link. `photoUrl` stays
 * `null` here; it is the expiring back-office field.
 */
@Injectable()
export class PosCatalogService {
  async getCatalog(client: PoolClient): Promise<CatalogResponse> {
    // INACTIVE PRODUCTS ARE INCLUDED WHEN THEY ARE A MEMBER OF AN ACTIVE
    // PACKAGE. A member taken off the menu on its own (`is_active = false`) is
    // still consumed when the bundle containing it sells, and the offline
    // runtime explodes a package by looking its members up in THIS payload —
    // leaving them out would silently drop that stock from the local FR-POS-06
    // estimate. `ProductGrid` filters on `isActive`, so they never show as
    // their own tile. (The cloud projector re-explodes from the DB on apply, so
    // the authoritative posting was never affected — only the local estimate.)
    const res = await client.query<ProductRow>(
      `SELECT p.id, p.code, p.name, pc.name AS category, p.category_id, p.price,
              p.price_gofood, p.price_shopeefood,
              p.photo_attachment_id, p.sort_order, p.is_active, p.kind,
              (r.id IS NOT NULL) AS has_recipe
         FROM products p
         JOIN product_categories pc ON pc.id = p.category_id
         LEFT JOIN recipes r ON r.product_id = p.id AND r.is_active
        WHERE p.is_active
           OR EXISTS (
                SELECT 1
                  FROM product_package_lines ppl
                  JOIN products pkg ON pkg.id = ppl.package_product_id
                 WHERE ppl.member_product_id = p.id AND pkg.is_active
              )
        ORDER BY p.sort_order, p.name`,
    );

    // Recipe lines for every active-recipe product in one query (FR-POS-06 —
    // lets an offline device fold a sale into local stock consumption without
    // a round trip; see `Product.recipeLines`'s doc). Minimal projection only:
    // item id, qty, unit id — no item name/unit code (payload-size discipline
    // for a payload that is precached on every tablet).
    //
    // D-29 (accepted) — `unit_conversions` is deliberately NOT shipped in this
    // payload, and that has a consequence worth stating at the source rather
    // than only in the debt register: where `rl.unit_id` differs from the
    // ingredient's base unit, the device cannot convert, so its local stock
    // estimate DRIFTS from the server's. A recipe line in grams against an
    // item stocked in kilograms is off by 1000x on the tablet's own counter.
    //
    // Accepted because FR-POS-06 specifies an ESTIMATE — the tablet's number
    // exists to warn a cashier that something is running low, and the
    // authoritative figure is the server's, recomputed from the same recipe on
    // sync via `RecipeService.explodeForSale()`, which DOES convert. Nothing
    // financial or inventory-of-record depends on the device number.
    //
    // The fix, if the drift ever becomes visible in practice, is to ship the
    // conversion factors for the units actually referenced by active recipes —
    // a small set, not the whole `unit_conversions` table — rather than to
    // make the device authoritative.
    const recipeLinesRes = await client.query<RecipeLineRow>(
      `SELECT r.product_id, r.yield_qty, rl.item_id, rl.qty, rl.unit_id
         FROM recipes r
         JOIN recipe_lines rl ON rl.recipe_id = r.id
        WHERE r.is_active`,
    );
    const yieldQtyByProduct = new Map<UUID, Qty>();
    const linesByProduct = new Map<UUID, CatalogRecipeLine[]>();
    for (const row of recipeLinesRes.rows) {
      yieldQtyByProduct.set(row.product_id, row.yield_qty);
      const lines = linesByProduct.get(row.product_id) ?? [];
      lines.push({ itemId: row.item_id, qty: row.qty, unitId: row.unit_id });
      linesByProduct.set(row.product_id, lines);
    }

    // Package membership, same one-query treatment. Member NAME and CODE are
    // carried (unlike the deliberately minimal recipe projection) because the
    // cashier and the printed receipt both show what is inside a bundle, and
    // there are a handful of packages with a handful of members each — the
    // bytes are noise next to a round trip the till may not be able to make.
    const packageLinesRes = await client.query<PackageLineRow>(
      `SELECT ppl.package_product_id, ppl.member_product_id, m.name AS member_name,
              m.code AS member_code, ppl.qty, ppl.sort_order
         FROM product_package_lines ppl
         JOIN products pkg ON pkg.id = ppl.package_product_id
         JOIN products m ON m.id = ppl.member_product_id
        WHERE pkg.is_active
        ORDER BY ppl.sort_order, m.name`,
    );
    const packageLinesByProduct = new Map<UUID, ProductPackageLine[]>();
    for (const row of packageLinesRes.rows) {
      const lines = packageLinesByProduct.get(row.package_product_id) ?? [];
      lines.push({
        memberProductId: row.member_product_id,
        memberName: row.member_name,
        memberCode: row.member_code,
        qty: row.qty,
        sortOrder: row.sort_order,
      });
      packageLinesByProduct.set(row.package_product_id, lines);
    }

    const products: Product[] = res.rows.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      category: r.category,
      categoryId: r.category_id,
      price: r.price,
      priceGofood: r.price_gofood,
      priceShopeefood: r.price_shopeefood,
      photoUrl: null,
      photoPath: r.photo_attachment_id ? `/products/${r.id}/photo` : null,
      sortOrder: r.sort_order,
      isActive: r.is_active,
      kind: r.kind,
      hasRecipe: r.has_recipe,
      ...(r.has_recipe
        ? {
            recipeYieldQty: yieldQtyByProduct.get(r.id),
            recipeLines: linesByProduct.get(r.id) ?? [],
          }
        : {}),
      ...(r.kind === 'package' ? { packageLines: packageLinesByProduct.get(r.id) ?? [] } : {}),
    }));

    // The till's category chip row, in the order the back office set — it was
    // alphabetical here because alphabetical was the only order a free-text
    // column could give (migration 247). Categories with nothing sellable under
    // them are left out rather than rendering a chip that filters to an empty
    // grid.
    const categoriesRes = await client.query<{ name: string }>(
      `SELECT pc.name
         FROM product_categories pc
        WHERE pc.is_active
          AND EXISTS (SELECT 1 FROM products p WHERE p.category_id = pc.id AND p.is_active)
        ORDER BY pc.sort_order, pc.name`,
    );
    const categories = categoriesRes.rows.map((r) => r.name);

    // `version` must cover EVERY input to this payload, not just `products`.
    // It was `MAX(products.updated_at)` alone, which is now insufficient: a
    // category rename or reorder changes what the till renders while leaving
    // every product row untouched, so a device would hold the old chip row
    // until something unrelated happened to a product. Package membership is
    // covered because `PackageService` touches the parent product's
    // `updated_at` when it rewrites lines — for exactly this reason.
    const versionRes = await client.query<{ version: Date | null }>(
      `SELECT GREATEST(
                (SELECT MAX(updated_at) FROM products),
                (SELECT MAX(updated_at) FROM product_categories)
              ) AS version`,
    );
    const version = versionRes.rows[0]?.version
      ? new Date(versionRes.rows[0].version).toISOString()
      : '0';

    return { products, categories, version };
  }
}
