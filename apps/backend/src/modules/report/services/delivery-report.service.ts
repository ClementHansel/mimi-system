import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { ISODate, Qty, UUID } from '@mimi/shared';
import type { ReportCallerContext } from '../report.types';

export interface DeliveryRecapItem {
  itemId: UUID;
  itemName: string;
  qty: Qty;
}

export interface DeliveryRecapCity {
  city: string;
  outlets: number;
  items: DeliveryRecapItem[];
}

export interface DeliveryRecapReport {
  date: ISODate;
  sjCount: number;
  dropCount: number;
  byCity: DeliveryRecapCity[];
  frozenSjCount: number;
  drySjCount: number;
}

/**
 * `/api/reports/delivery-daily` — FR-LOG-04/08, rekap harian tim logistik.
 * Matches `delivery/services/recap.service.ts`'s `DailyRecap` shape EXACTLY
 * (grepped and copied field-for-field per the ticket instruction — "don't
 * invent a new shape"), but this module cannot import that service (`delivery`
 * exports nothing to other modules) so the query logic is reproduced here.
 *
 * Reads `surat_jalan`/`sj_drops`/`sj_lines` DIRECTLY rather than
 * `mv_delivery_recap_daily`, despite the ticket's data-source note pointing at
 * that matview: the matview's grain is `(planned_date, city, shipment_type,
 * item_id)` with `COUNT(DISTINCT sj.id)` computed PER ITEM ROW. A single SJ
 * carrying several line items appears in several of those item-grain rows, so
 * summing `sj_count`/`drop_count` across items to get a city- or date-level
 * total would OVER-COUNT the very same SJ once per distinct item on it —
 * silently wrong output, not a shortcut. The base-table join below computes
 * `COUNT(DISTINCT ...)` at the actual city/date grain this report needs,
 * exactly like `RecapService.dailyRecap` does. `planned_date` is already a
 * plain `DATE` column (not a timestamp) — no WITA bucketing is needed to key
 * off it, unlike `occurred_at`-based tables.
 *
 * Location-scoped explicitly (via `d.location_id`) because `surat_jalan`
 * itself is not the row a Supervisor's location grant is written against —
 * `sj_drops.location_id` is (D-14's "who received it" side).
 */
@Injectable()
export class DeliveryReportService {
  async getDailyRecap(
    client: PoolClient,
    caller: ReportCallerContext,
    date: ISODate,
  ): Promise<DeliveryRecapReport> {
    const scopeIds = caller.locationScope;

    const scopeWhere = scopeIds !== null ? `AND d.location_id = ANY($2::uuid[])` : '';
    const scopeParams = scopeIds !== null ? [[...scopeIds]] : [];

    const sjRes = await client.query<{ count: string; frozen: string; dry: string }>(
      `SELECT
         COUNT(DISTINCT sj.id) AS count,
         COUNT(DISTINCT sj.id) FILTER (WHERE st.key = 'frozen') AS frozen,
         COUNT(DISTINCT sj.id) FILTER (WHERE st.key = 'dry') AS dry
       FROM surat_jalan sj
       JOIN shipment_types st ON st.id = sj.shipment_type_id
       JOIN sj_drops d ON d.sj_id = sj.id
       WHERE sj.planned_date = $1::date ${scopeWhere}`,
      [date, ...scopeParams],
    );
    const sjRow = sjRes.rows[0]!;

    const dropCountRes = await client.query<{ count: string }>(
      `SELECT COUNT(DISTINCT d.id) AS count
         FROM sj_drops d JOIN surat_jalan sj ON sj.id = d.sj_id
        WHERE sj.planned_date = $1::date ${scopeWhere}`,
      [date, ...scopeParams],
    );

    const cityRes = await client.query<{ city: string; outlets: string }>(
      `SELECT l.city, COUNT(DISTINCT d.location_id) AS outlets
         FROM sj_drops d
         JOIN surat_jalan sj ON sj.id = d.sj_id
         JOIN locations l ON l.id = d.location_id
        WHERE sj.planned_date = $1::date ${scopeWhere}
        GROUP BY l.city
        ORDER BY l.city ASC`,
      [date, ...scopeParams],
    );

    const byCity: DeliveryRecapCity[] = [];
    for (const cityRow of cityRes.rows) {
      const itemParams: unknown[] = [date, cityRow.city];
      let itemScopeWhere = '';
      if (scopeIds !== null) {
        itemParams.push([...scopeIds]);
        itemScopeWhere = `AND d.location_id = ANY($3::uuid[])`;
      }
      const itemsRes = await client.query<{ item_id: string; item_name: string; qty: string }>(
        `SELECT sl.item_id, i.name AS item_name, SUM(sl.qty) AS qty
           FROM sj_lines sl
           JOIN sj_drops d ON d.id = sl.drop_id
           JOIN surat_jalan sj ON sj.id = d.sj_id
           JOIN locations l ON l.id = d.location_id
           JOIN items i ON i.id = sl.item_id
          WHERE sj.planned_date = $1::date AND l.city = $2 ${itemScopeWhere}
          GROUP BY sl.item_id, i.name
          ORDER BY i.name ASC`,
        itemParams,
      );
      byCity.push({
        city: cityRow.city,
        outlets: Number.parseInt(cityRow.outlets, 10),
        items: itemsRes.rows.map((r) => ({ itemId: r.item_id, itemName: r.item_name, qty: r.qty })),
      });
    }

    // `?locationId=` has no meaning for this endpoint (CONTRACTS.md §4.19 only lists `?date=` —
    // grain is destination CITY, per `mv_delivery_recap_daily`'s own doc comment, not location).
    // Scope enforcement is applied above via `d.location_id` directly (every query's `scopeWhere`),
    // which is why there is no single `locationId` param to run `assertLocationInScope` against here.
    return {
      date,
      sjCount: Number.parseInt(sjRow.count, 10),
      dropCount: Number.parseInt(dropCountRes.rows[0]?.count ?? '0', 10),
      byCity,
      frozenSjCount: Number.parseInt(sjRow.frozen, 10),
      drySjCount: Number.parseInt(sjRow.dry, 10),
    };
  }
}
