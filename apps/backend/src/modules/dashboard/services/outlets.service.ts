import { Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ERR_NOT_FOUND, type Money, type Qty } from '@mimi/shared';
import type { LocationScope } from '../../../common/scope/scope.service';
import { assertLocationInScope, scopeClause } from '../scope.util';

export interface OutletTile {
  locationId: string;
  name: string;
  city: string;
  revenue: Money;
  txCount: number;
  onlineNet: Money;
  openShifts: number;
  lowStockCount: number;
  offlineDevices: number;
  syncQueueDepth: number;
}

export interface OutletDrilldown extends OutletTile {
  hourlyTrend: { hour: number; revenue: Money }[];
  topProducts: { productId: string; name: string; qty: Qty; revenue: Money }[];
  staffOnShift: { employeeId: string; name: string; position: string }[];
}

/** FR-DASH-02/04 — per-outlet tiles (`/outlets`) and drill-down (`/outlet/:locationId`). */
@Injectable()
export class OutletsService {
  /**
   * ALL outlets the CALLER may see, one row each — CONTRACTS.md's "all
   * 15-20 outlets, one view" describes what a central-role (Owner/Manager)
   * caller gets BECAUSE their `locationScope` is `null`; a scoped caller
   * (e.g. Supervisor) still only sees rows for their own `locationScope` —
   * this is the exact same `scopeClause` every other endpoint here applies,
   * not an exemption (see ticket header).
   */
  async listOutlets(client: PoolClient, locationScope: LocationScope, date: string): Promise<OutletTile[]> {
    const params: unknown[] = [date];
    const scope = scopeClause(locationScope, 'l.id', params);

    const res = await client.query<{
      location_id: string;
      name: string;
      city: string;
      revenue: string;
      tx_count: string;
      online_net: string;
      open_shifts: string;
      low_stock_count: string;
      offline_devices: string;
      sync_queue_depth: string;
    }>(
      `SELECT
          l.id AS location_id, l.name, l.city,
          COALESCE(s.revenue, 0)::text AS revenue,
          COALESCE(s.tx_count, 0)::text AS tx_count,
          COALESCE(s.online_net, 0)::text AS online_net,
          COALESCE(sh.open_shifts, 0)::text AS open_shifts,
          COALESCE(ls.low_stock_count, 0)::text AS low_stock_count,
          COALESCE(dv.offline_devices, 0)::text AS offline_devices,
          COALESCE(dv.sync_queue_depth, 0)::text AS sync_queue_depth
        FROM locations l
        LEFT JOIN (
          SELECT location_id, SUM(gross) AS revenue, SUM(tx_count) AS tx_count,
                 SUM(gross) FILTER (WHERE platform IS NOT NULL) AS online_net
            FROM mv_sales_daily
           WHERE sales_date = $1
           GROUP BY location_id
        ) s ON s.location_id = l.id
        LEFT JOIN (
          SELECT location_id, COUNT(*) AS open_shifts FROM pos_shifts WHERE status = 'open' GROUP BY location_id
        ) sh ON sh.location_id = l.id
        LEFT JOIN (
          SELECT msr.location_id, COUNT(*) AS low_stock_count
            FROM min_stock_rules msr
            JOIN (
              SELECT location_id, item_id, SUM(qty_on_hand) AS qty_on_hand
                FROM stock_balances GROUP BY location_id, item_id
            ) bal ON bal.location_id = msr.location_id AND bal.item_id = msr.item_id
           WHERE msr.is_active AND bal.qty_on_hand < msr.min_qty
           GROUP BY msr.location_id
        ) ls ON ls.location_id = l.id
        LEFT JOIN (
          SELECT location_id,
                 COUNT(*) FILTER (WHERE status = 'offline') AS offline_devices,
                 COALESCE(SUM(queue_depth), 0) AS sync_queue_depth
            FROM devices
           WHERE status NOT IN ('unpaired', 'retired')
           GROUP BY location_id
        ) dv ON dv.location_id = l.id
       WHERE l.type = 'outlet' ${scope}
       ORDER BY l.name`,
      params,
    );

    return res.rows.map((r) => ({
      locationId: r.location_id,
      name: r.name,
      city: r.city,
      revenue: r.revenue as Money,
      txCount: parseInt(r.tx_count, 10),
      onlineNet: r.online_net as Money,
      openShifts: parseInt(r.open_shifts, 10),
      lowStockCount: parseInt(r.low_stock_count, 10),
      offlineDevices: parseInt(r.offline_devices, 10),
      syncQueueDepth: parseInt(r.sync_queue_depth, 10),
    }));
  }

  /** A scoped caller requesting a `:locationId` outside their scope 403s (CONTRACTS.md §4.18) — never a silent empty tile. */
  async getOutletDrilldown(
    client: PoolClient,
    locationScope: LocationScope,
    locationId: string,
    date: string,
  ): Promise<OutletDrilldown> {
    assertLocationInScope(locationScope, locationId);

    const tiles = await this.listOutletsUnfiltered(client, locationId, date);
    const tile = tiles[0];
    if (!tile) throw new NotFoundException({ code: ERR_NOT_FOUND, message: `Outlet ${locationId} not found` });

    const [hourlyTrend, topProducts, staffOnShift] = await Promise.all([
      this.hourlyTrend(client, locationId, date),
      this.topProductsForDay(client, locationId, date),
      this.staffOnShift(client, locationId, date),
    ]);

    return { ...tile, hourlyTrend, topProducts, staffOnShift };
  }

  /** Same tile shape as `listOutlets`, but for exactly one already-scope-checked location — no `scopeClause` needed since the caller already asserted it. */
  private async listOutletsUnfiltered(client: PoolClient, locationId: string, date: string): Promise<OutletTile[]> {
    const params: unknown[] = [date, locationId];
    const res = await client.query<{
      location_id: string;
      name: string;
      city: string;
      revenue: string;
      tx_count: string;
      online_net: string;
      open_shifts: string;
      low_stock_count: string;
      offline_devices: string;
      sync_queue_depth: string;
    }>(
      `SELECT
          l.id AS location_id, l.name, l.city,
          COALESCE(s.revenue, 0)::text AS revenue,
          COALESCE(s.tx_count, 0)::text AS tx_count,
          COALESCE(s.online_net, 0)::text AS online_net,
          COALESCE(sh.open_shifts, 0)::text AS open_shifts,
          COALESCE(ls.low_stock_count, 0)::text AS low_stock_count,
          COALESCE(dv.offline_devices, 0)::text AS offline_devices,
          COALESCE(dv.sync_queue_depth, 0)::text AS sync_queue_depth
        FROM locations l
        LEFT JOIN (
          SELECT location_id, SUM(gross) AS revenue, SUM(tx_count) AS tx_count,
                 SUM(gross) FILTER (WHERE platform IS NOT NULL) AS online_net
            FROM mv_sales_daily WHERE sales_date = $1 AND location_id = $2
           GROUP BY location_id
        ) s ON s.location_id = l.id
        LEFT JOIN (
          SELECT location_id, COUNT(*) AS open_shifts FROM pos_shifts WHERE status = 'open' AND location_id = $2 GROUP BY location_id
        ) sh ON sh.location_id = l.id
        LEFT JOIN (
          SELECT msr.location_id, COUNT(*) AS low_stock_count
            FROM min_stock_rules msr
            JOIN (
              SELECT location_id, item_id, SUM(qty_on_hand) AS qty_on_hand
                FROM stock_balances WHERE location_id = $2 GROUP BY location_id, item_id
            ) bal ON bal.location_id = msr.location_id AND bal.item_id = msr.item_id
           WHERE msr.is_active AND msr.location_id = $2 AND bal.qty_on_hand < msr.min_qty
           GROUP BY msr.location_id
        ) ls ON ls.location_id = l.id
        LEFT JOIN (
          SELECT location_id,
                 COUNT(*) FILTER (WHERE status = 'offline') AS offline_devices,
                 COALESCE(SUM(queue_depth), 0) AS sync_queue_depth
            FROM devices WHERE location_id = $2 AND status NOT IN ('unpaired', 'retired')
           GROUP BY location_id
        ) dv ON dv.location_id = l.id
       WHERE l.id = $2`,
      params,
    );

    return res.rows.map((r) => ({
      locationId: r.location_id,
      name: r.name,
      city: r.city,
      revenue: r.revenue as Money,
      txCount: parseInt(r.tx_count, 10),
      onlineNet: r.online_net as Money,
      openShifts: parseInt(r.open_shifts, 10),
      lowStockCount: parseInt(r.low_stock_count, 10),
      offlineDevices: parseInt(r.offline_devices, 10),
      syncQueueDepth: parseInt(r.sync_queue_depth, 10),
    }));
  }

  private async hourlyTrend(client: PoolClient, locationId: string, date: string): Promise<{ hour: number; revenue: Money }[]> {
    const res = await client.query<{ hour: string; revenue: string }>(
      `SELECT EXTRACT(HOUR FROM (occurred_at AT TIME ZONE 'Asia/Makassar'))::int AS hour,
              COALESCE(SUM(total), 0)::text AS revenue
         FROM sales
        WHERE location_id = $1 AND status = 'completed'
          AND (occurred_at AT TIME ZONE 'Asia/Makassar')::date = $2
        GROUP BY 1
        ORDER BY 1`,
      [locationId, date],
    );
    return res.rows.map((r) => ({ hour: parseInt(r.hour, 10), revenue: r.revenue as Money }));
  }

  private async topProductsForDay(client: PoolClient, locationId: string, date: string): Promise<{ productId: string; name: string; qty: Qty; revenue: Money }[]> {
    const res = await client.query<{ product_id: string; name: string; qty: string; revenue: string }>(
      `SELECT p.id AS product_id, p.name, SUM(sl.qty)::text AS qty, SUM(sl.line_total)::text AS revenue
         FROM sale_lines sl
         JOIN sales s ON s.id = sl.sale_id
         JOIN products p ON p.id = sl.product_id
        WHERE s.location_id = $1 AND s.status = 'completed'
          AND (s.occurred_at AT TIME ZONE 'Asia/Makassar')::date = $2
        GROUP BY p.id, p.name
        ORDER BY SUM(sl.line_total) DESC
        LIMIT 10`,
      [locationId, date],
    );
    return res.rows.map((r) => ({ productId: r.product_id, name: r.name, qty: r.qty as Qty, revenue: r.revenue as Money }));
  }

  private async staffOnShift(client: PoolClient, locationId: string, date: string): Promise<{ employeeId: string; name: string; position: string }[]> {
    const res = await client.query<{ employee_id: string; name: string; position: string }>(
      `SELECT DISTINCT e.id AS employee_id, e.name, e.position
         FROM shift_assignments sa
         JOIN employees e ON e.id = sa.employee_id
        WHERE sa.location_id = $1 AND sa.date = $2
        ORDER BY e.name`,
      [locationId, date],
    );
    return res.rows.map((r) => ({ employeeId: r.employee_id, name: r.name, position: r.position }));
  }
}
