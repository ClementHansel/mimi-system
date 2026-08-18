import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  addQty,
  businessDayBoundaries,
  subQty,
  type ISODate,
  type Qty,
  type UUID,
} from '@mimi/shared';

export interface DailyStockRow {
  itemId: UUID;
  itemName: string;
  unitCode: string;
  opening: Qty;
  received: Qty;
  estimatedUsage: Qty;
  waste: Qty;
  closing: Qty;
}

/**
 * `GET /api/pos/daily-stock` — FR-POS-06. Queries `stock_movements` directly
 * (never `stock_balances` snapshots, which are only current-moment) rather
 * than the `mv_item_usage_daily` materialized view CONTRACTS.md mentions
 * alongside it: that view is refreshed on a 5-minute scheduler this module
 * does not own, so depending on it for a same-day report risks a stale
 * "usage" figure for the outlet's most recent sales. Movements are always
 * current and RLS-scoped identically.
 */
@Injectable()
export class PosDailyStockService {
  async getReport(client: PoolClient, locationId: UUID, date: ISODate): Promise<DailyStockRow[]> {
    const { startUtc, endUtc } = businessDayBoundaries(date);

    const res = await client.query<{
      item_id: UUID;
      item_name: string;
      unit_code: string;
      opening: Qty;
      received: Qty;
      estimated_usage: Qty;
      waste: Qty;
    }>(
      `SELECT
         i.id AS item_id,
         i.name AS item_name,
         u.code AS unit_code,
         COALESCE(SUM(CASE WHEN sm.occurred_at < $2 THEN
           CASE WHEN sm.movement_type LIKE '%_in' THEN sm.qty ELSE -sm.qty END
         ELSE 0 END), 0) AS opening,
         COALESCE(SUM(CASE WHEN sm.occurred_at >= $2 AND sm.occurred_at < $3 AND sm.movement_type IN ('purchase_in','transfer_in') THEN sm.qty ELSE 0 END), 0) AS received,
         COALESCE(SUM(CASE WHEN sm.occurred_at >= $2 AND sm.occurred_at < $3 AND sm.movement_type = 'usage_out' THEN sm.qty ELSE 0 END), 0) AS estimated_usage,
         COALESCE(SUM(CASE WHEN sm.occurred_at >= $2 AND sm.occurred_at < $3 AND sm.movement_type = 'waste_out' THEN sm.qty ELSE 0 END), 0) AS waste
       FROM stock_movements sm
       JOIN items i ON i.id = sm.item_id
       JOIN units u ON u.id = i.base_unit_id
       WHERE sm.location_id = $1 AND sm.occurred_at < $3
       GROUP BY i.id, i.name, u.code
       HAVING SUM(CASE WHEN sm.occurred_at >= $2 AND sm.occurred_at < $3 THEN 1 ELSE 0 END) > 0
       ORDER BY i.name`,
      [locationId, startUtc, endUtc],
    );

    return res.rows.map((r) => {
      const opening = r.opening;
      // D-10: decimal-string arithmetic only, never a JS float — `Number(...).toFixed()` would
      // silently drift for large/precise quantities.
      const closing = subQty(subQty(addQty(opening, r.received), r.estimated_usage), r.waste);
      return {
        itemId: r.item_id,
        itemName: r.item_name,
        unitCode: r.unit_code,
        opening,
        received: r.received,
        estimatedUsage: r.estimated_usage,
        waste: r.waste,
        closing,
      };
    });
  }
}
