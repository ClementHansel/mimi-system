import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { ISODate, Qty, UUID } from '@mimi/shared';

export interface DailyRecapItem {
  itemId: UUID;
  itemName: string;
  qty: Qty;
}

export interface DailyRecapCity {
  city: string;
  outlets: number;
  items: DailyRecapItem[];
}

export interface DailyRecap {
  date: ISODate;
  sjCount: number;
  dropCount: number;
  byCity: DailyRecapCity[];
  frozenSjCount: number;
  drySjCount: number;
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

    const cityRes = await client.query<{ city: string; outlets: string }>(
      `SELECT l.city, COUNT(DISTINCT d.location_id) AS outlets
         FROM sj_drops d
         JOIN surat_jalan sj ON sj.id = d.sj_id
         JOIN locations l ON l.id = d.location_id
        WHERE sj.planned_date = $1::date
        GROUP BY l.city
        ORDER BY l.city ASC`,
      [date],
    );

    const byCity: DailyRecapCity[] = [];
    for (const cityRow of cityRes.rows) {
      const itemsRes = await client.query<{ item_id: string; item_name: string; qty: string }>(
        `SELECT sl.item_id, i.name AS item_name, SUM(sl.qty) AS qty
           FROM sj_lines sl
           JOIN sj_drops d ON d.id = sl.drop_id
           JOIN surat_jalan sj ON sj.id = d.sj_id
           JOIN locations l ON l.id = d.location_id
           JOIN items i ON i.id = sl.item_id
          WHERE sj.planned_date = $1::date AND l.city = $2
          GROUP BY sl.item_id, i.name
          ORDER BY i.name ASC`,
        [date, cityRow.city],
      );
      byCity.push({
        city: cityRow.city,
        outlets: Number.parseInt(cityRow.outlets, 10),
        items: itemsRes.rows.map((r) => ({ itemId: r.item_id, itemName: r.item_name, qty: r.qty })),
      });
    }

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
