import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { ISODate, Qty, UUID } from '@mimi/shared';

export interface DailyRecapItem {
  itemId: UUID;
  itemName: string;
  qty: Qty;
}

/**
 * One drop destination for the day. The recap screen filters on this grain, so
 * the counts are repeated here rather than left to the client to re-derive:
 * `sjCount` is DISTINCT Surat Jalan touching this outlet, not a share of the
 * city total — one multi-drop SJ legitimately counts for every outlet it visits,
 * which is why the per-outlet counts do not sum to the city's.
 */
export interface DailyRecapOutlet {
  locationId: UUID;
  locationName: string;
  sjCount: number;
  dropCount: number;
  frozenSjCount: number;
  drySjCount: number;
  items: DailyRecapItem[];
}

export interface DailyRecapCity {
  city: string;
  outlets: number;
  sjCount: number;
  dropCount: number;
  frozenSjCount: number;
  drySjCount: number;
  items: DailyRecapItem[];
  byOutlet: DailyRecapOutlet[];
}

export interface DailyRecap {
  date: ISODate;
  sjCount: number;
  dropCount: number;
  byCity: DailyRecapCity[];
  frozenSjCount: number;
  drySjCount: number;
}

interface OutletCountRow {
  city: string;
  location_id: string;
  location_name: string;
  sj_count: string;
  drop_count: string;
  frozen: string;
  dry: string;
}

interface CityCountRow {
  city: string;
  outlets: string;
  sj_count: string;
  drop_count: string;
  frozen: string;
  dry: string;
}

interface LineRow {
  city: string;
  location_id: string;
  item_id: string;
  item_name: string;
  qty: string;
}

/** Sum a per-item list into an accumulator keyed by item, preserving name-order later. */
function addItems(into: Map<string, DailyRecapItem>, rows: DailyRecapItem[]): void {
  for (const row of rows) {
    const seen = into.get(row.itemId);
    if (seen) seen.qty = String(Number(seen.qty) + Number(row.qty));
    else into.set(row.itemId, { ...row });
  }
}

function sortedByName(items: Iterable<DailyRecapItem>): DailyRecapItem[] {
  return [...items].sort((a, b) => a.itemName.localeCompare(b.itemName));
}

/** FR-LOG-04/08 — `GET /api/delivery/recap/daily`, the logistics team's daily shipment recap. */
@Injectable()
export class RecapService {
  async dailyRecap(client: PoolClient, date: ISODate): Promise<DailyRecap> {
    const sjRes = await client.query<{ count: string; frozen: string; dry: string }>(
      `SELECT
         COUNT(*) AS count,
         COUNT(*) FILTER (WHERE st.key = 'frozen') AS frozen,
         COUNT(*) FILTER (WHERE st.key = 'dry') AS dry
       FROM surat_jalan sj
       JOIN shipment_types st ON st.id = sj.shipment_type_id
       WHERE sj.planned_date = $1::date`,
      [date],
    );
    const sjRow = sjRes.rows[0]!;

    const dropCountRes = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM sj_drops d JOIN surat_jalan sj ON sj.id = d.sj_id WHERE sj.planned_date = $1::date`,
      [date],
    );

    // City counts are their own query rather than a fold of the outlet rows:
    // COUNT(DISTINCT sj.id) at city grain is NOT the sum of the per-outlet
    // distinct counts whenever one SJ drops at two outlets in the same city.
    const cityRes = await client.query<CityCountRow>(
      `SELECT l.city,
              COUNT(DISTINCT d.location_id) AS outlets,
              COUNT(DISTINCT sj.id) AS sj_count,
              COUNT(d.id) AS drop_count,
              COUNT(DISTINCT sj.id) FILTER (WHERE st.key = 'frozen') AS frozen,
              COUNT(DISTINCT sj.id) FILTER (WHERE st.key = 'dry') AS dry
         FROM sj_drops d
         JOIN surat_jalan sj ON sj.id = d.sj_id
         JOIN shipment_types st ON st.id = sj.shipment_type_id
         JOIN locations l ON l.id = d.location_id
        WHERE sj.planned_date = $1::date
        GROUP BY l.city
        ORDER BY l.city ASC`,
      [date],
    );

    const outletRes = await client.query<OutletCountRow>(
      `SELECT l.city, l.id AS location_id, l.name AS location_name,
              COUNT(DISTINCT sj.id) AS sj_count,
              COUNT(d.id) AS drop_count,
              COUNT(DISTINCT sj.id) FILTER (WHERE st.key = 'frozen') AS frozen,
              COUNT(DISTINCT sj.id) FILTER (WHERE st.key = 'dry') AS dry
         FROM sj_drops d
         JOIN surat_jalan sj ON sj.id = d.sj_id
         JOIN shipment_types st ON st.id = sj.shipment_type_id
         JOIN locations l ON l.id = d.location_id
        WHERE sj.planned_date = $1::date
        GROUP BY l.city, l.id, l.name
        ORDER BY l.city ASC, l.name ASC`,
      [date],
    );

    // One pass for every line on the day, at outlet+item grain; the city totals
    // are folded from it here instead of costing a query per city.
    const lineRes = await client.query<LineRow>(
      `SELECT l.city, l.id AS location_id, sl.item_id, i.name AS item_name, SUM(sl.qty) AS qty
         FROM sj_lines sl
         JOIN sj_drops d ON d.id = sl.drop_id
         JOIN surat_jalan sj ON sj.id = d.sj_id
         JOIN locations l ON l.id = d.location_id
         JOIN items i ON i.id = sl.item_id
        WHERE sj.planned_date = $1::date
        GROUP BY l.city, l.id, sl.item_id, i.name
        ORDER BY i.name ASC`,
      [date],
    );

    const linesByOutlet = new Map<string, DailyRecapItem[]>();
    for (const row of lineRes.rows) {
      const bucket = linesByOutlet.get(row.location_id) ?? [];
      bucket.push({ itemId: row.item_id, itemName: row.item_name, qty: row.qty });
      linesByOutlet.set(row.location_id, bucket);
    }

    const outletsByCity = new Map<string, DailyRecapOutlet[]>();
    for (const row of outletRes.rows) {
      const bucket = outletsByCity.get(row.city) ?? [];
      bucket.push({
        locationId: row.location_id,
        locationName: row.location_name,
        sjCount: Number.parseInt(row.sj_count, 10),
        dropCount: Number.parseInt(row.drop_count, 10),
        frozenSjCount: Number.parseInt(row.frozen, 10),
        drySjCount: Number.parseInt(row.dry, 10),
        items: linesByOutlet.get(row.location_id) ?? [],
      });
      outletsByCity.set(row.city, bucket);
    }

    const byCity: DailyRecapCity[] = cityRes.rows.map((cityRow) => {
      const byOutlet = outletsByCity.get(cityRow.city) ?? [];
      const cityItems = new Map<string, DailyRecapItem>();
      for (const outlet of byOutlet) addItems(cityItems, outlet.items);
      return {
        city: cityRow.city,
        outlets: Number.parseInt(cityRow.outlets, 10),
        sjCount: Number.parseInt(cityRow.sj_count, 10),
        dropCount: Number.parseInt(cityRow.drop_count, 10),
        frozenSjCount: Number.parseInt(cityRow.frozen, 10),
        drySjCount: Number.parseInt(cityRow.dry, 10),
        items: sortedByName(cityItems.values()),
        byOutlet,
      };
    });

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
