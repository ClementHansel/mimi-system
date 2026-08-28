/**
 * Token-completeness suite for `resolvers/*` — for EACH kind, asserts the
 * produced `DocPayload` has a value (in `.fields` OR `.labelKeys`) for EVERY
 * token the kind's catalog advertises (`catalog.ts`'s whole reason for
 * exporting `INVOICE_FIELD_TOKENS` etc — see that file's header: "a token
 * that exists in the palette but that no resolver fills prints as an empty
 * box on a real customer's invoice"). Driven entirely from FABRICATED row
 * objects — no live DB, matching the ticket's requirement and the resolvers'
 * own design (pure functions of already-fetched rows).
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BRAND_PALETTE,
  INVOICE_FIELD_TOKENS,
  RECEIPT_FIELD_TOKENS,
  SURAT_JALAN_FIELD_TOKENS,
  VOUCHER_FIELD_TOKENS,
  type DocCopySet,
  type DocPayload,
} from '@mimi/shared';
import { resolveReceipt } from './resolvers/receipt.resolver';
import {
  resolveInvoiceFromPurchaseOrder,
  resolveInvoiceFromSale,
  resolveInvoiceManual,
} from './resolvers/invoice.resolver';
import { resolveSuratJalan } from './resolvers/surat-jalan.resolver';
import { resolveVoucher, resolveVoucherBatch } from './resolvers/voucher.resolver';
import type { DocRenderContext } from './resolvers/common';
import type {
  PurchaseOrderHeaderRow,
  PurchaseOrderLineRow,
  SaleHeaderRow,
  SaleLineRow,
  SalePaymentRow,
  SjDropRow,
  SjHeaderRow,
  SjLineRow,
  SjSealRow,
  SjTempLogRow,
  VoucherBatchRow,
  VoucherRow,
} from './document.repository';

const CTX: DocRenderContext = {
  brand: DEFAULT_BRAND_PALETTE,
  logoAttachmentId: null,
  backgroundAttachmentId: null,
};

/** Every token in the catalog list has a value in `fields` XOR `labelKeys`, never neither, never both. */
function assertTokenCompleteness(payload: DocPayload, tokens: readonly string[]): void {
  for (const token of tokens) {
    const inFields = Object.prototype.hasOwnProperty.call(payload.fields, token);
    const inLabelKeys = Object.prototype.hasOwnProperty.call(payload.labelKeys, token);
    expect(
      inFields || inLabelKeys,
      `token '${token}' is missing from both fields and labelKeys`,
    ).toBe(true);
    expect(inFields && inLabelKeys, `token '${token}' appears in BOTH fields and labelKeys`).toBe(
      false,
    );
  }
}

describe('document resolvers — token completeness per catalog', () => {
  it('receipt: every RECEIPT_FIELD_TOKENS resolves', () => {
    const sale: SaleHeaderRow = {
      id: 'sale-1',
      receipt_number: 'RC-0001',
      client_id: 'client-1',
      location_id: 'loc-1',
      location_name: 'Outlet Balikpapan',
      location_address: 'Jl. Sudirman 1',
      location_phone: '0800',
      shift_id: 'shift-1',
      kasir_id: 'user-1',
      kasir_name: 'Budi',
      status: 'completed',
      subtotal: '100000.00',
      discount: '0.00',
      total: '100000.00',
      paid_amount: '100000.00',
      change_amount: '0.00',
      offline_created: false,
      occurred_at: new Date('2026-08-29T10:00:00.000Z'),
      channel: 'walk_in',
      notes: 'no onions',
    };
    const lines: SaleLineRow[] = [
      {
        product_id: 'p-1',
        product_name: 'Ayam Geprek',
        product_code: 'AG',
        qty: '2.000',
        unit_price: '25000.00',
        discount: '0.00',
        line_total: '50000.00',
        sort_order: 0,
      },
    ];
    const payments: SalePaymentRow[] = [
      { method: 'cash', amount: '100000.00', reference: null, payment_status: 'paid' },
    ];

    const payload = resolveReceipt({
      sale,
      lines,
      payments,
      voucherCode: 'MC-ABCD-1234',
      companyName: 'Mimi Chicken',
      ctx: CTX,
    });

    assertTokenCompleteness(payload, RECEIPT_FIELD_TOKENS);
    expect(payload.documentNumber).toBe('RC-0001');
    expect(payload.items).toHaveLength(1);
  });

  it('invoice: every INVOICE_FIELD_TOKENS resolves — from a sale', () => {
    const sale: SaleHeaderRow = {
      id: 'sale-1',
      receipt_number: 'RC-0001',
      client_id: 'client-1',
      location_id: 'loc-1',
      location_name: 'Outlet Balikpapan',
      location_address: 'Jl. Sudirman 1',
      location_phone: '0800',
      shift_id: 'shift-1',
      kasir_id: 'user-1',
      kasir_name: 'Budi',
      status: 'completed',
      subtotal: '100000.00',
      discount: '0.00',
      total: '100000.00',
      paid_amount: '100000.00',
      change_amount: '0.00',
      offline_created: false,
      occurred_at: new Date('2026-08-29T10:00:00.000Z'),
      channel: 'gofood',
      notes: null,
    };
    const lines: SaleLineRow[] = [
      {
        product_id: 'p-1',
        product_name: 'Ayam Geprek',
        product_code: 'AG',
        qty: '2.000',
        unit_price: '25000.00',
        discount: '0.00',
        line_total: '50000.00',
        sort_order: 0,
      },
    ];
    const payments: SalePaymentRow[] = [
      { method: 'qris', amount: '100000.00', reference: 'REF1', payment_status: 'verified' },
    ];

    const payload = resolveInvoiceFromSale({
      sale,
      lines,
      payments,
      company: { name: 'Mimi Chicken', address: 'Jl. Utama 1', city: 'Balikpapan' },
      ctx: CTX,
    });

    assertTokenCompleteness(payload, INVOICE_FIELD_TOKENS);
    expect(payload.documentNumber).toBe('RC-0001');
  });

  it('invoice: every INVOICE_FIELD_TOKENS resolves — from a purchase order', () => {
    const po: PurchaseOrderHeaderRow = {
      id: 'po-1',
      po_number: 'PO-0001',
      supplier_id: 'sup-1',
      supplier_name: 'Supplier Ayam Segar',
      supplier_address: 'Jl. Pasar 1',
      supplier_phone: '0811',
      location_id: 'loc-1',
      location_name: 'Gudang Pusat',
      status: 'issued',
      order_date: new Date(2026, 7, 20),
      expected_date: new Date(2026, 7, 25),
      subtotal: '500000.00',
      tax: '0.00',
      total: '500000.00',
      created_by_name: 'Owner',
      notes: 'urgent',
    };
    const lines: PurchaseOrderLineRow[] = [
      {
        item_id: 'item-1',
        item_name: 'Ayam Fillet',
        item_sku: 'ITM-001',
        unit_code: 'kg',
        qty_ordered: '10.000',
        unit_price: '50000.00',
        line_total: '500000.00',
      },
    ];

    const payload = resolveInvoiceFromPurchaseOrder({
      po,
      lines,
      company: { name: 'Mimi Chicken', address: 'Jl. Utama 1', city: 'Balikpapan' },
      ctx: CTX,
    });

    assertTokenCompleteness(payload, INVOICE_FIELD_TOKENS);
    expect(payload.documentNumber).toBe('PO-0001');
  });

  it('invoice: every INVOICE_FIELD_TOKENS resolves — manual', () => {
    const payload = resolveInvoiceManual({
      invoiceNumber: 'INV-MANUAL-1',
      invoiceDate: '2026-08-29',
      dueDate: '2026-09-05',
      partyName: 'PT Catering Sejahtera',
      partyAddress: 'Jl. Katering 5',
      partyPhone: '0822',
      locationName: 'Kantor Pusat',
      issuedBy: 'Finance',
      paymentMethod: 'bank_transfer',
      paymentStatus: 'pending',
      paidAmount: '0.00',
      terms: 'Net 7',
      notes: 'corporate order',
      lines: [
        { code: 'AG', name: 'Ayam Geprek', qty: '50.000', uom: 'pcs', unitPrice: '20000.00' },
      ],
      company: { name: 'Mimi Chicken', address: 'Jl. Utama 1', city: 'Balikpapan' },
      ctx: CTX,
    });

    assertTokenCompleteness(payload, INVOICE_FIELD_TOKENS);
    expect(payload.documentNumber).toBe('INV-MANUAL-1');
    expect(payload.totals.find((t) => t.key === 'total')?.value).toBe('Rp1.000.000');
  });

  it('surat_jalan: every SURAT_JALAN_FIELD_TOKENS resolves on every copy; qty_received honours the received/unreceived rule', () => {
    const header: SjHeaderRow = {
      id: 'sj-1',
      sj_number: 'SJ-0001',
      origin_location_id: 'loc-gudang',
      origin_name: 'Gudang Pusat',
      origin_address: 'Jl. Gudang 1',
      shipment_type_key: 'frozen',
      driver_id: 'driver-1',
      driver_name: 'Pak Joko',
      vehicle_id: 'veh-1',
      vehicle_plate: 'KT 1234 AB',
      status: 'in_transit',
      planned_date: new Date(2026, 7, 29),
      dispatched_at: new Date('2026-08-29T02:00:00.000Z'),
      completed_at: null,
      created_by_name: 'Dispatcher',
      notes: 'handle with care',
    };
    const drops: SjDropRow[] = [
      {
        id: 'drop-1',
        drop_seq: 1,
        location_id: 'loc-a',
        location_name: 'Outlet A',
        location_address: 'Jl. A',
        status: 'completed', // received
      },
      {
        id: 'drop-2',
        drop_seq: 2,
        location_id: 'loc-b',
        location_name: 'Outlet B',
        location_address: 'Jl. B',
        status: 'pending', // NOT received
      },
    ];
    const lines: SjLineRow[] = [
      {
        drop_id: 'drop-1',
        item_id: 'item-1',
        item_name: 'Ayam Fillet',
        item_sku: 'ITM-001',
        unit_code: 'kg',
        qty: '10.000',
        qty_received: '10.000',
      },
      {
        drop_id: 'drop-2',
        item_id: 'item-1',
        item_name: 'Ayam Fillet',
        item_sku: 'ITM-001',
        unit_code: 'kg',
        qty: '5.000',
        qty_received: null,
      },
    ];
    const seals: SjSealRow[] = [{ drop_id: 'drop-1', seal_number: 'SEAL-1' }];
    const tempLogs: SjTempLogRow[] = [{ drop_id: 'drop-1', temp_c: '-18.0' }];

    const copySet: DocCopySet = resolveSuratJalan({
      header,
      drops,
      lines,
      seals,
      tempLogs,
      company: { name: 'Mimi Chicken', address: 'Jl. Utama 1' },
      ctx: CTX,
    });

    expect(copySet.documentNumber).toBe('SJ-0001');
    // 2 drops × 3 copy holders = 6 sheets.
    expect(copySet.copies).toHaveLength(6);
    for (const copy of copySet.copies) {
      assertTokenCompleteness(copy, SURAT_JALAN_FIELD_TOKENS);
    }

    const drop1Copies = copySet.copies.filter((c) => c.fields.drop_label?.startsWith('1 /'));
    const drop2Copies = copySet.copies.filter((c) => c.fields.drop_label?.startsWith('2 /'));
    expect(drop1Copies).toHaveLength(3);
    expect(drop2Copies).toHaveLength(3);

    // Received drop: qty_received is filled, never '0'.
    for (const copy of drop1Copies) {
      expect(copy.items[0]!.qty_received).toBe('10');
    }
    // Unreceived drop: qty_received is a blank string, never '0'.
    for (const copy of drop2Copies) {
      expect(copy.items[0]!.qty_received).toBe('');
    }

    // page_label / drop_label are language-free resolved values, not keys.
    expect(copySet.copies[0]!.fields.page_label).toBe('1 / 6');
    expect(copySet.copies[5]!.fields.page_label).toBe('6 / 6');
  });

  it('voucher: every VOUCHER_FIELD_TOKENS resolves — single voucher', () => {
    const batch: VoucherBatchRow = {
      id: 'batch-1',
      code: 'PROMO-AGT-26',
      name: 'Promo Agustus',
      type: 'percentage',
      value: '10.00',
      min_subtotal: '50000.00',
      max_discount: '20000.00',
      valid_from: new Date(2026, 7, 1),
      valid_until: new Date(2026, 7, 31),
      location_ids: null,
      terms: 'Berlaku untuk semua menu',
    };
    const voucher: VoucherRow = {
      id: 'v-1',
      batch_id: 'batch-1',
      code: 'MC-ABCD-1234',
      status: 'active',
    };

    const payload = resolveVoucher({
      voucher,
      batch,
      companyName: 'Mimi Chicken',
      locationNames: [],
      ctx: CTX,
    });

    assertTokenCompleteness(payload, VOUCHER_FIELD_TOKENS);
    expect(payload.documentNumber).toBe('MC-ABCD-1234');
    expect(payload.fields.outlet_scope).toBe('');
    expect(payload.fields.voucher_value).toBe('10%');
  });

  it('voucher batch: caps the number of printed cards at VOUCHER_BATCH_PRINT_CAP and orders by code', async () => {
    const { VOUCHER_BATCH_PRINT_CAP } = await import('./resolvers/voucher.resolver');
    const batch: VoucherBatchRow = {
      id: 'batch-1',
      code: 'PROMO-AGT-26',
      name: 'Promo Agustus',
      type: 'fixed',
      value: '10000.00',
      min_subtotal: '0.00',
      max_discount: null,
      valid_from: new Date(2026, 7, 1),
      valid_until: new Date(2026, 7, 31),
      location_ids: ['loc-a'],
      terms: null,
    };
    const vouchers: VoucherRow[] = Array.from({ length: VOUCHER_BATCH_PRINT_CAP + 50 }, (_, i) => ({
      id: `v-${i}`,
      batch_id: 'batch-1',
      code: `MC-${String(i).padStart(4, '0')}-0000`,
      status: 'active',
    }));

    const copySet = resolveVoucherBatch({
      batch,
      vouchers,
      companyName: 'Mimi Chicken',
      locationNames: ['Outlet A'],
      ctx: CTX,
    });

    expect(copySet.copies).toHaveLength(VOUCHER_BATCH_PRINT_CAP);
    expect(copySet.documentNumber).toBe('PROMO-AGT-26');
    expect(copySet.copies[0]!.fields.voucher_code).toBe('MC-0000-0000');
    for (const copy of copySet.copies) {
      assertTokenCompleteness(copy, VOUCHER_FIELD_TOKENS);
    }
  });
});
