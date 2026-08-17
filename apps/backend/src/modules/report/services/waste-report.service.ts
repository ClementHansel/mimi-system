import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { businessDayBoundaries, ZERO_MONEY, ZERO_QTY, type ISODate, type Money, type Qty, type UUID } from '@mimi/shared';
import { assertLocationInScope } from '../scope.util';
import type { ReportCallerContext } from '../report.types';

export interface WasteReportRow {
  locationId: UUID;
  locationName: string;
  reason: string;
  count: number;
  qty: Qty;
  value: Money;
}

/**
 * `/api/reports/waste` (FR-WST-04) — waste by reason/location with values.
 * `value` = `SUM(qty * unit_cost)` computed IN Postgres as `NUMERIC` (exact
 * decimal arithmetic, no JS float ever touches it — `unit_cost` is the
 * item's `avg_cost` AT APPROVAL time per `080_waste_records.sql`'s own
 * comment). Includes every status (`pending`/`approved`/`rejected`) — a
 * report on what was RECORDED, not only what already posted to the stock
 * ledger; callers wanting posted-only can already see that on
 * `stock_movements` (`ref_type = 'waste_record'`) via `/api/reports/stock-movements`.
 */
@Injectable()
export class WasteReportService {
  async getWasteReport(
    client: PoolClient,
    caller: ReportCallerContext,
    filters: { from?: ISODate; to?: ISODate; locationId?: string },
  ): Promise<WasteReportRow[]> {
    assertLocationInScope(caller.locationScope, filters.locationId);

    const params: unknown[] = [];
    let where = '1=1';
    if (filters.from) {
      params.push(businessDayBoundaries(filters.from).startUtc);
      where += ` AND w.occurred_at >= $${params.length}`;
    }
    if (filters.to) {
      params.push(businessDayBoundaries(filters.to).endUtc);
      where += ` AND w.occurred_at < $${params.length}`;
    }
    if (filters.locationId) {
      params.push(filters.locationId);
      where += ` AND w.location_id = $${params.length}`;
    } else if (caller.locationScope !== null) {
      params.push([...caller.locationScope]);
      where += ` AND w.location_id = ANY($${params.length}::uuid[])`;
    }

    const res = await client.query<{
      location_id: string;
      location_name: string;
      reason: string;
      count: string;
      qty: Qty;
      value: Money;
    }>(
      `SELECT w.location_id, l.name AS location_name, w.reason, COUNT(*)::int AS count,
              COALESCE(SUM(w.qty), '0.000') AS qty,
              COALESCE(ROUND(SUM(w.qty * w.unit_cost), 2), '0.00') AS value
         FROM waste_records w
         JOIN locations l ON l.id = w.location_id
        WHERE ${where}
        GROUP BY w.location_id, l.name, w.reason
        ORDER BY l.name ASC, w.reason ASC`,
      params,
    );

    return res.rows.map((r) => ({
      locationId: r.location_id,
      locationName: r.location_name,
      reason: r.reason,
      count: Number.parseInt(r.count as unknown as string, 10),
      qty: r.qty ?? ZERO_QTY,
      value: r.value ?? ZERO_MONEY,
    }));
  }
}
