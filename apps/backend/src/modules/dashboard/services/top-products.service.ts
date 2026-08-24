import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { Money, Qty } from '@mimi/shared';
import type { LocationScope } from '../../../common/scope/scope.service';
import { assertLocationInScope, scopeClause } from '../scope.util';
import { witaDateRange } from '../../../kernel/time/wita-range.sql';

export interface TopProductRow {
  productId: string;
  name: string;
  qty: Qty;
  revenue: Money;
}

/**
 * FR-DASH-01/03 top produk — `mv_sales_daily` has no per-product grain
 * (contract: "you will need to join against live tables ... since
 * mv_sales_daily has no per-product grain"), so this reads `sale_lines`/
 * `sales` directly, scoped by `locationScope` (POS-only — online-order line
 * items are an optional, unvalidated JSONB blob with no FK to `products`,
 * so they cannot be joined into a per-product revenue ranking).
 */
@Injectable()
export class TopProductsService {
  async getTopProducts(
    client: PoolClient,
    locationScope: LocationScope,
    from: string,
    to: string,
    locationId: string | undefined,
    limit: number,
  ): Promise<TopProductRow[]> {
    assertLocationInScope(locationScope, locationId);

    const params: unknown[] = [from, to];
    let where = '';
    const scope = scopeClause(locationScope, 's.location_id', params);
    if (locationId) {
      params.push(locationId);
      where = ` AND s.location_id = $${params.length}`;
    }
    params.push(limit);

    const res = await client.query<{
      product_id: string;
      name: string;
      qty: string;
      revenue: string;
    }>(
      `SELECT p.id AS product_id, p.name, SUM(sl.qty)::text AS qty, SUM(sl.line_total)::text AS revenue
         FROM sale_lines sl
         JOIN sales s ON s.id = sl.sale_id
         JOIN products p ON p.id = sl.product_id
        WHERE s.status = 'completed'
          AND ${witaDateRange('s.occurred_at', 1, 2)}
          ${scope}${where}
        GROUP BY p.id, p.name
        ORDER BY SUM(sl.line_total) DESC
        LIMIT $${params.length}`,
      params,
    );

    return res.rows.map((r) => ({
      productId: r.product_id,
      name: r.name,
      qty: r.qty as Qty,
      revenue: r.revenue as Money,
    }));
  }
}
