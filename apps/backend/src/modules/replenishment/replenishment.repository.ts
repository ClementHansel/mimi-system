import { Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import {
  businessDateOf,
  formatCloudDocNumber,
  type ISODate,
  type Qty,
  type UUID,
} from '@mimi/shared';
import { formatDateOnly } from '../../common/date-only.util';
import { SYSTEM_CENTRAL_ROLE, withSystemContext } from '../../common/database/system-context';

export interface ReplenishmentRow {
  id: UUID;
  requestNumber: string;
  locationId: UUID;
  locationName: string;
  status: string;
  source: 'manual' | 'auto_suggestion';
  requestedBy: UUID;
  requestedByName: string | null;
  submittedAt: string | null;
  neededBy: ISODate | null;
  sjId: UUID | null;
  sjNumber: string | null;
  rejectionReason: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReplenishmentLineRow {
  id: UUID;
  itemId: UUID;
  itemName: string;
  unitCode: string;
  qtyRequested: Qty;
  qtyApproved: Qty | null;
  qtyShipped: Qty | null;
  qtyReceived: Qty | null;
  amendReason: string | null;
}

export interface CreateLineInput {
  itemId: UUID;
  qtyRequested: Qty;
  unitId: UUID;
}

export interface ListFilter {
  locationId?: UUID;
  status?: string;
  from?: ISODate;
  to?: ISODate;
  page: number;
  pageSize: number;
}

export interface WarehouseQueueFilter {
  status?: string;
  page: number;
  pageSize: number;
}

const ROW_SELECT = `
  SELECT rr.id, rr.request_number, rr.location_id, l.name AS location_name, rr.status, rr.source,
         rr.requested_by, ru.name AS requested_by_name, rr.submitted_at, rr.needed_by,
         rr.sj_id, sj.sj_number, rr.rejection_reason, rr.notes, rr.created_at, rr.updated_at
    FROM replenishment_requests rr
    JOIN locations l ON l.id = rr.location_id
    LEFT JOIN users ru ON ru.id = rr.requested_by
    LEFT JOIN surat_jalan sj ON sj.id = rr.sj_id
`;

interface RawRequestRow {
  id: string;
  request_number: string;
  location_id: string;
  location_name: string;
  status: string;
  source: 'manual' | 'auto_suggestion';
  requested_by: string;
  requested_by_name: string | null;
  submitted_at: Date | string | null;
  needed_by: Date | string | null;
  sj_id: string | null;
  sj_number: string | null;
  rejection_reason: string | null;
  notes: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface RawLineRow {
  id: string;
  item_id: string;
  item_name: string;
  unit_code: string;
  qty_requested: string;
  qty_approved: string | null;
  qty_shipped: string | null;
  qty_received: string | null;
  amend_reason: string | null;
}

function mapRow(r: RawRequestRow): ReplenishmentRow {
  return {
    id: r.id,
    requestNumber: r.request_number,
    locationId: r.location_id,
    locationName: r.location_name,
    status: r.status,
    source: r.source,
    requestedBy: r.requested_by,
    requestedByName: r.requested_by_name ?? null,
    submittedAt: r.submitted_at ? new Date(r.submitted_at).toISOString() : null,
    neededBy: r.needed_by ? formatDateOnly(r.needed_by) : null,
    sjId: r.sj_id,
    sjNumber: r.sj_number ?? null,
    rejectionReason: r.rejection_reason,
    notes: r.notes,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

function mapLineRow(r: RawLineRow): ReplenishmentLineRow {
  return {
    id: r.id,
    itemId: r.item_id,
    itemName: r.item_name,
    unitCode: r.unit_code,
    qtyRequested: r.qty_requested,
    qtyApproved: r.qty_approved,
    qtyShipped: r.qty_shipped,
    qtyReceived: r.qty_received,
    amendReason: r.amend_reason,
  };
}

@Injectable()
export class ReplenishmentRepository {
  /** `RR/YYYYMM/nnnn`, atomic per period (CONTRACTS.md §0 doc-numbering; D-11 WITA business date for the period). */
  async nextRequestNumber(client: PoolClient): Promise<string> {
    const period = businessDateOf(new Date().toISOString()).slice(0, 7).replace('-', '');
    const res = await client.query<{ last_number: number }>(
      `INSERT INTO document_counters (doc_type, period, last_number) VALUES ('RR', $1, 1)
       ON CONFLICT (doc_type, period) DO UPDATE SET last_number = document_counters.last_number + 1
       RETURNING last_number`,
      [period],
    );
    return formatCloudDocNumber('RR', period, res.rows[0]!.last_number);
  }

  async insertRequest(
    client: PoolClient,
    params: {
      requestNumber: string;
      locationId: UUID;
      source: 'manual' | 'auto_suggestion';
      requestedBy: UUID;
      neededBy: ISODate | null;
      notes: string | null;
      clientId: UUID | null;
    },
  ): Promise<UUID> {
    const res = await client.query<{ id: string }>(
      `INSERT INTO replenishment_requests (request_number, location_id, source, requested_by, needed_by, notes, client_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        params.requestNumber,
        params.locationId,
        params.source,
        params.requestedBy,
        params.neededBy,
        params.notes,
        params.clientId,
      ],
    );
    return res.rows[0]!.id;
  }

  /**
   * `nextRequestNumber()` + `insertRequest()`, retried under a `SAVEPOINT` if
   * the generated number collides with an EXISTING row's
   * `request_number` (unique violation, Postgres code `23505`).
   *
   * Why this can happen despite `document_counters` being the documented
   * source of truth (CONTRACTS.md §0): `database/seed.ts` inserts demo
   * `replenishment_requests` rows with hand-picked `RR/YYYYMM/000n` numbers
   * directly, without advancing `document_counters` to match (a seed-data
   * gap outside this module's ownership — reported, not fixed here). A bare
   * `nextRequestNumber()` call would then reissue an already-used number on
   * the very first live request of a period. A `SAVEPOINT` (not a fresh
   * transaction) is required because a failed `INSERT` poisons the REST of
   * the caller's transaction in Postgres until an explicit rollback — this
   * module runs inside the caller's own already-open transaction
   * (`RlsContextGuard`'s, per `replenishment.service.ts`'s class header), so
   * a plain retry without a savepoint would fail every subsequent statement
   * on this same connection, not just this one.
   */
  async insertRequestWithNumber(
    client: PoolClient,
    params: {
      locationId: UUID;
      source: 'manual' | 'auto_suggestion';
      requestedBy: UUID;
      neededBy: ISODate | null;
      notes: string | null;
      clientId: UUID | null;
    },
  ): Promise<{ id: UUID; requestNumber: string }> {
    const MAX_ATTEMPTS = 20;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const requestNumber = await this.nextRequestNumber(client);
      await client.query('SAVEPOINT rr_insert');
      try {
        const id = await this.insertRequest(client, { ...params, requestNumber });
        await client.query('RELEASE SAVEPOINT rr_insert');
        return { id, requestNumber };
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT rr_insert');
        const pgCode = (err as { code?: string }).code;
        if (pgCode !== '23505' || attempt === MAX_ATTEMPTS) throw err;
        // Collided with a pre-existing row (see doc comment) — document_counters already advanced past
        // this value, so the NEXT nextRequestNumber() call issues a fresh, still-unused one; loop again.
      }
    }
    // Unreachable (the loop always returns or throws), but keeps the return type total for the compiler.
    throw new Error(
      'insertRequestWithNumber: exhausted retry attempts without returning or throwing',
    );
  }

  async insertLines(
    client: PoolClient,
    requestId: UUID,
    lines: readonly CreateLineInput[],
  ): Promise<void> {
    for (const line of lines) {
      await client.query(
        `INSERT INTO replenishment_request_lines (request_id, item_id, unit_id, qty_requested)
         VALUES ($1, $2, $3, $4)`,
        [requestId, line.itemId, line.unitId, line.qtyRequested],
      );
    }
  }

  async deleteLines(client: PoolClient, requestId: UUID): Promise<void> {
    await client.query(`DELETE FROM replenishment_request_lines WHERE request_id = $1`, [
      requestId,
    ]);
  }

  async findById(client: PoolClient, id: UUID): Promise<ReplenishmentRow | null> {
    const res = await client.query(`${ROW_SELECT} WHERE rr.id = $1`, [id]);
    return res.rows[0] ? mapRow(res.rows[0]) : null;
  }

  /** Same read, but locks the row for the duration of the caller's transaction — every mutating path uses this so two concurrent decisions on one request serialize instead of racing. */
  async findByIdForUpdate(client: PoolClient, id: UUID): Promise<ReplenishmentRow | null> {
    const res = await client.query(`${ROW_SELECT} WHERE rr.id = $1 FOR UPDATE OF rr`, [id]);
    return res.rows[0] ? mapRow(res.rows[0]) : null;
  }

  async findLines(client: PoolClient, requestId: UUID): Promise<ReplenishmentLineRow[]> {
    const res = await client.query(
      `SELECT rl.id, rl.item_id, i.name AS item_name, u.code AS unit_code,
              rl.qty_requested, rl.qty_approved, rl.qty_shipped, rl.qty_received, rl.amend_reason
         FROM replenishment_request_lines rl
         JOIN items i ON i.id = rl.item_id
         JOIN units u ON u.id = rl.unit_id
        WHERE rl.request_id = $1
        ORDER BY i.name ASC`,
      [requestId],
    );
    return res.rows.map(mapLineRow);
  }

  /**
   * Lines for a PAGE of requests, in one query.
   *
   * `list`/`listWarehouseQueue` used to hand `[]` to `toResource`, so every
   * request in a list arrived with no lines — which is why Pembelian →
   * Permintaan Outlet showed "Jumlah Item 0" against a real request, and why
   * its CSV export (one row per LINE, deliberately) wrote one blank-item row
   * per request instead. Per-request `findLines` calls would have fixed the
   * display and added N queries to every page; `= ANY($1)` is the same read
   * once.
   */
  /**
   * DISPLAY NAMES for the people who raised these requests — resolved in a
   * system context, because the caller cannot read `users` at all.
   *
   * `users_select` (migration 263) admits only self/owner/manager/hr_admin/
   * finance, so for KEPALA GUDANG — the role that works the warehouse approval
   * queue — the `LEFT JOIN users` in `ROW_SELECT` yields NULL for every row but
   * their own. The queue therefore showed no requester at all (and, before
   * 2026-09-01, the raw UUID). The warehouse fulfils requests from every
   * outlet by design (D-14), so "who asked for this" is information the job
   * needs; the owner ruled it in on 2026-09-01.
   *
   * BOUNDED ON PURPOSE, and this is the part to preserve if it is ever
   * touched:
   *  - the ids come from rows the caller ALREADY read under their own RLS, so
   *    this discloses the name of someone whose request they can see, and
   *    reaches nothing they could not otherwise reach;
   *  - it selects `id, name` and nothing else — no username, no phone, no
   *    role, no location;
   *  - it is a READ in system context, never a write.
   *
   * It takes the POOL rather than the request's client on purpose:
   * `withSystemContext` opens its own transaction, and running one on the
   * caller's mid-request connection would trample the `SET LOCAL ROLE` and
   * `app.*` vars that RLS depends on for the rest of that request (D-21/D-22).
   */
  async findRequesterNames(pool: Pool, userIds: readonly UUID[]): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    const wanted = [...new Set(userIds)];
    if (wanted.length === 0) return names;

    return withSystemContext(pool, { role: SYSTEM_CENTRAL_ROLE }, async (client) => {
      const res = await client.query<{ id: string; name: string | null }>(
        `SELECT id, name FROM users WHERE id = ANY($1::uuid[])`,
        [wanted as UUID[]],
      );
      for (const row of res.rows) {
        if (row.name) names.set(row.id, row.name);
      }
      return names;
    });
  }

  async findLinesForRequests(
    client: PoolClient,
    requestIds: readonly UUID[],
  ): Promise<Map<string, ReplenishmentLineRow[]>> {
    const byRequest = new Map<string, ReplenishmentLineRow[]>();
    if (requestIds.length === 0) return byRequest;
    const res = await client.query(
      `SELECT rl.request_id, rl.id, rl.item_id, i.name AS item_name, u.code AS unit_code,
              rl.qty_requested, rl.qty_approved, rl.qty_shipped, rl.qty_received, rl.amend_reason
         FROM replenishment_request_lines rl
         JOIN items i ON i.id = rl.item_id
         JOIN units u ON u.id = rl.unit_id
        WHERE rl.request_id = ANY($1)
        ORDER BY i.name ASC`,
      [requestIds as UUID[]],
    );
    for (const raw of res.rows) {
      const key = String(raw.request_id);
      const bucket = byRequest.get(key);
      if (bucket) bucket.push(mapLineRow(raw));
      else byRequest.set(key, [mapLineRow(raw)]);
    }
    return byRequest;
  }

  async list(
    client: PoolClient,
    filter: ListFilter,
  ): Promise<{ rows: ReplenishmentRow[]; total: number }> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    const push = (sql: string, value: unknown) => {
      params.push(value);
      conditions.push(sql.replace('$$', `$${params.length}`));
    };
    if (filter.locationId) push('rr.location_id = $$', filter.locationId);
    if (filter.status) push('rr.status = $$', filter.status);
    if (filter.from) push('rr.created_at >= $$', filter.from);
    if (filter.to) push('rr.created_at <= $$', filter.to);
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRes = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM replenishment_requests rr ${where}`,
      params,
    );
    const limitIdx = params.length + 1;
    const offsetIdx = params.length + 2;
    const rowsRes = await client.query(
      `${ROW_SELECT} ${where} ORDER BY rr.created_at DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      [...params, filter.pageSize, (filter.page - 1) * filter.pageSize],
    );
    return { rows: rowsRes.rows.map(mapRow), total: Number(countRes.rows[0]?.count ?? 0) };
  }

  /** `GET /api/replenishment/queue/warehouse` — the KGD work queue: `approved`+`processing` feed SJ building (M10); `awaiting_approval` is what KGD still has to decide. No location filter (D-14: one central warehouse serves every outlet). */
  async listWarehouseQueue(
    client: PoolClient,
    filter: WarehouseQueueFilter,
  ): Promise<{ rows: ReplenishmentRow[]; total: number }> {
    const statuses = filter.status
      ? [filter.status]
      : ['awaiting_approval', 'approved', 'processing'];
    const countRes = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM replenishment_requests rr WHERE rr.status = ANY($1)`,
      [statuses],
    );
    const rowsRes = await client.query(
      `${ROW_SELECT} WHERE rr.status = ANY($1) ORDER BY rr.submitted_at ASC NULLS LAST, rr.created_at ASC LIMIT $2 OFFSET $3`,
      [statuses, filter.pageSize, (filter.page - 1) * filter.pageSize],
    );
    return { rows: rowsRes.rows.map(mapRow), total: Number(countRes.rows[0]?.count ?? 0) };
  }

  async updateStatus(client: PoolClient, id: UUID, status: string): Promise<void> {
    await client.query(`UPDATE replenishment_requests SET status = $2 WHERE id = $1`, [id, status]);
  }

  async markSubmitted(client: PoolClient, id: UUID, status: string): Promise<void> {
    await client.query(
      `UPDATE replenishment_requests SET status = $2, submitted_at = NOW() WHERE id = $1`,
      [id, status],
    );
  }

  async setRejectionReason(
    client: PoolClient,
    id: UUID,
    status: string,
    reason: string,
  ): Promise<void> {
    await client.query(
      `UPDATE replenishment_requests SET status = $2, rejection_reason = $3 WHERE id = $1`,
      [id, status, reason],
    );
  }

  /** FR-LOG-13: the approver amended the requested quantity. `amend_reason` is the recoverable "from what, to what, why" audit trail on the LINE itself; `@Audited()` on the owning HTTP endpoint additionally captures the before/after of the whole row via the interceptor (D-09) — this column is what survives even a raw `SELECT` against the line, without needing to replay audit_log. */
  async applyLineAmendment(
    client: PoolClient,
    lineId: UUID,
    qtyApproved: Qty,
    reason: string,
  ): Promise<void> {
    await client.query(
      `UPDATE replenishment_request_lines SET qty_approved = $2, amend_reason = $3 WHERE id = $1`,
      [lineId, qtyApproved, reason],
    );
  }

  /** Lines nobody amended still need a definite `qty_approved` once the chain fully decides — defaults to what was requested. Never overwrites a line an approver DID amend. */
  async fillDefaultApprovedQuantities(client: PoolClient, requestId: UUID): Promise<void> {
    await client.query(
      `UPDATE replenishment_request_lines SET qty_approved = qty_requested
        WHERE request_id = $1 AND qty_approved IS NULL`,
      [requestId],
    );
  }

  async setSjLink(client: PoolClient, id: UUID, sjId: UUID): Promise<void> {
    await client.query(
      `UPDATE replenishment_requests SET sj_id = $2 WHERE id = $1 AND sj_id IS NULL`,
      [id, sjId],
    );
  }

  async setLineShipped(client: PoolClient, lineId: UUID, qtyShipped: Qty): Promise<void> {
    await client.query(`UPDATE replenishment_request_lines SET qty_shipped = $2 WHERE id = $1`, [
      lineId,
      qtyShipped,
    ]);
  }

  async setLineReceived(client: PoolClient, lineId: UUID, qtyReceived: Qty): Promise<void> {
    await client.query(`UPDATE replenishment_request_lines SET qty_received = $2 WHERE id = $1`, [
      lineId,
      qtyReceived,
    ]);
  }

  async countUnreconciledLines(client: PoolClient, requestId: UUID): Promise<number> {
    const res = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM replenishment_request_lines WHERE request_id = $1 AND qty_received IS NULL`,
      [requestId],
    );
    return Number.parseInt(res.rows[0]?.count ?? '0', 10);
  }

  async hardDelete(client: PoolClient, id: UUID): Promise<void> {
    await client.query(`DELETE FROM replenishment_requests WHERE id = $1`, [id]);
  }

  /** FR-LOG-12: full history — every status/qty change the `@Audited()` interceptor recorded under this entity, oldest first (a timeline reads naturally top-down). */
  async history(
    client: PoolClient,
    id: UUID,
  ): Promise<
    {
      id: string;
      userId: string | null;
      userName: string | null;
      roleKey: string | null;
      module: string;
      action: string;
      entityType: string;
      entityId: string | null;
      beforeValue: unknown;
      afterValue: unknown;
      reason: string | null;
      offlineAuthorized: boolean;
      occurredAt: string;
    }[]
  > {
    const res = await client.query(
      `SELECT a.id, a.user_id, u.name AS user_name, a.role_key, a.module, a.action,
              a.entity_type, a.entity_id, a.before_value, a.after_value, a.reason,
              a.offline_authorized, a.occurred_at
         FROM audit_log a
         LEFT JOIN users u ON u.id = a.user_id
        WHERE a.entity_type = 'replenishment_request' AND a.entity_id = $1
        ORDER BY a.occurred_at ASC`,
      [id],
    );
    return res.rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      userName: r.user_name ?? null,
      roleKey: r.role_key,
      module: r.module,
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      beforeValue: r.before_value,
      afterValue: r.after_value,
      reason: r.reason,
      offlineAuthorized: r.offline_authorized,
      occurredAt: r.occurred_at instanceof Date ? r.occurred_at.toISOString() : r.occurred_at,
    }));
  }
}
