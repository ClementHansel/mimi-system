import type { PoolClient } from 'pg';
import { formatCloudDocNumber } from '@mimi/shared';
import type { Money, Qty, UUID } from '@mimi/shared';

export interface PoHeaderRow {
  id: string;
  po_number: string;
  supplier_id: string;
  supplier_name: string;
  location_id: string;
  pr_id: string | null;
  status: string;
  order_date: Date;
  expected_date: Date | null;
  payment_terms_days: number;
  subtotal: Money;
  tax: Money;
  total: Money;
  approval_id: string | null;
  payment_verification_id: string | null;
  /** `payment_verifications.status` for `header.payment_verification_id` (LEFT JOIN — `null` until receiving creates one). CONTRACTS.md §4.11's `paymentStatus`. */
  payment_status: string | null;
  created_by: string;
  cancel_reason: string | null;
  notes: string | null;
}

export interface PoLineRow {
  id: string;
  po_id: string;
  item_id: string;
  item_name: string;
  unit_id: string;
  unit_code: string;
  qty_ordered: Qty;
  unit_price: Money;
  line_total: Money;
  qty_received: Qty;
}

const HEADER_SELECT = `
  SELECT po.id, po.po_number, po.supplier_id, s.name AS supplier_name, po.location_id, po.pr_id, po.status,
         po.order_date, po.expected_date, po.payment_terms_days, po.subtotal, po.tax, po.total,
         po.approval_id, po.payment_verification_id, pv.status AS payment_status,
         po.created_by, po.cancel_reason, po.notes
    FROM purchase_orders po
    JOIN suppliers s ON s.id = po.supplier_id
    LEFT JOIN payment_verifications pv ON pv.id = po.payment_verification_id
`;

export class PurchaseOrderRepository {
  async nextPoNumber(client: PoolClient): Promise<string> {
    const period = new Date().toISOString().slice(0, 7).replace('-', '');
    const res = await client.query<{ last_number: number }>(
      `INSERT INTO document_counters (doc_type, period, last_number) VALUES ('PO', $1, 1)
       ON CONFLICT (doc_type, period) DO UPDATE SET last_number = document_counters.last_number + 1
       RETURNING last_number`,
      [period],
    );
    return formatCloudDocNumber('PO', period, res.rows[0]!.last_number);
  }

  async nextReceiptNumber(client: PoolClient): Promise<string> {
    const period = new Date().toISOString().slice(0, 7).replace('-', '');
    const res = await client.query<{ last_number: number }>(
      `INSERT INTO document_counters (doc_type, period, last_number) VALUES ('GR', $1, 1)
       ON CONFLICT (doc_type, period) DO UPDATE SET last_number = document_counters.last_number + 1
       RETURNING last_number`,
      [period],
    );
    return formatCloudDocNumber('GR', period, res.rows[0]!.last_number);
  }

  async insertHeader(client: PoolClient, input: {
    poNumber: string; supplierId: UUID; locationId: UUID; prId: UUID | null; orderDate: string; expectedDate: string | null;
    paymentTermsDays: number; createdBy: UUID; notes: string | null;
  }): Promise<string> {
    const res = await client.query<{ id: string }>(
      `INSERT INTO purchase_orders (po_number, supplier_id, location_id, pr_id, order_date, expected_date, payment_terms_days, created_by, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [input.poNumber, input.supplierId, input.locationId, input.prId, input.orderDate, input.expectedDate, input.paymentTermsDays, input.createdBy, input.notes],
    );
    return res.rows[0]!.id;
  }

  async insertLine(client: PoolClient, input: { poId: UUID; itemId: UUID; unitId: UUID; qtyOrdered: Qty; unitPrice: Money; lineTotal: Money }): Promise<string> {
    const res = await client.query<{ id: string }>(
      `INSERT INTO po_lines (po_id, item_id, unit_id, qty_ordered, unit_price, line_total)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [input.poId, input.itemId, input.unitId, input.qtyOrdered, input.unitPrice, input.lineTotal],
    );
    return res.rows[0]!.id;
  }

  async deleteLines(client: PoolClient, poId: UUID): Promise<void> {
    await client.query(`DELETE FROM po_lines WHERE po_id = $1`, [poId]);
  }

  async setTotals(client: PoolClient, poId: UUID, subtotal: Money, tax: Money, total: Money): Promise<void> {
    await client.query(`UPDATE purchase_orders SET subtotal = $2, tax = $3, total = $4, updated_at = NOW() WHERE id = $1`, [poId, subtotal, tax, total]);
  }

  async findHeader(client: PoolClient, id: string): Promise<PoHeaderRow | undefined> {
    const res = await client.query<PoHeaderRow>(`${HEADER_SELECT} WHERE po.id = $1`, [id]);
    return res.rows[0];
  }

  async findLines(client: PoolClient, poId: string): Promise<PoLineRow[]> {
    const res = await client.query<PoLineRow>(
      `SELECT pol.id, pol.po_id, pol.item_id, i.name AS item_name, pol.unit_id, un.code AS unit_code,
              pol.qty_ordered, pol.unit_price, pol.line_total, pol.qty_received
         FROM po_lines pol
         JOIN items i ON i.id = pol.item_id
         JOIN units un ON un.id = pol.unit_id
        WHERE pol.po_id = $1
        ORDER BY pol.id`,
      [poId],
    );
    return res.rows;
  }

  async findLineById(client: PoolClient, poId: string, lineId: string): Promise<PoLineRow | undefined> {
    const res = await client.query<PoLineRow>(
      `SELECT pol.id, pol.po_id, pol.item_id, i.name AS item_name, pol.unit_id, un.code AS unit_code,
              pol.qty_ordered, pol.unit_price, pol.line_total, pol.qty_received
         FROM po_lines pol
         JOIN items i ON i.id = pol.item_id
         JOIN units un ON un.id = pol.unit_id
        WHERE pol.po_id = $1 AND pol.id = $2`,
      [poId, lineId],
    );
    return res.rows[0];
  }

  async listHeaders(
    client: PoolClient,
    query: { supplierId?: string; status?: string; from?: string; to?: string; page: number; pageSize: number },
  ): Promise<{ rows: PoHeaderRow[]; total: number }> {
    const conds: string[] = [];
    const args: unknown[] = [];
    let i = 1;
    if (query.supplierId) { conds.push(`po.supplier_id = $${i++}`); args.push(query.supplierId); }
    if (query.status) { conds.push(`po.status = $${i++}`); args.push(query.status); }
    if (query.from) { conds.push(`po.order_date >= $${i++}`); args.push(query.from); }
    if (query.to) { conds.push(`po.order_date <= $${i++}`); args.push(query.to); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const offset = (query.page - 1) * query.pageSize;

    const [rows, count] = await Promise.all([
      client.query<PoHeaderRow>(`${HEADER_SELECT} ${where} ORDER BY po.order_date DESC LIMIT $${i} OFFSET $${i + 1}`, [...args, query.pageSize, offset]),
      client.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM purchase_orders po ${where}`, args),
    ]);
    return { rows: rows.rows, total: Number(count.rows[0]?.count ?? '0') };
  }

  async setStatus(client: PoolClient, poId: string, status: string): Promise<void> {
    await client.query(`UPDATE purchase_orders SET status = $2, updated_at = NOW() WHERE id = $1`, [poId, status]);
  }

  async setApprovalId(client: PoolClient, poId: string, approvalId: string): Promise<void> {
    await client.query(`UPDATE purchase_orders SET approval_id = $2 WHERE id = $1`, [poId, approvalId]);
  }

  async setCancelled(client: PoolClient, poId: string, reason: string): Promise<void> {
    await client.query(`UPDATE purchase_orders SET status = 'cancelled', cancel_reason = $2, updated_at = NOW() WHERE id = $1`, [poId, reason]);
  }

  async setPaymentVerificationId(client: PoolClient, poId: string, pvId: string): Promise<void> {
    await client.query(`UPDATE purchase_orders SET payment_verification_id = $2 WHERE id = $1`, [poId, pvId]);
  }

  async incrementLineReceived(client: PoolClient, lineId: string, qty: Qty): Promise<void> {
    await client.query(`UPDATE po_lines SET qty_received = qty_received + $2 WHERE id = $1`, [lineId, qty]);
  }

  async insertReceipt(client: PoolClient, input: { receiptNumber: string; poId: UUID; receivedBy: UUID; notes: string | null }): Promise<string> {
    const res = await client.query<{ id: string }>(
      `INSERT INTO po_receipts (receipt_number, po_id, received_by, status, notes) VALUES ($1,$2,$3,'verified',$4) RETURNING id`,
      [input.receiptNumber, input.poId, input.receivedBy, input.notes],
    );
    return res.rows[0]!.id;
  }

  async insertReceiptLine(client: PoolClient, input: { poReceiptId: UUID; poLineId: UUID; storageAreaId: UUID; qtyReceived: Qty; conditionNotes: string | null }): Promise<void> {
    await client.query(
      `INSERT INTO po_receipt_lines (po_receipt_id, po_line_id, storage_area_id, qty_received, condition_notes) VALUES ($1,$2,$3,$4,$5)`,
      [input.poReceiptId, input.poLineId, input.storageAreaId, input.qtyReceived, input.conditionNotes],
    );
  }

  async getItemCosting(client: PoolClient, itemId: UUID): Promise<{ name: string; storageType: string; avgCost: Money; qtyOnHand: Qty }> {
    const res = await client.query<{ name: string; storage_type: string; avg_cost: string; qty_on_hand: string }>(
      `SELECT i.name, i.storage_type, i.avg_cost,
              COALESCE((SELECT SUM(qty_on_hand) FROM stock_balances WHERE item_id = i.id), 0)::numeric(14,3)::text AS qty_on_hand
         FROM items i WHERE i.id = $1`,
      [itemId],
    );
    const row = res.rows[0];
    if (!row) throw new Error(`Item ${itemId} not found`);
    return { name: row.name, storageType: row.storage_type, avgCost: row.avg_cost as Money, qtyOnHand: row.qty_on_hand as Qty };
  }

  async updateItemCost(client: PoolClient, itemId: UUID, avgCost: Money, lastPurchaseCost: Money): Promise<void> {
    await client.query(`UPDATE items SET avg_cost = $2, last_purchase_cost = $3, updated_at = NOW() WHERE id = $1`, [itemId, avgCost, lastPurchaseCost]);
  }

  async appendPriceHistory(client: PoolClient, input: { supplierId: UUID; itemId: UUID; price: Money; effectiveDate: string; recordedBy: UUID }): Promise<void> {
    await client.query(
      `INSERT INTO supplier_price_history (supplier_id, item_id, price, effective_date, source, recorded_by) VALUES ($1,$2,$3,$4,'po',$5)`,
      [input.supplierId, input.itemId, input.price, input.effectiveDate, input.recordedBy],
    );
  }

  async storageAreaCheck(client: PoolClient, storageAreaId: UUID): Promise<{ type: string; name: string } | undefined> {
    const res = await client.query<{ type: string; name: string }>(`SELECT type, name FROM storage_areas WHERE id = $1 AND is_active = true`, [storageAreaId]);
    return res.rows[0];
  }
}
