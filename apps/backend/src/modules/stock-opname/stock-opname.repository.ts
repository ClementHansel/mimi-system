import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  businessDateOf,
  DocumentPrefix,
  formatCloudDocNumber,
  type Money,
  type Qty,
  type UUID,
} from '@mimi/shared';

export interface OpnameHeaderRow {
  id: UUID;
  opname_number: string;
  location_id: UUID;
  location_name: string;
  location_type: string;
  storage_area_id: UUID | null;
  status: string;
  counted_by: UUID;
  counted_by_name: string;
  started_at: string;
  submitted_at: string | null;
  approval_id: UUID | null;
  approved_by: UUID | null;
  approved_by_name: string | null;
  approved_at: string | null;
  notes: string | null;
}

export interface OpnameLineRow {
  id: UUID;
  opname_id: UUID;
  storage_area_id: UUID;
  storage_area_name: string;
  item_id: UUID;
  item_name: string;
  unit_code: string;
  system_qty: Qty;
  counted_qty: Qty;
  diff_qty: Qty;
  variance_reason: string | null;
  unit_cost: Money;
}

/**
 * `users` RLS (migration 009) is "central role OR self" — a Supervisor
 * approving an opname counted by a Leader Outlet is neither. An INNER JOIN
 * to `users` for a display-only name would silently make the WHOLE header
 * row invisible to that Supervisor (the join predicate never matches once
 * RLS hides the counterparty's row), even though `stock_opname` itself is
 * plainly visible to them (`LOC`-scoped, their own outlet). LEFT JOIN here
 * is load-bearing, not stylistic: a name-visibility gap must degrade to
 * `null`, never to "the document doesn't exist."
 */
const HEADER_SELECT = `
  SELECT so.id, so.opname_number, so.location_id, l.name AS location_name, l.type AS location_type,
         so.storage_area_id, so.status, so.counted_by, cu.name AS counted_by_name,
         so.started_at, so.submitted_at, so.approval_id, so.approved_by, au.name AS approved_by_name,
         so.approved_at, so.notes
    FROM stock_opname so
    JOIN locations l ON l.id = so.location_id
    LEFT JOIN users cu ON cu.id = so.counted_by
    LEFT JOIN users au ON au.id = so.approved_by
`;

const LINE_SELECT = `
  SELECT ol.id, ol.opname_id, ol.storage_area_id, sa.name AS storage_area_name, ol.item_id, i.name AS item_name,
         u.code AS unit_code, ol.system_qty, ol.counted_qty, ol.diff_qty, ol.variance_reason, i.avg_cost AS unit_cost
    FROM stock_opname_lines ol
    JOIN storage_areas sa ON sa.id = ol.storage_area_id
    JOIN items i ON i.id = ol.item_id
    JOIN units u ON u.id = i.base_unit_id
`;

/**
 * Raw `pg` access to `stock_opname`/`stock_opname_lines` (CONTRACTS.md §1.3
 * block 020-029). Every query runs on the caller-supplied `PoolClient` — RLS
 * (`LOC` on `stock_opname`, `PARENT` on `stock_opname_lines`) is already live
 * on that client, set by `RlsContextGuard` per request (or by the test
 * harness's `withRollback`, mirroring it). No pool of its own — same
 * reasoning as `ScopeService`/`StockLedgerService`.
 */
@Injectable()
export class StockOpnameRepository {
  async nextOpnameNumber(client: PoolClient): Promise<string> {
    const period = periodYYYYMM();
    const res = await client.query<{ last_number: number }>(
      `INSERT INTO document_counters (doc_type, period, last_number)
       VALUES ($1, $2, 1)
       ON CONFLICT (doc_type, period) DO UPDATE SET last_number = document_counters.last_number + 1
       RETURNING last_number`,
      [DocumentPrefix.STOCK_OPNAME, period],
    );
    return formatCloudDocNumber(DocumentPrefix.STOCK_OPNAME, period, res.rows[0]!.last_number);
  }

  /**
   * B-11: `id` is optional. The REST path omits it and the database mints one.
   * The SYNC path supplies the id the DEVICE minted while offline, because
   * every later event in that opname's life (`area_counted`, `submitted`,
   * `cancelled`) already references it — a server-minted id would orphan them.
   *
   * The document NUMBER is still issued here, never taken from the device:
   * two tablets counting offline would both mint `SO/202608/0001`, and
   * `opname_number` is UNIQUE. Same rule the delivery projector follows.
   */
  async insertOpname(
    client: PoolClient,
    params: {
      id?: UUID;
      opnameNumber: string;
      locationId: UUID;
      storageAreaId: UUID | null;
      countedBy: UUID;
    },
  ): Promise<UUID> {
    const res = await client.query<{ id: UUID }>(
      `INSERT INTO stock_opname (id, opname_number, location_id, storage_area_id, status, counted_by)
       VALUES (COALESCE($5::uuid, gen_random_uuid()), $1, $2, $3, 'counting', $4)
       RETURNING id`,
      [
        params.opnameNumber,
        params.locationId,
        params.storageAreaId,
        params.countedBy,
        params.id ?? null,
      ],
    );
    return res.rows[0]!.id;
  }

  async findHeader(client: PoolClient, id: UUID): Promise<OpnameHeaderRow | undefined> {
    const res = await client.query<OpnameHeaderRow>(`${HEADER_SELECT} WHERE so.id = $1`, [id]);
    return res.rows[0];
  }

  async listHeaders(
    client: PoolClient,
    filter: {
      locationId?: string;
      status?: string;
      from?: string;
      to?: string;
      page: number;
      pageSize: number;
    },
  ): Promise<{ rows: OpnameHeaderRow[]; total: number }> {
    const conds: string[] = [];
    const args: unknown[] = [];
    let i = 1;
    if (filter.locationId) {
      conds.push(`so.location_id = $${i++}`);
      args.push(filter.locationId);
    }
    if (filter.status) {
      conds.push(`so.status = $${i++}`);
      args.push(filter.status);
    }
    if (filter.from) {
      conds.push(`so.started_at >= $${i++}`);
      args.push(filter.from);
    }
    if (filter.to) {
      conds.push(`so.started_at <= $${i++}`);
      args.push(filter.to);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const offset = (filter.page - 1) * filter.pageSize;

    const [rows, count] = await Promise.all([
      client.query<OpnameHeaderRow>(
        `${HEADER_SELECT} ${where} ORDER BY so.started_at DESC LIMIT $${i} OFFSET $${i + 1}`,
        [...args, filter.pageSize, offset],
      ),
      client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM stock_opname so ${where}`,
        args,
      ),
    ]);
    return { rows: rows.rows, total: Number(count.rows[0]?.count ?? '0') };
  }

  async findLines(client: PoolClient, opnameId: UUID): Promise<OpnameLineRow[]> {
    const res = await client.query<OpnameLineRow>(
      `${LINE_SELECT} WHERE ol.opname_id = $1 ORDER BY sa.sort_order, i.name`,
      [opnameId],
    );
    return res.rows;
  }

  async findLineById(
    client: PoolClient,
    opnameId: UUID,
    lineId: UUID,
  ): Promise<OpnameLineRow | undefined> {
    const res = await client.query<OpnameLineRow>(
      `${LINE_SELECT} WHERE ol.opname_id = $1 AND ol.id = $2`,
      [opnameId, lineId],
    );
    return res.rows[0];
  }

  /** Looks up an existing line by its natural key — used to preserve the ALREADY-snapshotted `system_qty` on a recount (never re-based against a moving `stock_balances`). */
  async findLineByKey(
    client: PoolClient,
    opnameId: UUID,
    storageAreaId: UUID,
    itemId: UUID,
  ): Promise<{ system_qty: Qty } | undefined> {
    const res = await client.query<{ system_qty: Qty }>(
      `SELECT system_qty FROM stock_opname_lines WHERE opname_id = $1 AND storage_area_id = $2 AND item_id = $3`,
      [opnameId, storageAreaId, itemId],
    );
    return res.rows[0];
  }

  /** Current `stock_balances.qty_on_hand` for the key, or `'0.000'` when no row exists yet. */
  async currentSystemQty(
    client: PoolClient,
    locationId: UUID,
    storageAreaId: UUID,
    itemId: UUID,
  ): Promise<Qty> {
    const res = await client.query<{ qty_on_hand: Qty }>(
      `SELECT qty_on_hand FROM stock_balances WHERE location_id = $1 AND storage_area_id = $2 AND item_id = $3`,
      [locationId, storageAreaId, itemId],
    );
    return res.rows[0]?.qty_on_hand ?? '0.000';
  }

  async itemUnitCost(client: PoolClient, itemId: UUID): Promise<Money> {
    const res = await client.query<{ avg_cost: Money }>(
      `SELECT avg_cost FROM items WHERE id = $1`,
      [itemId],
    );
    return res.rows[0]?.avg_cost ?? '0.00';
  }

  /**
   * Upsert one line — `system_qty` is snapshotted from `stock_balances` ONLY
   * on first insert (FR-SO-02's "lazy" snapshot); a recount before submit
   * updates `counted_qty`/`diff_qty`/`variance_reason` but never re-bases
   * `system_qty` against a moving target.
   */
  async upsertLine(
    client: PoolClient,
    params: {
      opnameId: UUID;
      storageAreaId: UUID;
      itemId: UUID;
      systemQty: Qty;
      countedQty: Qty;
      diffQty: Qty;
      varianceReason: string | null;
    },
  ): Promise<UUID> {
    const res = await client.query<{ id: UUID }>(
      `INSERT INTO stock_opname_lines (opname_id, storage_area_id, item_id, system_qty, counted_qty, diff_qty, variance_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (opname_id, storage_area_id, item_id)
       DO UPDATE SET counted_qty = EXCLUDED.counted_qty, diff_qty = EXCLUDED.diff_qty, variance_reason = EXCLUDED.variance_reason
       RETURNING id`,
      [
        params.opnameId,
        params.storageAreaId,
        params.itemId,
        params.systemQty,
        params.countedQty,
        params.diffQty,
        params.varianceReason,
      ],
    );
    return res.rows[0]!.id;
  }

  async updateLineForResolution(
    client: PoolClient,
    lineId: UUID,
    params: { countedQty: Qty; diffQty: Qty; varianceReason: string | null },
  ): Promise<void> {
    await client.query(
      `UPDATE stock_opname_lines SET counted_qty = $2, diff_qty = $3, variance_reason = $4 WHERE id = $1`,
      [lineId, params.countedQty, params.diffQty, params.varianceReason],
    );
  }

  async countLinesMissingReason(client: PoolClient, opnameId: UUID): Promise<number> {
    const res = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM stock_opname_lines
        WHERE opname_id = $1 AND diff_qty <> 0 AND (variance_reason IS NULL OR btrim(variance_reason) = '')`,
      [opnameId],
    );
    return Number(res.rows[0]?.count ?? '0');
  }

  async lineSummary(
    client: PoolClient,
    opnameId: UUID,
  ): Promise<{ lineCount: number; totalVarianceValue: Money }> {
    const res = await client.query<{ line_count: string; total_variance: Money }>(
      `SELECT COUNT(*)::text AS line_count,
              COALESCE(SUM(ABS(ol.diff_qty) * i.avg_cost), 0)::text AS total_variance
         FROM stock_opname_lines ol
         JOIN items i ON i.id = ol.item_id
        WHERE ol.opname_id = $1`,
      [opnameId],
    );
    return {
      lineCount: Number(res.rows[0]?.line_count ?? '0'),
      totalVarianceValue: res.rows[0]?.total_variance ?? '0.00',
    };
  }

  async setStatus(client: PoolClient, id: UUID, status: string): Promise<void> {
    await client.query(`UPDATE stock_opname SET status = $2 WHERE id = $1`, [id, status]);
  }

  async markSubmitted(client: PoolClient, id: UUID): Promise<void> {
    await client.query(
      `UPDATE stock_opname SET status = 'submitted', submitted_at = NOW() WHERE id = $1`,
      [id],
    );
  }

  async setApprovalId(client: PoolClient, id: UUID, approvalId: UUID): Promise<void> {
    await client.query(`UPDATE stock_opname SET approval_id = $2 WHERE id = $1`, [id, approvalId]);
  }

  /** Persists the terminal decision — call ONLY when `decide()` returned `currentStep === null` (kernel report guidance). */
  async finalizeDecision(
    client: PoolClient,
    id: UUID,
    params: { status: string; approvedBy: UUID | null; approvedAt: string | null },
  ): Promise<void> {
    await client.query(
      `UPDATE stock_opname SET status = $2, approved_by = $3, approved_at = $4 WHERE id = $1`,
      [id, params.status, params.approvedBy, params.approvedAt],
    );
  }

  async insertAdjustment(
    client: PoolClient,
    params: {
      adjustmentNumber: string;
      locationId: UUID;
      storageAreaId: UUID;
      itemId: UUID;
      qtyDelta: Qty;
      unitCost: Money;
      reason: string;
      opnameId: UUID;
      createdBy: UUID;
      approvedBy: UUID;
    },
  ): Promise<UUID> {
    const res = await client.query<{ id: UUID }>(
      `INSERT INTO stock_adjustments
         (adjustment_number, location_id, storage_area_id, item_id, qty_delta, unit_cost, reason, source, opname_id, created_by, approved_by, applied_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'opname', $8, $9, $10, NOW())
       RETURNING id`,
      [
        params.adjustmentNumber,
        params.locationId,
        params.storageAreaId,
        params.itemId,
        params.qtyDelta,
        params.unitCost,
        params.reason,
        params.opnameId,
        params.createdBy,
        params.approvedBy,
      ],
    );
    return res.rows[0]!.id;
  }
}

/** 'YYYYMM' in Asia/Makassar (D-11) — a count started just after WITA midnight must not number against the previous UTC day's period. */
function periodYYYYMM(): string {
  return businessDateOf(new Date().toISOString()).replace(/-/g, '').slice(0, 6);
}
