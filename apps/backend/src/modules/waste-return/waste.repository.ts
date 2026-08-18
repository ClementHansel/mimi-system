import type { PoolClient } from 'pg';
import { formatCloudDocNumber } from '@mimi/shared';
import type { Money, Qty, UUID } from '@mimi/shared';

export interface WasteRecordRow {
  id: string;
  waste_number: string;
  batch_id: string;
  location_id: string;
  location_name: string;
  storage_area_id: string;
  storage_area_name: string;
  item_id: string;
  item_name: string;
  qty: Qty;
  unit_cost: Money;
  reason: string;
  reason_detail: string | null;
  status: string;
  reported_by: string;
  reported_by_name: string | null;
  approval_id: string | null;
  approved_by: string | null;
  approved_at: Date | null;
  rejection_reason: string | null;
  occurred_at: Date;
}

const SELECT = `
  SELECT w.id, w.waste_number, w.batch_id, w.location_id, l.name AS location_name, w.storage_area_id, sa.name AS storage_area_name,
         w.item_id, i.name AS item_name, w.qty, w.unit_cost, w.reason, w.reason_detail, w.status,
         w.reported_by, u.username AS reported_by_name, w.approval_id, w.approved_by, w.approved_at, w.rejection_reason, w.occurred_at
    FROM waste_records w
    JOIN locations l ON l.id = w.location_id
    JOIN storage_areas sa ON sa.id = w.storage_area_id
    JOIN items i ON i.id = w.item_id
    LEFT JOIN users u ON u.id = w.reported_by
`;

export class WasteRepository {
  async nextWasteNumber(client: PoolClient): Promise<string> {
    const period = new Date().toISOString().slice(0, 7).replace('-', '');
    const res = await client.query<{ last_number: number }>(
      `INSERT INTO document_counters (doc_type, period, last_number) VALUES ('WST', $1, 1)
       ON CONFLICT (doc_type, period) DO UPDATE SET last_number = document_counters.last_number + 1
       RETURNING last_number`,
      [period],
    );
    return formatCloudDocNumber('WST', period, res.rows[0]!.last_number);
  }

  async insertRecord(
    client: PoolClient,
    input: {
      wasteNumber: string;
      batchId: UUID;
      locationId: UUID;
      storageAreaId: UUID;
      itemId: UUID;
      qty: Qty;
      reason: string;
      reasonDetail: string | null;
      reportedBy: UUID;
    },
  ): Promise<string> {
    const res = await client.query<{ id: string }>(
      `INSERT INTO waste_records (waste_number, batch_id, location_id, storage_area_id, item_id, qty, reason, reason_detail, reported_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [
        input.wasteNumber,
        input.batchId,
        input.locationId,
        input.storageAreaId,
        input.itemId,
        input.qty,
        input.reason,
        input.reasonDetail,
        input.reportedBy,
      ],
    );
    return res.rows[0]!.id;
  }

  async findById(client: PoolClient, id: string): Promise<WasteRecordRow | undefined> {
    const res = await client.query<WasteRecordRow>(`${SELECT} WHERE w.id = $1`, [id]);
    return res.rows[0];
  }

  async findByBatch(client: PoolClient, batchId: string): Promise<WasteRecordRow[]> {
    const res = await client.query<WasteRecordRow>(
      `${SELECT} WHERE w.batch_id = $1 ORDER BY w.id`,
      [batchId],
    );
    return res.rows;
  }

  async listRecords(
    client: PoolClient,
    query: {
      locationId?: string;
      status?: string;
      reason?: string;
      from?: string;
      to?: string;
      page: number;
      pageSize: number;
    },
  ): Promise<{ rows: WasteRecordRow[]; total: number }> {
    const conds: string[] = [];
    const args: unknown[] = [];
    let i = 1;
    if (query.locationId) {
      conds.push(`w.location_id = $${i++}`);
      args.push(query.locationId);
    }
    if (query.status) {
      conds.push(`w.status = $${i++}`);
      args.push(query.status);
    }
    if (query.reason) {
      conds.push(`w.reason = $${i++}`);
      args.push(query.reason);
    }
    if (query.from) {
      conds.push(`w.occurred_at >= $${i++}`);
      args.push(query.from);
    }
    if (query.to) {
      conds.push(`w.occurred_at <= $${i++}`);
      args.push(query.to);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const offset = (query.page - 1) * query.pageSize;

    const [rows, count] = await Promise.all([
      client.query<WasteRecordRow>(
        `${SELECT} ${where} ORDER BY w.occurred_at DESC LIMIT $${i} OFFSET $${i + 1}`,
        [...args, query.pageSize, offset],
      ),
      client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM waste_records w ${where}`,
        args,
      ),
    ]);
    return { rows: rows.rows, total: Number(count.rows[0]?.count ?? '0') };
  }

  async setApprovalId(client: PoolClient, id: string, approvalId: string): Promise<void> {
    await client.query(`UPDATE waste_records SET approval_id = $2 WHERE id = $1`, [id, approvalId]);
  }

  async setUnitCost(client: PoolClient, id: string, unitCost: Money): Promise<void> {
    await client.query(`UPDATE waste_records SET unit_cost = $2 WHERE id = $1`, [id, unitCost]);
  }

  async setApproved(
    client: PoolClient,
    id: string,
    approvedBy: UUID,
    approvedAt: string,
  ): Promise<void> {
    await client.query(
      `UPDATE waste_records SET status = 'approved', approved_by = $2, approved_at = $3, updated_at = NOW() WHERE id = $1`,
      [id, approvedBy, approvedAt],
    );
  }

  async setRejected(client: PoolClient, id: string, reason: string): Promise<void> {
    await client.query(
      `UPDATE waste_records SET status = 'rejected', rejection_reason = $2, updated_at = NOW() WHERE id = $1`,
      [id, reason],
    );
  }

  async itemAvgCost(client: PoolClient, itemId: UUID): Promise<Money> {
    const res = await client.query<{ avg_cost: string }>(
      `SELECT avg_cost FROM items WHERE id = $1`,
      [itemId],
    );
    return (res.rows[0]?.avg_cost ?? '0.00') as Money;
  }
}
