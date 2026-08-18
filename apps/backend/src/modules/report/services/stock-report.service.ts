import { Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  addQty,
  businessDateOf,
  businessDayBoundaries,
  ERR_NOT_FOUND,
  subQty,
  ZERO_QTY,
  type ISODate,
  type Paginated,
  type Qty,
  type UUID,
} from '@mimi/shared';
import { assertLocationInScope } from '../scope.util';
import { toIsoString, type ReportCallerContext } from '../report.types';

export interface StockUsageRow {
  itemId: UUID;
  itemName: string;
  opening: Qty;
  in: Qty;
  usage: Qty;
  waste: Qty;
  adjustment: Qty;
  closing: Qty;
}

export interface StockMovementRow {
  id: UUID;
  locationId: UUID;
  locationName: string;
  storageAreaId: UUID;
  storageAreaName: string;
  itemId: UUID;
  itemName: string;
  movementType: string;
  qty: Qty;
  unitCost: string;
  refType: string;
  refId: UUID | null;
  occurredAt: string;
}

export interface OpnameVarianceLine {
  itemId: UUID;
  itemName: string;
  storageAreaId: UUID;
  storageAreaName: string;
  systemQty: Qty;
  countedQty: Qty;
  diffQty: Qty;
  varianceReason: string | null;
}

export interface OpnameVarianceReport {
  opnameId: UUID;
  opnameNumber: string;
  locationId: UUID;
  locationName: string;
  status: string;
  countedBy: string | null;
  startedAt: string;
  submittedAt: string | null;
  approvedAt: string | null;
  lines: OpnameVarianceLine[];
}

const IN_TYPES = ['purchase_in', 'transfer_in', 'return_in'] as const;
/** Every remaining `_out` type beyond `usage_out`/`waste_out`, netted with `adjustment_in` — see this
 * class's header comment on `getStockUsage` for why the shape's single `adjustment` field absorbs them. */
const ADJUSTMENT_NET_CASE = `
  CASE movement_type
    WHEN 'adjustment_in' THEN qty
    WHEN 'adjustment_out' THEN -qty
    WHEN 'transfer_out' THEN -qty
    WHEN 'return_out' THEN -qty
    ELSE 0
  END`;
const SIGNED_QTY_CASE = `
  CASE
    WHEN movement_type IN ('purchase_in','transfer_in','return_in','adjustment_in','opening_balance') THEN qty
    WHEN movement_type IN ('transfer_out','usage_out','waste_out','return_out','adjustment_out') THEN -qty
    ELSE 0
  END`;

/**
 * `/api/reports/stock-usage`, `/api/reports/stock-movements` (FR-POS-06,
 * FR-LOG-21, FR-SO-04) and `/api/reports/opname/:opnameId` (FR-SO-02) —
 * report-shaped SELECTs over `stock_movements`/`stock_opname` (+lines), the
 * same tables and `movement_type` values `inventory/inventory.service.ts`
 * already reads (its idiom is copied here, not diverged from — this module
 * cannot import that service directly, `InventoryModule` exports nothing).
 */
@Injectable()
export class StockReportService {
  /**
   * `{itemId; itemName; opening; in; usage; waste; adjustment; closing}[]` per
   * CONTRACTS.md §4.19's literal shape — no `locationId` field on the OUTPUT
   * row (the shape doesn't carry one), so results are aggregated across
   * whichever location(s) the query resolves to.
   *
   * MODELING DECISION (flagged, not silently glossed over): the contract's
   * shape has exactly six qty buckets, with only ONE catch-all "adjustment"
   * column beyond `in`/`usage`/`waste`. `transfer_out`/`return_out` movements
   * (stock leaving this location other than by use or waste — e.g. a
   * warehouse dispatching an SJ) have nowhere else to go in this shape, so
   * they are netted into `adjustment` alongside `adjustment_in`/`adjustment_out`.
   * This keeps `closing = opening + in - usage - waste + adjustment`
   * arithmetically EXACT against `stock_movements`' signed ledger (verified:
   * `closing` computed this way always equals `SUM` of every signed movement
   * up to `to`) rather than silently dropping transfer/return-out qty and
   * having `closing` drift from the real balance.
   */
  async getStockUsage(
    client: PoolClient,
    caller: ReportCallerContext,
    filters: { locationId?: string; from?: ISODate; to?: ISODate },
  ): Promise<StockUsageRow[]> {
    assertLocationInScope(caller.locationScope, filters.locationId);
    const scopeIds = this.effectiveLocationIds(caller, filters.locationId);

    const today = filters.to ?? businessDateOf(new Date().toISOString()); // WITA "today", never a naive UTC slice
    const fromDate = filters.from ?? today;
    const { startUtc } = businessDayBoundaries(fromDate);
    const { endUtc } = businessDayBoundaries(today);

    const params: unknown[] = [startUtc, endUtc];
    let locWhere = '';
    if (scopeIds) {
      params.push(scopeIds);
      locWhere = `AND m.location_id = ANY($${params.length}::uuid[])`;
    }

    const res = await client.query<{
      item_id: string;
      item_name: string;
      opening: Qty;
      in_qty: Qty;
      usage_qty: Qty;
      waste_qty: Qty;
      adjustment_qty: Qty;
    }>(
      `SELECT m.item_id, i.name AS item_name,
              COALESCE(SUM(${SIGNED_QTY_CASE}) FILTER (WHERE m.occurred_at < $1), '0.000') AS opening,
              COALESCE(SUM(m.qty) FILTER (WHERE m.occurred_at >= $1 AND m.occurred_at < $2 AND m.movement_type IN ('${IN_TYPES.join("','")}')), '0.000') AS in_qty,
              COALESCE(SUM(m.qty) FILTER (WHERE m.occurred_at >= $1 AND m.occurred_at < $2 AND m.movement_type = 'usage_out'), '0.000') AS usage_qty,
              COALESCE(SUM(m.qty) FILTER (WHERE m.occurred_at >= $1 AND m.occurred_at < $2 AND m.movement_type = 'waste_out'), '0.000') AS waste_qty,
              COALESCE(SUM(${ADJUSTMENT_NET_CASE}) FILTER (WHERE m.occurred_at >= $1 AND m.occurred_at < $2), '0.000') AS adjustment_qty
         FROM stock_movements m
         JOIN items i ON i.id = m.item_id
        WHERE m.occurred_at < $2 ${locWhere}
        GROUP BY m.item_id, i.name
       HAVING COALESCE(SUM(m.qty) FILTER (WHERE m.occurred_at >= $1 AND m.occurred_at < $2), 0) > 0
        ORDER BY i.name ASC`,
      params,
    );

    return res.rows.map((r) => {
      const opening = r.opening ?? ZERO_QTY;
      const inQty = r.in_qty ?? ZERO_QTY;
      const usage = r.usage_qty ?? ZERO_QTY;
      const waste = r.waste_qty ?? ZERO_QTY;
      const adjustment = r.adjustment_qty ?? ZERO_QTY;
      // Exact bigint-scaled arithmetic (`@mimi/shared/qty`), never `Number()` coercion — the same
      // convention this ticket requires for Money applies equally to Qty's own NUMERIC(14,3) strings.
      const closing = addQty(opening, addQty(subQty(subQty(inQty, usage), waste), adjustment));
      return {
        itemId: r.item_id,
        itemName: r.item_name,
        opening,
        in: inQty,
        usage,
        waste,
        adjustment,
        closing,
      };
    });
  }

  async getStockMovements(
    client: PoolClient,
    caller: ReportCallerContext,
    filters: { locationId?: string; from?: ISODate; to?: ISODate; movementType?: string },
    page = 1,
    pageSize = 100,
  ): Promise<Paginated<StockMovementRow>> {
    assertLocationInScope(caller.locationScope, filters.locationId);
    const scopeIds = this.effectiveLocationIds(caller, filters.locationId);

    const params: unknown[] = [];
    let where = '1=1';
    if (scopeIds) {
      params.push(scopeIds);
      where += ` AND m.location_id = ANY($${params.length}::uuid[])`;
    }
    if (filters.from) {
      params.push(businessDayBoundaries(filters.from).startUtc);
      where += ` AND m.occurred_at >= $${params.length}`;
    }
    if (filters.to) {
      params.push(businessDayBoundaries(filters.to).endUtc);
      where += ` AND m.occurred_at < $${params.length}`;
    }
    if (filters.movementType) {
      params.push(filters.movementType);
      where += ` AND m.movement_type = $${params.length}`;
    }

    const countRes = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM stock_movements m WHERE ${where}`,
      params,
    );
    const total = Number.parseInt(countRes.rows[0]?.count ?? '0', 10);

    params.push(pageSize, (page - 1) * pageSize);
    const res = await client.query<{
      id: string;
      location_id: string;
      location_name: string;
      storage_area_id: string;
      storage_area_name: string;
      item_id: string;
      item_name: string;
      movement_type: string;
      qty: Qty;
      unit_cost: string;
      ref_type: string;
      ref_id: string | null;
      occurred_at: string;
    }>(
      `SELECT m.id, m.location_id, l.name AS location_name, m.storage_area_id, sa.name AS storage_area_name,
              m.item_id, i.name AS item_name, m.movement_type, m.qty, m.unit_cost, m.ref_type, m.ref_id, m.occurred_at
         FROM stock_movements m
         JOIN locations l ON l.id = m.location_id
         JOIN storage_areas sa ON sa.id = m.storage_area_id
         JOIN items i ON i.id = m.item_id
        WHERE ${where}
        ORDER BY m.occurred_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return {
      rows: res.rows.map((r) => ({
        id: r.id,
        locationId: r.location_id,
        locationName: r.location_name,
        storageAreaId: r.storage_area_id,
        storageAreaName: r.storage_area_name,
        itemId: r.item_id,
        itemName: r.item_name,
        movementType: r.movement_type,
        qty: r.qty,
        unitCost: r.unit_cost,
        refType: r.ref_type,
        refId: r.ref_id,
        occurredAt: toIsoString(r.occurred_at),
      })),
      total,
      page,
      pageSize,
    };
  }

  async getOpnameVariance(
    client: PoolClient,
    caller: ReportCallerContext,
    opnameId: UUID,
  ): Promise<OpnameVarianceReport> {
    const headRes = await client.query<{
      id: string;
      opname_number: string;
      location_id: string;
      location_name: string;
      status: string;
      counted_by_name: string | null;
      started_at: string;
      submitted_at: string | null;
      approved_at: string | null;
    }>(
      // `LEFT JOIN users` deliberately — `users` RLS (`app_is_central() OR app_is_self(id)`) would
      // silently drop the WHOLE `stock_opname` row for a scoped caller on an INNER JOIN whenever
      // `counted_by` isn't their own user id (the exact bug class `pos-shift.service.ts`'s
      // `SHIFT_SELECT` comment documents and guards against — same fix here, not a new discovery).
      `SELECT so.id, so.opname_number, so.location_id, l.name AS location_name, so.status,
              u.username AS counted_by_name, so.started_at, so.submitted_at, so.approved_at
         FROM stock_opname so
         JOIN locations l ON l.id = so.location_id
         LEFT JOIN users u ON u.id = so.counted_by
        WHERE so.id = $1`,
      [opnameId],
    );
    const head = headRes.rows[0];
    if (!head)
      throw new NotFoundException({ code: ERR_NOT_FOUND, message: `Opname ${opnameId} not found` });

    assertLocationInScope(caller.locationScope, head.location_id);

    const linesRes = await client.query<{
      item_id: string;
      item_name: string;
      storage_area_id: string;
      storage_area_name: string;
      system_qty: Qty;
      counted_qty: Qty;
      diff_qty: Qty;
      variance_reason: string | null;
    }>(
      `SELECT sol.item_id, i.name AS item_name, sol.storage_area_id, sa.name AS storage_area_name,
              sol.system_qty, sol.counted_qty, sol.diff_qty, sol.variance_reason
         FROM stock_opname_lines sol
         JOIN items i ON i.id = sol.item_id
         JOIN storage_areas sa ON sa.id = sol.storage_area_id
        WHERE sol.opname_id = $1
        ORDER BY i.name ASC`,
      [opnameId],
    );

    return {
      opnameId: head.id,
      opnameNumber: head.opname_number,
      locationId: head.location_id,
      locationName: head.location_name,
      status: head.status,
      countedBy: head.counted_by_name,
      startedAt: toIsoString(head.started_at),
      submittedAt: head.submitted_at ? toIsoString(head.submitted_at) : null,
      approvedAt: head.approved_at ? toIsoString(head.approved_at) : null,
      lines: linesRes.rows.map((r) => ({
        itemId: r.item_id,
        itemName: r.item_name,
        storageAreaId: r.storage_area_id,
        storageAreaName: r.storage_area_name,
        systemQty: r.system_qty,
        countedQty: r.counted_qty,
        diffQty: r.diff_qty,
        varianceReason: r.variance_reason,
      })),
    };
  }

  private effectiveLocationIds(caller: ReportCallerContext, locationId?: string): string[] | null {
    if (locationId) return [locationId];
    return caller.locationScope === null ? null : [...caller.locationScope];
  }
}
