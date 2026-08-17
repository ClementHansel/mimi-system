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
  needed_by: string | null;
  approval_id: string | null;
  rejection_reason: string | null;
  notes: string | null;
  created_at: Date;
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
         pr.rejection_reason, pr.notes, pr.created_at
    FROM purchase_requests pr
    JOIN locations l ON l.id = pr.location_id
    LEFT JOIN users u ON u.id = pr.requested_by
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

  async insertHeader(client: PoolClient, input: { prNumber: string; locationId: UUID; requestedBy: UUID; neededBy: string | null }): Promise<string> {
    const res = await client.query<{ id: string }>(
      `INSERT INTO purchase_requests (pr_number, location_id, requested_by, needed_by)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [input.prNumber, input.locationId, input.requestedBy, input.neededBy],
    );
    return res.rows[0]!.id;
  }

  async insertLine(client: PoolClient, input: { prId: UUID; itemId: UUID; unitId: UUID; qty: Qty; estPrice: Money; suggestedSupplierId: UUID | null }): Promise<string> {
    const res = await client.query<{ id: string }>(
      `INSERT INTO purchase_request_lines (pr_id, item_id, unit_id, qty, est_price, suggested_supplier_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [input.prId, input.itemId, input.unitId, input.qty, input.estPrice, input.suggestedSupplierId],
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
    if (query.locationId) { conds.push(`pr.location_id = $${i++}`); args.push(query.locationId); }
    if (query.status) { conds.push(`pr.status = $${i++}`); args.push(query.status); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const offset = (query.page - 1) * query.pageSize;

    const [rows, count] = await Promise.all([
      client.query<PrHeaderRow>(`${HEADER_SELECT} ${where} ORDER BY pr.created_at DESC LIMIT $${i} OFFSET $${i + 1}`, [...args, query.pageSize, offset]),
      client.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM purchase_requests pr ${where}`, args),
    ]);
    return { rows: rows.rows, total: Number(count.rows[0]?.count ?? '0') };
  }

  async lineCount(client: PoolClient, prId: string): Promise<number> {
    const res = await client.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM purchase_request_lines WHERE pr_id = $1`, [prId]);
    return Number(res.rows[0]?.count ?? '0');
  }

  async setStatus(client: PoolClient, prId: string, status: string): Promise<void> {
    await client.query(`UPDATE purchase_requests SET status = $2, updated_at = NOW() WHERE id = $1`, [prId, status]);
  }

  async setApprovalId(client: PoolClient, prId: string, approvalId: string): Promise<void> {
    await client.query(`UPDATE purchase_requests SET approval_id = $2 WHERE id = $1`, [prId, approvalId]);
  }

  async setRejection(client: PoolClient, prId: string, status: string, reason: string): Promise<void> {
    await client.query(`UPDATE purchase_requests SET status = $2, rejection_reason = $3, updated_at = NOW() WHERE id = $1`, [prId, status, reason]);
  }

  async estimatedTotal(client: PoolClient, prId: string): Promise<Money> {
    const res = await client.query<{ total: string }>(
      `SELECT COALESCE(SUM(qty::numeric * est_price::numeric), 0)::numeric(18,2)::text AS total FROM purchase_request_lines WHERE pr_id = $1`,
      [prId],
    );
    return (res.rows[0]?.total ?? '0.00') as Money;
  }
}
