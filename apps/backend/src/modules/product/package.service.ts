import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ERR_NOT_FOUND, SyncEntity, type ProductPackageLine, type UUID } from '@mimi/shared';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';
import { withWrite } from './db-tx';
import { PutPackageDto } from './dto/package.dto';

interface PackageLineRow {
  member_product_id: UUID;
  member_name: string;
  member_code: string;
  qty: string;
  sort_order: number;
}

/**
 * Package membership (`product_package_lines`, migration 248) — the bundle
 * equivalent of `RecipeService`.
 *
 * A package is a `products` row with `kind = 'package'` that lists MEMBER
 * PRODUCTS instead of carrying a recipe of raw items. It sells as ONE sale line
 * at its own price; stock consumption comes from exploding each member's own
 * recipe (`modules/pos/recipe-usage.util.ts`). Migration 248's header records
 * why it is a `products` row rather than its own table, and what that costs.
 *
 * THE INVARIANTS ARE ENFORCED TWICE, deliberately. Triggers in migration 248
 * are the real boundary (they hold against `database/seed.ts`, an import script
 * and a psql session alike); the checks here exist to turn each one into an
 * actionable 400 instead of a raised plpgsql exception surfacing as a 500 to
 * someone editing a bundle in the back office.
 */
@Injectable()
export class PackageService {
  constructor(private readonly sync: SyncEmitService) {}

  /** Members of a package, ordered as the back office arranged them. Empty for a non-package. */
  async getLines(client: PoolClient, packageProductId: string): Promise<ProductPackageLine[]> {
    const res = await client.query<PackageLineRow>(
      `SELECT ppl.member_product_id, p.name AS member_name, p.code AS member_code,
              ppl.qty, ppl.sort_order
         FROM product_package_lines ppl
         JOIN products p ON p.id = ppl.member_product_id
        WHERE ppl.package_product_id = $1
        ORDER BY ppl.sort_order ASC, p.name ASC`,
      [packageProductId],
    );
    return res.rows.map((r) => ({
      memberProductId: r.member_product_id,
      memberName: r.member_name,
      memberCode: r.member_code,
      qty: r.qty,
      sortOrder: r.sort_order,
    }));
  }

  /**
   * Members for MANY packages in one query — the list and catalog paths would
   * otherwise fire one query per package row (the N+1 that
   * `PosCatalogService`'s recipe-line load already avoids the same way).
   */
  async getLinesForMany(
    client: PoolClient,
    packageProductIds: readonly string[],
  ): Promise<Map<UUID, ProductPackageLine[]>> {
    const byPackage = new Map<UUID, ProductPackageLine[]>();
    if (packageProductIds.length === 0) return byPackage;

    const res = await client.query<PackageLineRow & { package_product_id: UUID }>(
      `SELECT ppl.package_product_id, ppl.member_product_id, p.name AS member_name,
              p.code AS member_code, ppl.qty, ppl.sort_order
         FROM product_package_lines ppl
         JOIN products p ON p.id = ppl.member_product_id
        WHERE ppl.package_product_id = ANY($1::uuid[])
        ORDER BY ppl.sort_order ASC, p.name ASC`,
      [packageProductIds],
    );

    for (const row of res.rows) {
      const lines = byPackage.get(row.package_product_id) ?? [];
      lines.push({
        memberProductId: row.member_product_id,
        memberName: row.member_name,
        memberCode: row.member_code,
        qty: row.qty,
        sortOrder: row.sort_order,
      });
      byPackage.set(row.package_product_id, lines);
    }
    return byPackage;
  }

  /**
   * Full replace of a package's membership (`PUT /api/products/:id/package`).
   *
   * Flipping a plain product into a package is done HERE rather than making the
   * caller send a separate `PATCH { kind: 'package' }` first: the two are one
   * intention ("this is a bundle of these things"), and splitting them across
   * two requests leaves a window where a `kind = 'package'` product has no
   * members — a sellable that consumes no stock at all.
   */
  async putLines(
    client: PoolClient,
    packageProductId: string,
    dto: PutPackageDto,
    actorUserId: string,
  ): Promise<ProductPackageLine[]> {
    return withWrite(client, async () => {
      const target = await client.query<{ id: UUID; kind: string }>(
        `SELECT id, kind FROM products WHERE id = $1`,
        [packageProductId],
      );
      if (!target.rows[0])
        throw new NotFoundException({ code: ERR_NOT_FOUND, message: 'Product not found' });

      const memberIds = dto.lines.map((l) => l.memberProductId);

      if (new Set(memberIds).size !== memberIds.length) {
        throw new BadRequestException({
          code: 'ERR_VALIDATION',
          message: 'Duplicate memberProductId in package lines — set the quantity instead',
        });
      }
      if (memberIds.includes(packageProductId)) {
        throw new BadRequestException({
          code: 'ERR_VALIDATION',
          message: 'A package cannot contain itself',
        });
      }

      // Every member must exist and be a plain product. Both failures are
      // checked in one query so the message can name WHICH member is wrong —
      // "packages do not nest" is unactionable without the name.
      const members = await client.query<{ id: UUID; name: string; kind: string }>(
        `SELECT id, name, kind FROM products WHERE id = ANY($1::uuid[])`,
        [memberIds],
      );
      const foundById = new Map(members.rows.map((r) => [r.id, r]));

      const missing = memberIds.filter((id) => !foundById.has(id));
      if (missing.length > 0) {
        throw new BadRequestException({
          code: 'ERR_VALIDATION',
          message: `Package member product not found: ${missing.join(', ')}`,
        });
      }
      const nested = members.rows.filter((r) => r.kind === 'package');
      if (nested.length > 0) {
        throw new BadRequestException({
          code: 'ERR_VALIDATION',
          message: `Packages do not nest — remove ${nested.map((r) => `"${r.name}"`).join(', ')}`,
        });
      }

      // A package explodes through its members, so a recipe on the package
      // itself would count those ingredients a second time on every sale
      // (migration 248, invariant 3). Deactivate it rather than refusing: the
      // caller is explicitly telling us this is a bundle now, and a stale BOM
      // on a bundle has no meaning to preserve.
      await client.query(
        `UPDATE recipes SET is_active = false WHERE product_id = $1 AND is_active = true`,
        [packageProductId],
      );

      if (target.rows[0].kind !== 'package') {
        await client.query(`UPDATE products SET kind = 'package' WHERE id = $1`, [
          packageProductId,
        ]);
      }

      await client.query(`DELETE FROM product_package_lines WHERE package_product_id = $1`, [
        packageProductId,
      ]);
      for (const [i, line] of dto.lines.entries()) {
        await client.query(
          `INSERT INTO product_package_lines (package_product_id, member_product_id, qty, sort_order)
           VALUES ($1,$2,$3,$4)`,
          [packageProductId, line.memberProductId, line.qty, line.sortOrder ?? i],
        );
      }

      // Touch the parent so `PosCatalogService`'s `version` token moves: package
      // membership has no `updated_at` of its own, and without this a till that
      // already precached the catalog would keep exploding the OLD membership
      // until some unrelated product edit bumped the token.
      await client.query(`UPDATE products SET updated_at = NOW() WHERE id = $1`, [
        packageProductId,
      ]);

      const lines = await this.getLines(client, packageProductId);
      // PRODUCTS carries `product_package_lines` embedded (authority matrix) —
      // one event so a till never holds a bundle it cannot explode.
      await this.sync.emit(client, {
        entity: SyncEntity.PRODUCTS,
        op: 'updated',
        entityId: packageProductId,
        locationId: null,
        actorUserId,
        data: { id: packageProductId, kind: 'package', packageLines: lines },
      });
      return lines;
    });
  }

  /**
   * Turns a package back into a plain product, clearing its membership.
   *
   * Needed because migration 248's `products_kind_transition_guard` refuses a
   * `kind` flip while lines still exist — correctly, since orphaned lines would
   * be invisible to the back office but still present to any explosion that
   * looked. This is the one path that clears both together.
   */
  async clearLines(
    client: PoolClient,
    packageProductId: string,
    actorUserId: string,
  ): Promise<{ id: string; kind: 'product' }> {
    return withWrite(client, async () => {
      const res = await client.query(`SELECT 1 FROM products WHERE id = $1`, [packageProductId]);
      if (res.rowCount === 0)
        throw new NotFoundException({ code: ERR_NOT_FOUND, message: 'Product not found' });

      await client.query(`DELETE FROM product_package_lines WHERE package_product_id = $1`, [
        packageProductId,
      ]);
      await client.query(`UPDATE products SET kind = 'product' WHERE id = $1`, [packageProductId]);

      await this.sync.emit(client, {
        entity: SyncEntity.PRODUCTS,
        op: 'updated',
        entityId: packageProductId,
        locationId: null,
        actorUserId,
        data: { id: packageProductId, kind: 'product', packageLines: [] },
      });
      return { id: packageProductId, kind: 'product' };
    });
  }
}
