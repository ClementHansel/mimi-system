import type { PoolClient } from 'pg';
import { formatCloudDocNumber } from '@mimi/shared';
import type { Money, Qty, UUID } from '@mimi/shared';

export interface ReturnHeaderRow {
  id: string;
  return_number: string;
  direction: string;
  from_location_id: string;
  from_location_name: string;
  to_location_id: string | null;
  to_location_name: string | null;
  supplier_id: string | null;
  supplier_name: string | null;
  status: string;
  requested_by: string;
  requested_by_name: string | null;
  approval_id: string | null;
  approved_by: string | null;
  approved_at: Date | null;
  rejection_reason: string | null;
  shipped_at: Date | null;
  received_by: string | null;
  received_at: Date | null;
  notes: string | null;
}

export interface ReturnLineRow {
  id: string;
  return_id: string;
  item_id: string;
  item_name: string;
  storage_area_id: string;
  qty: Qty;
  condition: string;
  reason: string;
  qty_received: Qty | null;
  unit_cost: Money;
}

const HEADER_SELECT = `
  SELECT r.id, r.return_number, r.direction, r.from_location_id, fl.name AS from_location_name,
         r.to_location_id, tl.name AS to_location_name, r.supplier_id, s.name AS supplier_name,
         r.status, r.requested_by, u.username AS requested_by_name, r.approval_id, r.approved_by, r.approved_at,
         r.rejection_reason, r.shipped_at, r.received_by, r.received_at, r.notes
    FROM returns r
    JOIN locations fl ON fl.id = r.from_location_id
    LEFT JOIN locations tl ON tl.id = r.to_location_id
    LEFT JOIN suppliers s ON s.id = r.supplier_id
    LEFT JOIN users u ON u.id = r.requested_by
`;

export class ReturnRepository {
  async nextReturnNumber(client: PoolClient): Promise<string> {
    const period = new Date().toISOString().slice(0, 7).replace('-', '');
    const res = await client.query<{ last_number: number }>(
      `INSERT INTO document_counters (doc_type, period, last_number) VALUES ('RET', $1, 1)
       ON CONFLICT (doc_type, period) DO UPDATE SET last_number = document_counters.last_number + 1
       RETURNING last_number`,
      [period],
    );
    return formatCloudDocNumber('RET', period, res.rows[0]!.last_number);
  }

  async insertHeader(
    client: PoolClient,
    input: {
      returnNumber: string;
      direction: string;
      fromLocationId: UUID;
      toLocationId: UUID | null;
      supplierId: UUID | null;
      requestedBy: UUID;
    },
  ): Promise<string> {
    const res = await client.query<{ id: string }>(
      `INSERT INTO returns (return_number, direction, from_location_id, to_location_id, supplier_id, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [
        input.returnNumber,
        input.direction,
        input.fromLocationId,
        input.toLocationId,
        input.supplierId,
        input.requestedBy,
      ],
    );
    return res.rows[0]!.id;
  }

  async insertLine(
    client: PoolClient,
    input: {
      returnId: UUID;
      itemId: UUID;
      storageAreaId: UUID;
      qty: Qty;
      condition: string;
      reason: string;
      unitCost: Money;
    },
  ): Promise<string> {
    const res = await client.query<{ id: string }>(
      `INSERT INTO return_lines (return_id, item_id, storage_area_id, qty, condition, reason, unit_cost)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [
        input.returnId,
        input.itemId,
        input.storageAreaId,
        input.qty,
        input.condition,
        input.reason,
        input.unitCost,
      ],
    );
    return res.rows[0]!.id;
  }

  async findHeader(client: PoolClient, id: string): Promise<ReturnHeaderRow | undefined> {
    const res = await client.query<ReturnHeaderRow>(`${HEADER_SELECT} WHERE r.id = $1`, [id]);
    return res.rows[0];
  }

  async findLines(client: PoolClient, returnId: string): Promise<ReturnLineRow[]> {
    const res = await client.query<ReturnLineRow>(
      `SELECT rl.id, rl.return_id, rl.item_id, i.name AS item_name, rl.storage_area_id, rl.qty, rl.condition, rl.reason, rl.qty_received, rl.unit_cost
         FROM return_lines rl JOIN items i ON i.id = rl.item_id WHERE rl.return_id = $1 ORDER BY rl.id`,
      [returnId],
    );
    return res.rows;
  }

  async findLineById(
    client: PoolClient,
    returnId: string,
    lineId: string,
  ): Promise<ReturnLineRow | undefined> {
    const res = await client.query<ReturnLineRow>(
      `SELECT rl.id, rl.return_id, rl.item_id, i.name AS item_name, rl.storage_area_id, rl.qty, rl.condition, rl.reason, rl.qty_received, rl.unit_cost
         FROM return_lines rl JOIN items i ON i.id = rl.item_id WHERE rl.return_id = $1 AND rl.id = $2`,
      [returnId, lineId],
    );
    return res.rows[0];
  }

  async listHeaders(
    client: PoolClient,
    query: {
      direction?: string;
      locationId?: string;
      status?: string;
      page: number;
      pageSize: number;
    },
  ): Promise<{ rows: ReturnHeaderRow[]; total: number }> {
    const conds: string[] = [];
    const args: unknown[] = [];
    let i = 1;
    if (query.direction) {
      conds.push(`r.direction = $${i++}`);
      args.push(query.direction);
    }
    if (query.locationId) {
      conds.push(`(r.from_location_id = $${i} OR r.to_location_id = $${i})`);
      args.push(query.locationId);
      i++;
    }
    if (query.status) {
      conds.push(`r.status = $${i++}`);
      args.push(query.status);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const offset = (query.page - 1) * query.pageSize;

    const [rows, count] = await Promise.all([
      client.query<ReturnHeaderRow>(
        `${HEADER_SELECT} ${where} ORDER BY r.id DESC LIMIT $${i} OFFSET $${i + 1}`,
        [...args, query.pageSize, offset],
      ),
      client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM returns r ${where}`,
        args,
      ),
    ]);
    return { rows: rows.rows, total: Number(count.rows[0]?.count ?? '0') };
  }

  async setApprovalId(client: PoolClient, id: string, approvalId: string): Promise<void> {
    await client.query(`UPDATE returns SET approval_id = $2 WHERE id = $1`, [id, approvalId]);
  }

  async setStatus(client: PoolClient, id: string, status: string): Promise<void> {
    await client.query(`UPDATE returns SET status = $2, updated_at = NOW() WHERE id = $1`, [
      id,
      status,
    ]);
  }

  async setApproved(
    client: PoolClient,
    id: string,
    approvedBy: UUID,
    approvedAt: string,
  ): Promise<void> {
    await client.query(
      `UPDATE returns SET status = 'approved', approved_by = $2, approved_at = $3, updated_at = NOW() WHERE id = $1`,
      [id, approvedBy, approvedAt],
    );
  }

  async setRejected(client: PoolClient, id: string, reason: string): Promise<void> {
    await client.query(
      `UPDATE returns SET status = 'rejected', rejection_reason = $2, updated_at = NOW() WHERE id = $1`,
      [id, reason],
    );
  }

  async setShipped(client: PoolClient, id: string, shippedAt: string): Promise<void> {
    await client.query(
      `UPDATE returns SET status = 'in_transit', shipped_at = $2, updated_at = NOW() WHERE id = $1`,
      [id, shippedAt],
    );
  }

  async setReceived(
    client: PoolClient,
    id: string,
    receivedBy: UUID,
    receivedAt: string,
  ): Promise<void> {
    await client.query(
      `UPDATE returns SET status = 'received', received_by = $2, received_at = $3, updated_at = NOW() WHERE id = $1`,
      [id, receivedBy, receivedAt],
    );
  }

  async setCompleted(client: PoolClient, id: string): Promise<void> {
    await client.query(
      `UPDATE returns SET status = 'completed', updated_at = NOW() WHERE id = $1`,
      [id],
    );
  }

  async setLineReceived(client: PoolClient, lineId: string, qtyReceived: Qty): Promise<void> {
    await client.query(`UPDATE return_lines SET qty_received = $2 WHERE id = $1`, [
      lineId,
      qtyReceived,
    ]);
  }

  async proofUrls(
    client: PoolClient,
    returnId: string,
  ): Promise<{ shipped: string[]; received: string[] }> {
    const res = await client.query<{ id: string; kind: string }>(
      `SELECT id, kind FROM attachments WHERE entity_type = 'return' AND entity_id = $1 ORDER BY created_at`,
      [returnId],
    );
    return {
      shipped: res.rows.filter((r) => r.kind === 'return_proof').map((r) => r.id),
      received: res.rows.filter((r) => r.kind === 'receiving_photo').map((r) => r.id),
    };
  }
}
