/**
 * Raw read-side SQL for the `documents` resolvers — deliberately its OWN
 * queries, not a reuse of any other module's repository/service.
 *
 * Two reasons, both concrete:
 *   1. Surat Jalan needs `surat_jalan.notes` and `items.sku`, neither of
 *      which `modules/delivery/queries.ts` selects — that file builds the
 *      `SuratJalan` DTO for the delivery/driver workflow, a different
 *      contract with different fields, and widening its SELECTs to add
 *      columns only this module needs would be a drive-by change to a
 *      module owned elsewhere.
 *   2. POS sale/receipt and PO-invoice data would otherwise mean importing
 *      `PosSaleService`/`PurchaseOrderService`, both of which build their
 *      OWN response DTOs (with their own city-of-truth conventions) rather
 *      than a resolver-shaped row. A resolver wants exactly the columns its
 *      field tokens need, nothing more — so this file selects them directly.
 *
 * Every function here is a plain SELECT on the request's own `PoolClient` —
 * no writes, so `withWrite`/`db-tx.ts` has no part in this file.
 */
import type { PoolClient } from 'pg';

// ── Receipt / invoice-from-sale ─────────────────────────────────────────────

export interface SaleHeaderRow {
  id: string;
  receipt_number: string;
  client_id: string;
  location_id: string;
  location_name: string;
  location_address: string | null;
  location_phone: string | null;
  shift_id: string;
  kasir_id: string;
  kasir_name: string;
  status: string;
  subtotal: string;
  discount: string;
  total: string;
  paid_amount: string;
  change_amount: string;
  offline_created: boolean;
  occurred_at: Date;
  channel: string;
  notes: string | null;
}

export async function selectSaleHeader(
  client: PoolClient,
  saleId: string,
): Promise<SaleHeaderRow | null> {
  const res = await client.query<SaleHeaderRow>(
    `SELECT sa.id, sa.receipt_number, sa.client_id, sa.location_id,
            l.name AS location_name, l.address AS location_address, l.phone AS location_phone,
            sa.shift_id, sa.kasir_id, u.name AS kasir_name,
            sa.status, sa.subtotal, sa.discount, sa.total, sa.paid_amount, sa.change_amount,
            sa.offline_created, sa.occurred_at, sa.channel, sa.notes
       FROM sales sa
       JOIN locations l ON l.id = sa.location_id
       JOIN users u ON u.id = sa.kasir_id
      WHERE sa.id = $1`,
    [saleId],
  );
  return res.rows[0] ?? null;
}

export interface SaleLineRow {
  product_id: string;
  product_name: string;
  product_code: string;
  qty: string;
  unit_price: string;
  discount: string;
  line_total: string;
  sort_order: number;
}

export async function selectSaleLines(client: PoolClient, saleId: string): Promise<SaleLineRow[]> {
  const res = await client.query<SaleLineRow>(
    `SELECT sl.product_id, p.name AS product_name, p.code AS product_code,
            sl.qty, sl.unit_price, sl.discount, sl.line_total, sl.sort_order
       FROM sale_lines sl
       JOIN products p ON p.id = sl.product_id
      WHERE sl.sale_id = $1
      ORDER BY sl.sort_order ASC`,
    [saleId],
  );
  return res.rows;
}

/**
 * The code of the voucher redeemed on this sale, if any — `receipt.resolver.ts`'s
 * `voucher_code` field token. A sale carries AT MOST one voucher redemption
 * (the POS cart applies a single coupon per basket, matching
 * `voucher_redemptions.sale_id` having no uniqueness constraint against
 * multiple rows per sale in practice, but every write path only ever inserts
 * one) — `LIMIT 1` is defensive, not a real narrowing.
 */
export async function selectVoucherCodeForSale(
  client: PoolClient,
  saleId: string,
): Promise<string | null> {
  const res = await client.query<{ code: string }>(
    `SELECT v.code
       FROM voucher_redemptions vr
       JOIN vouchers v ON v.id = vr.voucher_id
      WHERE vr.sale_id = $1
      LIMIT 1`,
    [saleId],
  );
  return res.rows[0]?.code ?? null;
}

/** Names for a voucher batch's `location_ids` restriction — `voucher.resolver.ts`'s `outlet_scope` field token. */
export async function selectLocationNames(client: PoolClient, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const res = await client.query<{ name: string }>(
    `SELECT name FROM locations WHERE id = ANY($1::uuid[]) ORDER BY name ASC`,
    [ids],
  );
  return res.rows.map((r) => r.name);
}

export interface SalePaymentRow {
  method: string;
  amount: string;
  reference: string | null;
  payment_status: string;
}

export async function selectSalePayments(
  client: PoolClient,
  saleId: string,
): Promise<SalePaymentRow[]> {
  const res = await client.query<SalePaymentRow>(
    `SELECT method, amount, reference, payment_status
       FROM sale_payments
      WHERE sale_id = $1
      ORDER BY method ASC`,
    [saleId],
  );
  return res.rows;
}

// ── Invoice from purchase order ─────────────────────────────────────────────

export interface PurchaseOrderHeaderRow {
  id: string;
  po_number: string;
  supplier_id: string;
  supplier_name: string;
  supplier_address: string | null;
  supplier_phone: string | null;
  location_id: string;
  location_name: string;
  status: string;
  order_date: unknown;
  expected_date: unknown;
  subtotal: string;
  tax: string;
  total: string;
  created_by_name: string | null;
  notes: string | null;
}

export async function selectPurchaseOrderHeader(
  client: PoolClient,
  poId: string,
): Promise<PurchaseOrderHeaderRow | null> {
  const res = await client.query<PurchaseOrderHeaderRow>(
    `SELECT po.id, po.po_number, po.supplier_id, s.name AS supplier_name,
            s.address AS supplier_address, s.phone AS supplier_phone,
            po.location_id, l.name AS location_name,
            po.status, po.order_date, po.expected_date, po.subtotal, po.tax, po.total,
            cu.name AS created_by_name, po.notes
       FROM purchase_orders po
       JOIN suppliers s ON s.id = po.supplier_id
       JOIN locations l ON l.id = po.location_id
       LEFT JOIN users cu ON cu.id = po.created_by
      WHERE po.id = $1`,
    [poId],
  );
  return res.rows[0] ?? null;
}

export interface PurchaseOrderLineRow {
  item_id: string;
  item_name: string;
  item_sku: string;
  unit_code: string;
  qty_ordered: string;
  unit_price: string;
  line_total: string;
}

export async function selectPurchaseOrderLines(
  client: PoolClient,
  poId: string,
): Promise<PurchaseOrderLineRow[]> {
  const res = await client.query<PurchaseOrderLineRow>(
    `SELECT pol.item_id, i.name AS item_name, i.sku AS item_sku, un.code AS unit_code,
            pol.qty_ordered, pol.unit_price, pol.line_total
       FROM po_lines pol
       JOIN items i ON i.id = pol.item_id
       JOIN units un ON un.id = pol.unit_id
      WHERE pol.po_id = $1
      ORDER BY i.name ASC`,
    [poId],
  );
  return res.rows;
}

// ── Surat Jalan (own SELECTs — see file header) ─────────────────────────────

export interface SjHeaderRow {
  id: string;
  sj_number: string;
  origin_location_id: string;
  origin_name: string;
  origin_address: string | null;
  shipment_type_key: string;
  driver_id: string;
  driver_name: string;
  vehicle_id: string;
  vehicle_plate: string;
  status: string;
  planned_date: unknown;
  dispatched_at: Date | null;
  completed_at: Date | null;
  created_by_name: string | null;
  notes: string | null;
}

export async function selectSjHeader(client: PoolClient, sjId: string): Promise<SjHeaderRow | null> {
  const res = await client.query<SjHeaderRow>(
    `SELECT sj.id, sj.sj_number, sj.origin_location_id, ol.name AS origin_name, ol.address AS origin_address,
            st.key AS shipment_type_key, sj.driver_id, dr.name AS driver_name,
            sj.vehicle_id, v.plate_number AS vehicle_plate,
            sj.status, sj.planned_date, sj.dispatched_at, sj.completed_at,
            cu.name AS created_by_name, sj.notes
       FROM surat_jalan sj
       JOIN locations ol ON ol.id = sj.origin_location_id
       JOIN shipment_types st ON st.id = sj.shipment_type_id
       JOIN drivers dr ON dr.id = sj.driver_id
       JOIN vehicles v ON v.id = sj.vehicle_id
       LEFT JOIN users cu ON cu.id = sj.created_by
      WHERE sj.id = $1`,
    [sjId],
  );
  return res.rows[0] ?? null;
}

export interface SjDropRow {
  id: string;
  drop_seq: number;
  location_id: string;
  location_name: string;
  location_address: string | null;
  status: string;
}

export async function selectSjDrops(client: PoolClient, sjId: string): Promise<SjDropRow[]> {
  const res = await client.query<SjDropRow>(
    `SELECT d.id, d.drop_seq, d.location_id, l.name AS location_name, l.address AS location_address, d.status
       FROM sj_drops d
       JOIN locations l ON l.id = d.location_id
      WHERE d.sj_id = $1
      ORDER BY d.drop_seq ASC`,
    [sjId],
  );
  return res.rows;
}

export interface SjLineRow {
  drop_id: string;
  item_id: string;
  item_name: string;
  item_sku: string;
  unit_code: string;
  qty: string;
  qty_received: string | null;
}

export async function selectSjLines(client: PoolClient, sjId: string): Promise<SjLineRow[]> {
  const res = await client.query<SjLineRow>(
    `SELECT sl.drop_id, sl.item_id, i.name AS item_name, i.sku AS item_sku, un.code AS unit_code,
            sl.qty, sl.qty_received
       FROM sj_lines sl
       JOIN items i ON i.id = sl.item_id
       JOIN units un ON un.id = sl.unit_id
      WHERE sl.sj_id = $1
      ORDER BY i.name ASC`,
    [sjId],
  );
  return res.rows;
}

export interface SjSealRow {
  drop_id: string | null;
  seal_number: string;
}

export async function selectSjSeals(client: PoolClient, sjId: string): Promise<SjSealRow[]> {
  const res = await client.query<SjSealRow>(
    `SELECT drop_id, seal_number FROM sj_seals WHERE sj_id = $1 ORDER BY created_at ASC`,
    [sjId],
  );
  return res.rows;
}

export interface SjTempLogRow {
  drop_id: string | null;
  temp_c: string;
}

export async function selectSjTempLogs(client: PoolClient, sjId: string): Promise<SjTempLogRow[]> {
  const res = await client.query<SjTempLogRow>(
    `SELECT drop_id, temp_c FROM sj_temperature_logs WHERE sj_id = $1 ORDER BY logged_at ASC`,
    [sjId],
  );
  return res.rows;
}

// ── Voucher ──────────────────────────────────────────────────────────────────

export interface VoucherBatchRow {
  id: string;
  code: string;
  name: string;
  type: 'fixed' | 'percentage';
  value: string;
  min_subtotal: string;
  max_discount: string | null;
  valid_from: unknown;
  valid_until: unknown;
  location_ids: string[] | null;
  terms: string | null;
}

export async function selectVoucherBatch(
  client: PoolClient,
  batchId: string,
): Promise<VoucherBatchRow | null> {
  const res = await client.query<VoucherBatchRow>(
    `SELECT id, code, name, type, value, min_subtotal, max_discount, valid_from, valid_until, location_ids, terms
       FROM voucher_batches
      WHERE id = $1`,
    [batchId],
  );
  return res.rows[0] ?? null;
}

export interface VoucherRow {
  id: string;
  batch_id: string;
  code: string;
  status: string;
}

export async function selectVoucher(client: PoolClient, voucherId: string): Promise<VoucherRow | null> {
  const res = await client.query<VoucherRow>(
    `SELECT id, batch_id, code, status FROM vouchers WHERE id = $1`,
    [voucherId],
  );
  return res.rows[0] ?? null;
}

/** All vouchers of a batch, ordered by `code` — see `voucher.resolver.ts` for the print-count cap applied on top of this. */
export async function selectVouchersForBatch(
  client: PoolClient,
  batchId: string,
): Promise<VoucherRow[]> {
  const res = await client.query<VoucherRow>(
    `SELECT id, batch_id, code, status FROM vouchers WHERE batch_id = $1 ORDER BY code ASC`,
    [batchId],
  );
  return res.rows;
}

// ── doc-template's stored background (used by every resolver) ──────────────

export async function selectBackgroundAttachmentId(
  client: PoolClient,
  kind: string,
): Promise<string | null> {
  const res = await client.query<{ background_attachment_id: string | null }>(
    `SELECT background_attachment_id FROM document_templates WHERE kind = $1`,
    [kind],
  );
  return res.rows[0]?.background_attachment_id ?? null;
}
