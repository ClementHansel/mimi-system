import type { PoolClient } from 'pg';
import { formatCloudDocNumber } from '@mimi/shared';
import type { Money, Qty, UUID } from '@mimi/shared';

export interface PettyCashHeaderRow {
  id: string;
  pc_number: string;
  location_id: string;
  location_name: string;
  purchased_by: string;
  purchased_by_name: string | null;
  purchase_date: Date;
  store_name: string;
  total_amount: Money;
  status: string;
  verified_by: string | null;
  verified_by_name: string | null;
  verified_at: Date | null;
  rejection_reason: string | null;
  payment_verification_id: string | null;
  notes: string | null;
}

export interface PettyCashLineRow {
  id: string;
  petty_cash_id: string;
  description: string;
  item_id: string | null;
  storage_area_id: string | null;
  qty: Qty | null;
  amount: Money;
  expense_category: string;
}

const HEADER_SELECT = `
  SELECT pc.id, pc.pc_number, pc.location_id, l.name AS location_name, pc.purchased_by, ub.username AS purchased_by_name,
         pc.purchase_date, pc.store_name, pc.total_amount, pc.status, pc.verified_by, uv.username AS verified_by_name,
         pc.verified_at, pc.rejection_reason, pc.payment_verification_id, pc.notes
    FROM petty_cash pc
    JOIN locations l ON l.id = pc.location_id
    LEFT JOIN users ub ON ub.id = pc.purchased_by
    LEFT JOIN users uv ON uv.id = pc.verified_by
`;

export class PettyCashRepository {
  async nextPcNumber(client: PoolClient): Promise<string> {
    const period = new Date().toISOString().slice(0, 7).replace('-', '');
    const res = await client.query<{ last_number: number }>(
      `INSERT INTO document_counters (doc_type, period, last_number) VALUES ('PC', $1, 1)
       ON CONFLICT (doc_type, period) DO UPDATE SET last_number = document_counters.last_number + 1
       RETURNING last_number`,
      [period],
    );
    return formatCloudDocNumber('PC', period, res.rows[0]!.last_number);
  }

  async insertHeader(
    client: PoolClient,
    input: {
      id?: UUID;
      pcNumber: string;
      locationId: UUID;
      purchasedBy: UUID;
      purchaseDate: string;
      storeName: string;
      totalAmount: Money;
    },
  ): Promise<string> {
    const res = await client.query<{ id: string }>(
      // B-11: `id` is optional — the REST path omits it and the database mints
      // one; the SYNC path supplies the id the DEVICE minted offline, which is
      // what its `petty_cash_lines` and any later event already reference.
      // The pc NUMBER is always issued here, never taken from the device: two
      // outlets claiming offline would both mint the same one.
      `INSERT INTO petty_cash (id, pc_number, location_id, purchased_by, purchase_date, store_name, total_amount)
       VALUES (COALESCE($7::uuid, gen_random_uuid()),$1,$2,$3,$4,$5,$6) RETURNING id`,
      [
        input.pcNumber,
        input.locationId,
        input.purchasedBy,
        input.purchaseDate,
        input.storeName,
        input.totalAmount,
        input.id ?? null,
      ],
    );
    return res.rows[0]!.id;
  }

  async insertLine(
    client: PoolClient,
    input: {
      pettyCashId: UUID;
      description: string;
      itemId: UUID | null;
      storageAreaId: UUID | null;
      qty: Qty | null;
      amount: Money;
      expenseCategory: string;
    },
  ): Promise<string> {
    const res = await client.query<{ id: string }>(
      `INSERT INTO petty_cash_lines (petty_cash_id, description, item_id, storage_area_id, qty, amount, expense_category)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [
        input.pettyCashId,
        input.description,
        input.itemId,
        input.storageAreaId,
        input.qty,
        input.amount,
        input.expenseCategory,
      ],
    );
    return res.rows[0]!.id;
  }

  async findHeader(client: PoolClient, id: string): Promise<PettyCashHeaderRow | undefined> {
    const res = await client.query<PettyCashHeaderRow>(`${HEADER_SELECT} WHERE pc.id = $1`, [id]);
    return res.rows[0];
  }

  async findLines(client: PoolClient, pettyCashId: string): Promise<PettyCashLineRow[]> {
    const res = await client.query<PettyCashLineRow>(
      `SELECT id, petty_cash_id, description, item_id, storage_area_id, qty, amount, expense_category FROM petty_cash_lines WHERE petty_cash_id = $1 ORDER BY id`,
      [pettyCashId],
    );
    return res.rows;
  }

  async listHeaders(
    client: PoolClient,
    query: {
      locationId?: string;
      status?: string;
      from?: string;
      to?: string;
      page: number;
      pageSize: number;
    },
  ): Promise<{ rows: PettyCashHeaderRow[]; total: number }> {
    const conds: string[] = [];
    const args: unknown[] = [];
    let i = 1;
    if (query.locationId) {
      conds.push(`pc.location_id = $${i++}`);
      args.push(query.locationId);
    }
    if (query.status) {
      conds.push(`pc.status = $${i++}`);
      args.push(query.status);
    }
    if (query.from) {
      conds.push(`pc.purchase_date >= $${i++}`);
      args.push(query.from);
    }
    if (query.to) {
      conds.push(`pc.purchase_date <= $${i++}`);
      args.push(query.to);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const offset = (query.page - 1) * query.pageSize;

    const [rows, count] = await Promise.all([
      client.query<PettyCashHeaderRow>(
        `${HEADER_SELECT} ${where} ORDER BY pc.purchase_date DESC LIMIT $${i} OFFSET $${i + 1}`,
        [...args, query.pageSize, offset],
      ),
      client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM petty_cash pc ${where}`,
        args,
      ),
    ]);
    return { rows: rows.rows, total: Number(count.rows[0]?.count ?? '0') };
  }

  async setVerified(
    client: PoolClient,
    id: string,
    verifiedBy: UUID,
    verifiedAt: string,
  ): Promise<void> {
    await client.query(
      `UPDATE petty_cash SET status = 'verified', verified_by = $2, verified_at = $3, updated_at = NOW() WHERE id = $1`,
      [id, verifiedBy, verifiedAt],
    );
  }

  async setRejected(client: PoolClient, id: string, reason: string): Promise<void> {
    await client.query(
      `UPDATE petty_cash SET status = 'rejected', rejection_reason = $2, updated_at = NOW() WHERE id = $1`,
      [id, reason],
    );
  }

  async setPaymentVerificationId(client: PoolClient, id: string, pvId: string): Promise<void> {
    await client.query(`UPDATE petty_cash SET payment_verification_id = $2 WHERE id = $1`, [
      id,
      pvId,
    ]);
  }

  async itemCosting(
    client: PoolClient,
    itemId: UUID,
  ): Promise<{ avgCost: Money; qtyOnHand: Qty } | undefined> {
    const res = await client.query<{ avg_cost: string; qty_on_hand: string }>(
      `SELECT avg_cost, COALESCE((SELECT SUM(qty_on_hand) FROM stock_balances WHERE item_id = $1), 0)::numeric(14,3)::text AS qty_on_hand FROM items WHERE id = $1`,
      [itemId],
    );
    const row = res.rows[0];
    return row ? { avgCost: row.avg_cost as Money, qtyOnHand: row.qty_on_hand as Qty } : undefined;
  }

  async updateItemCost(
    client: PoolClient,
    itemId: UUID,
    avgCost: Money,
    lastPurchaseCost: Money,
  ): Promise<void> {
    await client.query(
      `UPDATE items SET avg_cost = $2, last_purchase_cost = $3, updated_at = NOW() WHERE id = $1`,
      [itemId, avgCost, lastPurchaseCost],
    );
  }
}
