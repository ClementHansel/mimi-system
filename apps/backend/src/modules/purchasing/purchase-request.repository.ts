import type { PoolClient } from 'pg';
import { formatCloudDocNumber } from '@mimi/shared';
import type { Money, Qty, UUID } from '@mimi/shared';

export interface PrHeaderRow {
  id: string;
  pr_number: string;
  location_id: string;
  location_name: string;
  status: string;
  requested_by: string;
  requested_by_name: string | null;
  /** `purchase_requests.needed_by` is a `DATE` column — `pg` parses it into a local-timezone `Date`, not a `string` (this annotation was wrong; see `common/date-only.util.ts`). Never `.toISOString()` this directly. */
  needed_by: Date | null;
  approval_id: string | null;
  rejection_reason: string | null;
  notes: string | null;
  created_at: Date;
  /** Migration 227. NULL until someone edits the PR. */
  updated_at: Date;
  updated_by: string | null;
  updated_by_name: string | null;
  /** Migration 227 — the outlet request this PR was converted from, if any. */
  source_replenishment_id: string | null;
  source_replenishment_number: string | null;
}

/** One `audit_log` row about a PR, for `GET :id/history`. Mirrors `ReplenishmentHistoryRow`. */
export interface PrHistoryRow {
  id: string;
  user_id: string | null;
  user_name: string | null;
  role_key: string | null;
  action: string;
  before_value: unknown;
  after_value: unknown;
  reason: string | null;
  occurred_at: Date;
}

export interface PrLineRow {
  id: string;
  pr_id: string;
  item_id: string;
  item_name: string;
  unit_id: string;
  unit_code: string;
  qty: Qty;
  est_price: Money;
  suggested_supplier_id: string | null;
}

const HEADER_SELECT = `
  SELECT pr.id, pr.pr_number, pr.location_id, l.name AS location_name, pr.status,
         pr.requested_by, u.username AS requested_by_name, pr.needed_by, pr.approval_id,
         pr.rejection_reason, pr.notes, pr.created_at,
         pr.updated_at, pr.updated_by, eu.username AS updated_by_name,
         pr.source_replenishment_id, rr.request_number AS source_replenishment_number
    FROM purchase_requests pr
    JOIN locations l ON l.id = pr.location_id
    LEFT JOIN users u ON u.id = pr.requested_by
    LEFT JOIN users eu ON eu.id = pr.updated_by
    LEFT JOIN replenishment_requests rr ON rr.id = pr.source_replenishment_id
`;

export class PurchaseRequestRepository {
  async nextPrNumber(client: PoolClient): Promise<string> {
    const period = new Date().toISOString().slice(0, 7).replace('-', '');
    const res = await client.query<{ last_number: number }>(
      `INSERT INTO document_counters (doc_type, period, last_number) VALUES ('PR', $1, 1)
       ON CONFLICT (doc_type, period) DO UPDATE SET last_number = document_counters.last_number + 1
       RETURNING last_number`,
      [period],
    );
    return formatCloudDocNumber('PR', period, res.rows[0]!.last_number);
  }

  async insertHeader(
    client: PoolClient,
    input: {
      prNumber: string;
      locationId: UUID;
      requestedBy: UUID;
      neededBy: string | null;
      notes?: string | null;
      sourceReplenishmentId?: UUID | null;
    },
  ): Promise<string> {
    const res = await client.query<{ id: string }>(
      `INSERT INTO purchase_requests
         (pr_number, location_id, requested_by, needed_by, notes, source_replenishment_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [
        input.prNumber,
        input.locationId,
        input.requestedBy,
        input.neededBy,
        input.notes ?? null,
        input.sourceReplenishmentId ?? null,
      ],
    );
    return res.rows[0]!.id;
  }

  /**
   * Header edit (migration 227). Only the fields the caller actually sent are
   * written — a PATCH that omits `notes` must not blank the notes — and
   * `updated_by`/`updated_at` always move, because the point of the endpoint is
   * that the edit is attributable.
   */
  async updateHeader(
    client: PoolClient,
    input: {
      prId: UUID;
      locationId?: UUID;
      neededBy?: string | null;
      notes?: string | null;
      status?: string;
      updatedBy: UUID;
    },
  ): Promise<void> {
    const sets: string[] = [];
    const args: unknown[] = [input.prId];
    let i = 2;
    if (input.locationId !== undefined) {
      sets.push(`location_id = $${i++}`);
      args.push(input.locationId);
    }
    if (input.neededBy !== undefined) {
      sets.push(`needed_by = $${i++}`);
      args.push(input.neededBy);
    }
    if (input.notes !== undefined) {
      sets.push(`notes = $${i++}`);
      args.push(input.notes);
    }
    if (input.status !== undefined) {
      sets.push(`status = $${i++}`);
      args.push(input.status);
    }
    // Last placeholder, so `i` is read here and never incremented again —
    // `i++` would leave a dead write that lint (rightly) flags.
    sets.push(`updated_by = $${i}`);
    args.push(input.updatedBy);
    sets.push('updated_at = NOW()');

    await client.query(`UPDATE purchase_requests SET ${sets.join(', ')} WHERE id = $1`, args);
  }

  /**
   * Replaces the whole line set. Delete-then-insert rather than a per-line
   * diff: `purchase_request_lines` carries `UNIQUE (pr_id, item_id)`, so a diff
   * would have to order its writes to avoid tripping that constraint when two
   * lines swap items. Both halves run inside the service's transaction, so a PR
   * is never observed line-less.
   */
  async deleteLines(client: PoolClient, prId: UUID): Promise<void> {
    await client.query(`DELETE FROM purchase_request_lines WHERE pr_id = $1`, [prId]);
  }

  /**
   * The PR's audit trail — the same `audit_log` the `@Audited()` interceptor
   * writes and `replenishment`'s `:id/history` reads, so this system has one
   * audit story rather than a second, divergent revisions table.
   */
  async history(client: PoolClient, prId: UUID): Promise<PrHistoryRow[]> {
    const res = await client.query<PrHistoryRow>(
      `SELECT a.id, a.user_id, u.name AS user_name, a.role_key, a.action,
              a.before_value, a.after_value, a.reason, a.occurred_at
         FROM audit_log a
         LEFT JOIN users u ON u.id = a.user_id
        WHERE a.entity_type = 'purchase_request' AND a.entity_id = $1
        ORDER BY a.occurred_at ASC`,
      [prId],
    );
    return res.rows;
  }

  async insertLine(
    client: PoolClient,
    input: {
      prId: UUID;
      itemId: UUID;
      unitId: UUID;
      qty: Qty;
      estPrice: Money;
      suggestedSupplierId: UUID | null;
    },
  ): Promise<string> {
    const res = await client.query<{ id: string }>(
      `INSERT INTO purchase_request_lines (pr_id, item_id, unit_id, qty, est_price, suggested_supplier_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [
        input.prId,
        input.itemId,
        input.unitId,
        input.qty,
        input.estPrice,
        input.suggestedSupplierId,
      ],
    );
    return res.rows[0]!.id;
  }

  async findHeader(client: PoolClient, id: string): Promise<PrHeaderRow | undefined> {
    const res = await client.query<PrHeaderRow>(`${HEADER_SELECT} WHERE pr.id = $1`, [id]);
    return res.rows[0];
  }

  async findLines(client: PoolClient, prId: string): Promise<PrLineRow[]> {
    const res = await client.query<PrLineRow>(
      `SELECT prl.id, prl.pr_id, prl.item_id, i.name AS item_name, prl.unit_id, un.code AS unit_code,
              prl.qty, prl.est_price, prl.suggested_supplier_id
         FROM purchase_request_lines prl
         JOIN items i ON i.id = prl.item_id
         JOIN units un ON un.id = prl.unit_id
        WHERE prl.pr_id = $1
        ORDER BY prl.id`,
      [prId],
    );
    return res.rows;
  }

  async listHeaders(
    client: PoolClient,
    query: { locationId?: string; status?: string; page: number; pageSize: number },
  ): Promise<{ rows: PrHeaderRow[]; total: number }> {
    const conds: string[] = [];
    const args: unknown[] = [];
    let i = 1;
    if (query.locationId) {
      conds.push(`pr.location_id = $${i++}`);
      args.push(query.locationId);
    }
    if (query.status) {
      conds.push(`pr.status = $${i++}`);
      args.push(query.status);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const offset = (query.page - 1) * query.pageSize;

    const [rows, count] = await Promise.all([
      client.query<PrHeaderRow>(
        `${HEADER_SELECT} ${where} ORDER BY pr.created_at DESC LIMIT $${i} OFFSET $${i + 1}`,
        [...args, query.pageSize, offset],
      ),
      client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM purchase_requests pr ${where}`,
        args,
      ),
    ]);
    return { rows: rows.rows, total: Number(count.rows[0]?.count ?? '0') };
  }

  async lineCount(client: PoolClient, prId: string): Promise<number> {
    const res = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM purchase_request_lines WHERE pr_id = $1`,
      [prId],
    );
    return Number(res.rows[0]?.count ?? '0');
  }

  async setStatus(client: PoolClient, prId: string, status: string): Promise<void> {
    await client.query(
      `UPDATE purchase_requests SET status = $2, updated_at = NOW() WHERE id = $1`,
      [prId, status],
    );
  }

  async setApprovalId(client: PoolClient, prId: string, approvalId: string): Promise<void> {
    await client.query(`UPDATE purchase_requests SET approval_id = $2 WHERE id = $1`, [
      prId,
      approvalId,
    ]);
  }

  async setRejection(
    client: PoolClient,
    prId: string,
    status: string,
    reason: string,
  ): Promise<void> {
    await client.query(
      `UPDATE purchase_requests SET status = $2, rejection_reason = $3, updated_at = NOW() WHERE id = $1`,
      [prId, status, reason],
    );
  }

  /**
   * Drops a stale rejection reason when a rejected PR is amended back to draft.
   * Separate from `updateHeader` because it is a different kind of statement:
   * "this objection no longer describes the document", not "the user edited a
   * field".
   */
  async clearRejection(client: PoolClient, prId: string): Promise<void> {
    await client.query(`UPDATE purchase_requests SET rejection_reason = NULL WHERE id = $1`, [
      prId,
    ]);
  }

  /**
   * An outlet's replenishment request plus its lines, for conversion into a PR.
   *
   * Read through the CALLER's client, so RLS still applies: central roles pass
   * `app_is_central()` and see every outlet's requests, while an outlet-scoped
   * user could only ever convert their own (migration 209's
   * `replenishment_requests_loc` policy). Cross-module read by design — a PR
   * born from a store request must copy that request's actual lines, and going
   * through the replenishment module's service would need an HTTP hop inside
   * one transaction.
   */
  async findReplenishmentForConversion(
    client: PoolClient,
    id: string,
  ): Promise<
    | {
        id: string;
        request_number: string;
        location_id: string;
        status: string;
        lines: { item_id: string; unit_id: string; qty_requested: Qty }[];
      }
    | undefined
  > {
    const header = await client.query<{
      id: string;
      request_number: string;
      location_id: string;
      status: string;
    }>(`SELECT id, request_number, location_id, status FROM replenishment_requests WHERE id = $1`, [
      id,
    ]);
    const row = header.rows[0];
    if (!row) return undefined;

    const lines = await client.query<{ item_id: string; unit_id: string; qty_requested: Qty }>(
      `SELECT item_id, unit_id, qty_requested
         FROM replenishment_request_lines
        WHERE request_id = $1
        ORDER BY id`,
      [id],
    );
    return { ...row, lines: lines.rows };
  }

  async estimatedTotal(client: PoolClient, prId: string): Promise<Money> {
    const res = await client.query<{ total: string }>(
      `SELECT COALESCE(SUM(qty::numeric * est_price::numeric), 0)::numeric(18,2)::text AS total FROM purchase_request_lines WHERE pr_id = $1`,
      [prId],
    );
    return (res.rows[0]?.total ?? '0.00') as Money;
  }
}
