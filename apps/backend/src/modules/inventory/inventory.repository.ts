import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { Money, Movement, Qty, UUID } from '@mimi/shared';
import { ZERO_QTY } from '@mimi/shared';

import type { MinStockRuleRow } from './types';

/** Raw row shape from the `balances` query — one row per `(location, storage_area, item)`, CONTRACTS.md §4.7's `Balance` minus the caller-conditional `value` field (computed in the service from `avgCost`). */
export interface BalanceRow {
  locationId: UUID;
  storageAreaId: UUID;
  storageAreaName: string;
  storageAreaType: string;
  itemId: UUID;
  sku: string;
  itemName: string;
  unitCode: string;
  qtyOnHand: Qty;
  minQty: Qty | null;
  belowMin: boolean;
  avgCost: Money;
}

export interface ListBalancesFilters {
  locationId?: string;
  storageAreaId?: string;
  itemId?: string;
  belowMin?: boolean;
  q?: string;
}

export interface ListMovementsFilters {
  locationId?: string;
  itemId?: string;
  storageAreaId?: string;
  movementType?: string;
  /** `'YYYY-MM-DD'`, inclusive lower bound. */
  from?: string;
  /** `'YYYY-MM-DD'`, inclusive upper bound. */
  to?: string;
}

interface Pagination {
  page: number;
  pageSize: number;
}

function paginationOf(page?: number, pageSize?: number): Pagination {
  return {
    page: page && page > 0 ? page : 1,
    pageSize: pageSize && pageSize > 0 ? Math.min(pageSize, 200) : 50,
  };
}

/** `WHERE`-clause builder shared by every filtered list query in this repository — same pattern as `kernel/audit`'s `AuditService.query`. */
class ConditionBuilder {
  private readonly conditions: string[] = [];
  readonly params: unknown[] = [];

  eq(column: string, value: unknown): void {
    if (value === undefined || value === null) return;
    this.params.push(value);
    this.conditions.push(`${column} = $${this.params.length}`);
  }

  /** Same bound value referenced twice (`ILIKE` over two columns). */
  ilikeEither(columnA: string, columnB: string, value: string | undefined): void {
    if (!value) return;
    this.params.push(`%${value}%`);
    const idx = this.params.length;
    this.conditions.push(`(${columnA} ILIKE $${idx} OR ${columnB} ILIKE $${idx})`);
  }

  gte(column: string, value: string | undefined): void {
    if (!value) return;
    this.params.push(value);
    this.conditions.push(`${column} >= $${this.params.length}::date`);
  }

  /** `< (value + 1 day)` so the bound is inclusive of the whole `to` calendar day, not just its midnight instant. */
  lte(column: string, value: string | undefined): void {
    if (!value) return;
    this.params.push(value);
    this.conditions.push(`${column} < ($${this.params.length}::date + INTERVAL '1 day')`);
  }

  where(): string {
    return this.conditions.length ? `WHERE ${this.conditions.join(' AND ')}` : '';
  }

  /** For appending to a query that already has its own fixed `WHERE ...` conditions — `''` if nothing dynamic was added, else `AND <dynamic conditions>`. */
  extraAnd(): string {
    return this.conditions.length ? `AND ${this.conditions.join(' AND ')}` : '';
  }

  nextParamIndex(): number {
    return this.params.length + 1;
  }
}

@Injectable()
export class InventoryRepository {
  // ── GET /balances ───────────────────────────────────────────────────────
  async listBalances(
    client: PoolClient,
    filters: ListBalancesFilters,
    page?: number,
    pageSize?: number,
  ): Promise<{ rows: BalanceRow[]; total: number; page: number; pageSize: number }> {
    const { page: p, pageSize: ps } = paginationOf(page, pageSize);
    const b = new ConditionBuilder();
    b.eq('location_id', filters.locationId);
    b.eq('storage_area_id', filters.storageAreaId);
    b.eq('item_id', filters.itemId);
    b.ilikeEither('item_name', 'sku', filters.q);
    if (filters.belowMin !== undefined) b.eq('below_min', filters.belowMin);

    const limitIdx = b.nextParamIndex();
    const offsetIdx = limitIdx + 1;

    const res = await client.query<{
      location_id: string;
      storage_area_id: string;
      storage_area_name: string;
      storage_area_type: string;
      item_id: string;
      sku: string;
      item_name: string;
      unit_code: string;
      qty_on_hand: string;
      min_qty: string | null;
      below_min: boolean;
      avg_cost: string;
      full_count: string;
    }>(
      `WITH totals AS (
         SELECT location_id, item_id, SUM(qty_on_hand) AS qty_total
           FROM stock_balances
          GROUP BY location_id, item_id
       ),
       calc AS (
         SELECT
           b.location_id, b.storage_area_id, sa.name AS storage_area_name, sa.type AS storage_area_type,
           b.item_id, i.sku, i.name AS item_name, u.code AS unit_code, b.qty_on_hand, i.avg_cost,
           msr.min_qty,
           (msr.min_qty IS NOT NULL AND COALESCE(t.qty_total, 0) < msr.min_qty) AS below_min
         FROM stock_balances b
         JOIN storage_areas sa ON sa.id = b.storage_area_id
         JOIN items i ON i.id = b.item_id
         JOIN units u ON u.id = i.base_unit_id
         LEFT JOIN min_stock_rules msr
           ON msr.location_id = b.location_id AND msr.item_id = b.item_id AND msr.is_active = true
         LEFT JOIN totals t ON t.location_id = b.location_id AND t.item_id = b.item_id
       )
       SELECT *, COUNT(*) OVER() AS full_count
         FROM calc
         ${b.where()}
        ORDER BY item_name, storage_area_type, storage_area_name
        LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      [...b.params, ps, (p - 1) * ps],
    );

    const total = res.rows.length > 0 ? Number(res.rows[0]!.full_count) : 0;
    const rows: BalanceRow[] = res.rows.map((r) => ({
      locationId: r.location_id,
      storageAreaId: r.storage_area_id,
      storageAreaName: r.storage_area_name,
      storageAreaType: r.storage_area_type,
      itemId: r.item_id,
      sku: r.sku,
      itemName: r.item_name,
      unitCode: r.unit_code,
      qtyOnHand: r.qty_on_hand,
      minQty: r.min_qty,
      belowMin: r.below_min,
      avgCost: r.avg_cost,
    }));
    return { rows, total, page: p, pageSize: ps };
  }

  // ── GET /summary ────────────────────────────────────────────────────────
  async getSummaryTotals(
    client: PoolClient,
    locationId: string | undefined,
  ): Promise<{ totalItems: number; belowMin: number; stockValue: Money }> {
    const b = new ConditionBuilder();
    b.eq('b.location_id', locationId);
    const res = await client.query<{ total_items: string; below_min: string; stock_value: string }>(
      `WITH totals AS (
         SELECT location_id, item_id, SUM(qty_on_hand) AS qty_total
           FROM stock_balances b
           ${b.where()}
          GROUP BY location_id, item_id
       )
       SELECT
         COUNT(*)::int AS total_items,
         COUNT(*) FILTER (WHERE msr.min_qty IS NOT NULL AND t.qty_total < msr.min_qty)::int AS below_min,
         COALESCE(SUM(t.qty_total * i.avg_cost), 0) AS stock_value
       FROM totals t
       JOIN items i ON i.id = t.item_id
       LEFT JOIN min_stock_rules msr ON msr.location_id = t.location_id AND msr.item_id = t.item_id AND msr.is_active = true`,
      b.params,
    );
    const row = res.rows[0];
    return {
      totalItems: row ? Number(row.total_items) : 0,
      belowMin: row ? Number(row.below_min) : 0,
      stockValue: row?.stock_value ?? ZERO_QTY,
    };
  }

  async getSummaryByArea(
    client: PoolClient,
    locationId: string | undefined,
  ): Promise<{ storageAreaId: UUID; name: string; items: number }[]> {
    const b = new ConditionBuilder();
    b.eq('sa.location_id', locationId);
    const res = await client.query<{ storage_area_id: string; name: string; items: string }>(
      `SELECT sa.id AS storage_area_id, sa.name,
              COUNT(b.item_id) FILTER (WHERE b.item_id IS NOT NULL)::int AS items
         FROM storage_areas sa
         LEFT JOIN stock_balances b ON b.storage_area_id = sa.id
         ${b.where()}
        GROUP BY sa.id, sa.name, sa.sort_order
        ORDER BY sa.sort_order, sa.name`,
      b.params,
    );
    return res.rows.map((r) => ({
      storageAreaId: r.storage_area_id,
      name: r.name,
      items: Number(r.items),
    }));
  }

  // ── GET /movements ──────────────────────────────────────────────────────
  async listMovements(
    client: PoolClient,
    filters: ListMovementsFilters,
    page?: number,
    pageSize?: number,
  ): Promise<{ rows: Movement[]; total: number; page: number; pageSize: number }> {
    const { page: p, pageSize: ps } = paginationOf(page, pageSize);
    const b = new ConditionBuilder();
    b.eq('m.location_id', filters.locationId);
    b.eq('m.item_id', filters.itemId);
    b.eq('m.storage_area_id', filters.storageAreaId);
    b.eq('m.movement_type', filters.movementType);
    b.gte('m.occurred_at', filters.from);
    b.lte('m.occurred_at', filters.to);

    const limitIdx = b.nextParamIndex();
    const offsetIdx = limitIdx + 1;

    const res = await client.query<{
      id: string;
      movement_type: string;
      qty: string;
      unit_cost: string;
      ref_type: string;
      ref_id: string | null;
      storage_area_name: string;
      counterparty_location_name: string | null;
      actor_name: string | null;
      reason: string | null;
      occurred_at: Date;
      full_count: string;
    }>(
      `SELECT m.id, m.movement_type, m.qty, m.unit_cost, m.ref_type, m.ref_id,
              sa.name AS storage_area_name, cl.name AS counterparty_location_name,
              u.name AS actor_name, m.reason, m.occurred_at,
              COUNT(*) OVER() AS full_count
         FROM stock_movements m
         JOIN storage_areas sa ON sa.id = m.storage_area_id
         LEFT JOIN locations cl ON cl.id = m.counterparty_location_id
         LEFT JOIN users u ON u.id = m.actor_id
         ${b.where()}
        ORDER BY m.occurred_at DESC
        LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      [...b.params, ps, (p - 1) * ps],
    );

    const total = res.rows.length > 0 ? Number(res.rows[0]!.full_count) : 0;
    const rows: Movement[] = res.rows.map((r) => ({
      id: r.id,
      movementType: r.movement_type,
      qty: r.qty,
      unitCost: r.unit_cost,
      refType: r.ref_type,
      refId: r.ref_id,
      storageAreaName: r.storage_area_name,
      counterpartyLocationName: r.counterparty_location_name,
      actorName: r.actor_name,
      reason: r.reason,
      occurredAt: r.occurred_at.toISOString(),
    }));
    return { rows, total, page: p, pageSize: ps };
  }

  /** Same projection as `listMovements`, for a fixed set of just-posted movement ids (area-transfer's response). */
  async getMovementsByIds(client: PoolClient, ids: readonly string[]): Promise<Movement[]> {
    if (ids.length === 0) return [];
    const res = await client.query<{
      id: string;
      movement_type: string;
      qty: string;
      unit_cost: string;
      ref_type: string;
      ref_id: string | null;
      storage_area_name: string;
      counterparty_location_name: string | null;
      actor_name: string | null;
      reason: string | null;
      occurred_at: Date;
    }>(
      `SELECT m.id, m.movement_type, m.qty, m.unit_cost, m.ref_type, m.ref_id,
              sa.name AS storage_area_name, cl.name AS counterparty_location_name,
              u.name AS actor_name, m.reason, m.occurred_at
         FROM stock_movements m
         JOIN storage_areas sa ON sa.id = m.storage_area_id
         LEFT JOIN locations cl ON cl.id = m.counterparty_location_id
         LEFT JOIN users u ON u.id = m.actor_id
        WHERE m.id = ANY($1::uuid[])
        ORDER BY m.movement_type`,
      [ids],
    );
    return res.rows.map((r) => ({
      id: r.id,
      movementType: r.movement_type,
      qty: r.qty,
      unitCost: r.unit_cost,
      refType: r.ref_type,
      refId: r.ref_id,
      storageAreaName: r.storage_area_name,
      counterpartyLocationName: r.counterparty_location_name,
      actorName: r.actor_name,
      reason: r.reason,
      occurredAt: r.occurred_at.toISOString(),
    }));
  }

  // ── GET /low-stock ──────────────────────────────────────────────────────
  async listLowStock(
    client: PoolClient,
    locationId: string | undefined,
  ): Promise<
    {
      locationId: UUID;
      itemId: UUID;
      itemName: string;
      qtyOnHand: Qty;
      minQty: Qty;
      suggestedQty: Qty | null;
    }[]
  > {
    const b = new ConditionBuilder();
    b.eq('msr.location_id', locationId);
    const res = await client.query<{
      location_id: string;
      item_id: string;
      item_name: string;
      qty_on_hand: string;
      min_qty: string;
      suggested_qty: string | null;
    }>(
      `WITH totals AS (
         SELECT location_id, item_id, SUM(qty_on_hand) AS qty_total FROM stock_balances GROUP BY 1, 2
       )
       SELECT msr.location_id, msr.item_id, i.name AS item_name,
              COALESCE(t.qty_total, 0) AS qty_on_hand, msr.min_qty, msr.reorder_qty AS suggested_qty
         FROM min_stock_rules msr
         JOIN items i ON i.id = msr.item_id
         LEFT JOIN totals t ON t.location_id = msr.location_id AND t.item_id = msr.item_id
        WHERE msr.is_active = true
          AND COALESCE(t.qty_total, 0) < msr.min_qty
          ${b.extraAnd()}
        ORDER BY i.name`,
      b.params,
    );
    return res.rows.map((r) => ({
      locationId: r.location_id,
      itemId: r.item_id,
      itemName: r.item_name,
      qtyOnHand: r.qty_on_hand,
      minQty: r.min_qty,
      suggestedQty: r.suggested_qty,
    }));
  }

  // ── GET/PUT /min-stock ──────────────────────────────────────────────────
  async listMinStock(
    client: PoolClient,
    locationId: string | undefined,
    page?: number,
    pageSize?: number,
  ): Promise<{ rows: MinStockRuleRow[]; total: number; page: number; pageSize: number }> {
    const { page: p, pageSize: ps } = paginationOf(page, pageSize);
    const b = new ConditionBuilder();
    b.eq('msr.location_id', locationId);
    const limitIdx = b.nextParamIndex();
    const offsetIdx = limitIdx + 1;

    const res = await client.query<{
      id: string;
      location_id: string;
      item_id: string;
      item_name: string;
      min_qty: string;
      reorder_qty: string | null;
      is_active: boolean;
      full_count: string;
    }>(
      `SELECT msr.id, msr.location_id, msr.item_id, i.name AS item_name,
              msr.min_qty, msr.reorder_qty, msr.is_active,
              COUNT(*) OVER() AS full_count
         FROM min_stock_rules msr
         JOIN items i ON i.id = msr.item_id
         ${b.where()}
        ORDER BY i.name
        LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      [...b.params, ps, (p - 1) * ps],
    );

    const total = res.rows.length > 0 ? Number(res.rows[0]!.full_count) : 0;
    const rows: MinStockRuleRow[] = res.rows.map((r) => ({
      id: r.id,
      locationId: r.location_id,
      itemId: r.item_id,
      itemName: r.item_name,
      minQty: r.min_qty,
      reorderQty: r.reorder_qty,
      isActive: r.is_active,
    }));
    return { rows, total, page: p, pageSize: ps };
  }

  /**
   * Bulk upsert on `(location_id, item_id)` (the table's own `UNIQUE`
   * constraint, migration 022). Runs each rule as its own
   * `INSERT ... ON CONFLICT ... DO UPDATE` so a partial failure (e.g. one bad
   * `itemId`) surfaces the correct row's FK violation, and so RLS's
   * `WITH CHECK (app_has_location(location_id))` gates each row individually
   * — never a single all-or-nothing multi-row statement that would be harder
   * to attribute back to the offending rule.
   */
  async upsertMinStockRules(
    client: PoolClient,
    locationId: string,
    rules: readonly { itemId: string; minQty: string; reorderQty?: string }[],
    updatedBy: string,
  ): Promise<MinStockRuleRow[]> {
    const ids: string[] = [];
    for (const rule of rules) {
      const res = await client.query<{ id: string }>(
        `INSERT INTO min_stock_rules (location_id, item_id, min_qty, reorder_qty, is_active, updated_by)
         VALUES ($1, $2, $3, $4, true, $5)
         ON CONFLICT (location_id, item_id) DO UPDATE
           SET min_qty = EXCLUDED.min_qty,
               reorder_qty = EXCLUDED.reorder_qty,
               is_active = true,
               updated_by = EXCLUDED.updated_by,
               updated_at = NOW()
         RETURNING id`,
        [locationId, rule.itemId, rule.minQty, rule.reorderQty ?? null, updatedBy],
      );
      const id = res.rows[0]?.id;
      if (!id)
        throw new Error(`upsertMinStockRules: RETURNING id yielded no row for item ${rule.itemId}`);
      ids.push(id);
    }

    const res = await client.query<{
      id: string;
      location_id: string;
      item_id: string;
      item_name: string;
      min_qty: string;
      reorder_qty: string | null;
      is_active: boolean;
    }>(
      `SELECT msr.id, msr.location_id, msr.item_id, i.name AS item_name, msr.min_qty, msr.reorder_qty, msr.is_active
         FROM min_stock_rules msr
         JOIN items i ON i.id = msr.item_id
        WHERE msr.id = ANY($1::uuid[])
        ORDER BY i.name`,
      [ids],
    );
    return res.rows.map((r) => ({
      id: r.id,
      locationId: r.location_id,
      itemId: r.item_id,
      itemName: r.item_name,
      minQty: r.min_qty,
      reorderQty: r.reorder_qty,
      isActive: r.is_active,
    }));
  }

  // ── GET /suggestions ────────────────────────────────────────────────────
  async listSuggestionInputs(
    client: PoolClient,
    locationId: string | undefined,
  ): Promise<
    {
      locationId: UUID;
      itemId: UUID;
      itemName: string;
      qtyOnHand: Qty;
      minQty: Qty;
      reorderQty: Qty | null;
      qty14: Qty;
    }[]
  > {
    const b = new ConditionBuilder();
    b.eq('msr.location_id', locationId);
    const res = await client.query<{
      location_id: string;
      item_id: string;
      item_name: string;
      qty_on_hand: string;
      min_qty: string;
      reorder_qty: string | null;
      qty14: string;
    }>(
      `WITH totals AS (
         SELECT location_id, item_id, SUM(qty_on_hand) AS qty_total FROM stock_balances GROUP BY 1, 2
       ),
       usage AS (
         SELECT location_id, item_id, SUM(qty_used) AS qty14
           FROM mv_item_usage_daily
          WHERE usage_date >= ((NOW() AT TIME ZONE 'Asia/Makassar')::date - INTERVAL '14 days')
          GROUP BY 1, 2
       )
       SELECT msr.location_id, msr.item_id, i.name AS item_name,
              COALESCE(t.qty_total, 0) AS qty_on_hand, msr.min_qty, msr.reorder_qty,
              COALESCE(u.qty14, 0) AS qty14
         FROM min_stock_rules msr
         JOIN items i ON i.id = msr.item_id
         LEFT JOIN totals t ON t.location_id = msr.location_id AND t.item_id = msr.item_id
         LEFT JOIN usage u ON u.location_id = msr.location_id AND u.item_id = msr.item_id
        WHERE msr.is_active = true
          ${b.extraAnd()}
        ORDER BY i.name`,
      b.params,
    );
    return res.rows.map((r) => ({
      locationId: r.location_id,
      itemId: r.item_id,
      itemName: r.item_name,
      qtyOnHand: r.qty_on_hand,
      minQty: r.min_qty,
      reorderQty: r.reorder_qty,
      qty14: r.qty14,
    }));
  }

  // ── POST /area-transfer ─────────────────────────────────────────────────
  async getStorageArea(
    client: PoolClient,
    id: string,
  ): Promise<{ id: string; locationId: string; isActive: boolean } | null> {
    const res = await client.query<{ id: string; location_id: string; is_active: boolean }>(
      `SELECT id, location_id, is_active FROM storage_areas WHERE id = $1`,
      [id],
    );
    const row = res.rows[0];
    return row ? { id: row.id, locationId: row.location_id, isActive: row.is_active } : null;
  }

  async getItemAvgCost(client: PoolClient, itemId: string): Promise<Money | null> {
    const res = await client.query<{ avg_cost: string }>(
      `SELECT avg_cost FROM items WHERE id = $1`,
      [itemId],
    );
    return res.rows[0]?.avg_cost ?? null;
  }

  // ── GET /history/:itemId ────────────────────────────────────────────────
  async getLocationItemTotal(client: PoolClient, locationId: string, itemId: string): Promise<Qty> {
    const res = await client.query<{ qty_total: string | null }>(
      `SELECT SUM(qty_on_hand) AS qty_total FROM stock_balances WHERE location_id = $1 AND item_id = $2`,
      [locationId, itemId],
    );
    return res.rows[0]?.qty_total ?? ZERO_QTY;
  }

  /** Per-WITA-calendar-day in/out totals for one `(location, item)` over `[from, to)`. Days with no movement are simply absent from the result — the service fills the gaps. */
  async getDailyMovementTotals(
    client: PoolClient,
    locationId: string,
    itemId: string,
    fromIso: string,
    toExclusiveIso: string,
  ): Promise<Map<string, { qtyIn: Qty; qtyOut: Qty }>> {
    const res = await client.query<{ day: string; qty_in: string; qty_out: string }>(
      `SELECT ((occurred_at AT TIME ZONE 'Asia/Makassar')::date)::text AS day,
              COALESCE(SUM(qty) FILTER (WHERE movement_type LIKE '%_in'), 0) AS qty_in,
              COALESCE(SUM(qty) FILTER (WHERE movement_type LIKE '%_out'), 0) AS qty_out
         FROM stock_movements
        WHERE location_id = $1 AND item_id = $2
          AND occurred_at >= $3::timestamptz AND occurred_at < $4::timestamptz
        GROUP BY 1`,
      [locationId, itemId, fromIso, toExclusiveIso],
    );
    const map = new Map<string, { qtyIn: Qty; qtyOut: Qty }>();
    for (const r of res.rows) map.set(r.day, { qtyIn: r.qty_in, qtyOut: r.qty_out });
    return map;
  }

  async itemExists(client: PoolClient, itemId: string): Promise<boolean> {
    const res = await client.query(`SELECT 1 FROM items WHERE id = $1`, [itemId]);
    return res.rowCount !== null && res.rowCount > 0;
  }
}
