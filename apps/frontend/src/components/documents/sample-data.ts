'use client';

import {
  DOC_CATALOGS,
  DOC_TOTALS_ROWS,
  type BrandPalette,
  type DocData,
  type DocKind,
} from '@/lib/shared-types';
import { translate } from '@/lib/i18n';
import type { Translate } from './DocumentRenderer';

/**
 * Sample `DocData` for the designer's live preview — one realistic sheet per
 * kind, so an owner is dragging boxes over CONTENT rather than over empty
 * rectangles.
 *
 * WHY THE SAMPLE VALUES ARE LITERAL BAHASA HERE AND THAT IS NOT A §6.9
 * VIOLATION. BUILD-PLAN §6.9 bans hardcoded USER-FACING COPY — the words the
 * product says to a user. "Ayam Geprek Original" is not the product speaking;
 * it is a stand-in for a row of business data, in the same category as the
 * `12.500` next to it. The moment one of these strings IS product copy — a
 * document title, a party label, a table header, a totals row name — it goes
 * through `t()` below, which is also what makes the preview show exactly the
 * words the real document will print.
 *
 * WHY THE NUMBERS ARE PRE-FORMATTED STRINGS. `DocData` is display strings all
 * the way down (see `documents/data.ts`): the renderer positions text and does
 * no arithmetic. A sample that carried raw `Money` would be exercising a code
 * path the real one does not have.
 *
 * WHY EVERY TOKEN IS FILLED. The sample is built from
 * `DOC_CATALOGS[kind].fields`, and any token without a hand-written sample
 * falls back to its own i18n LABEL. That is deliberate: it means adding a
 * field token to the shared catalog can never produce an invisible element on
 * the designer canvas — the worst case is a box showing the field's name,
 * which is exactly the signal that a sample value is missing.
 */

/** Realistic stand-ins, per token. Shared tokens are declared once. */
const SAMPLE_VALUES: Record<string, string> = {
  // Company / outlet — the real thing, so the preview reads like the business.
  company_name: 'Mimi Chicken',
  company_address: 'Jl. Gajah Mada No. 88, Samarinda, Kalimantan Timur 75117',
  company_city: 'Samarinda',
  company_phone: '0541-742880',
  company_npwp: '02.345.678.9-722.000',
  outlet_name: 'Mimi Chicken — Outlet Sempaja',
  outlet_address: 'Jl. Wahid Hasyim II No. 12, Samarinda Utara',
  outlet_phone: '0812-5544-9021',
  location_name: 'Outlet Sempaja',

  // Invoice.
  invoice_number: 'INV-202608-0147',
  invoice_date: '27 Agu 2026',
  due_date: '10 Sep 2026',
  party_name: 'CV Sumber Rejeki Pangan',
  party_address: 'Jl. Pahlawan No. 21, Balikpapan',
  party_phone: '0542-873115',
  issued_by: 'Andi Pratama',

  // Receipt.
  receipt_number: 'STR-202608-004512',
  datetime: '27 Agu 2026, 19.42 WITA',
  kasir_name: 'Rina Oktaviani',
  paid_amount: 'Rp100.000',
  change_amount: 'Rp12.500',

  // Voucher.
  voucher_code: 'MC-7K2P-9XQ4',
  voucher_name: 'Promo Pembukaan Sempaja',
  voucher_value: 'Rp15.000',
  min_subtotal: 'Min. belanja Rp50.000',
  valid_from: '1 Agu 2026',
  valid_until: '30 Sep 2026',
  batch_code: 'VB-202608-003',
  outlet_scope: 'Berlaku di semua outlet',

  // Surat Jalan.
  sj_number: 'SJ-202608-0021',
  sj_date: '27 Agu 2026',
  origin_name: 'Gudang Pusat Samarinda',
  destination_name: 'Outlet Sempaja',
  destination_address: 'Jl. Wahid Hasyim II No. 12, Samarinda Utara',
  driver_name: 'Bambang Sutrisno',
  vehicle_plate: 'KT 8842 AB',
  drop_label: 'Titik 1 dari 3',
  seal_number: 'SEG-004821',
  temp_c: '-18,0°C',
  dispatcher_name: 'Yusuf Hakim',
  page_label: 'Halaman 1 dari 9',

  // Free text an owner would type.
  notes: 'Terima kasih telah berbelanja di Mimi Chicken.',
  terms:
    'Pembayaran melalui transfer ke rekening BNI 0812-3344-55 a.n. Mimi Chicken. Barang yang sudah dibeli tidak dapat ditukar.',
};

/**
 * Tokens whose sample value IS product copy, so they resolve through i18n
 * exactly as the real document does. Keyed token → i18n key.
 */
function copyTokens(kind: DocKind, t: Translate): Record<string, string> {
  return {
    document_title: t(`doc.title.${kind}`),
    party_label: t('doc.party.customer'),
    source_label: t('doc.source.sale'),
    channel_label: t('doc.channel.walk_in'),
    shipment_type_label: t('doc.shipmentType.frozen'),
    copy_holder_label: t('doc.copyHolder.gudang'),
    payment_method: t('doc.paymentMethod.qris'),
    payment_status: t('doc.paymentStatus.paid'),
    voucher_type_label: t('doc.voucherType.fixed'),
  };
}

/** Line items, keyed by the column keys each kind's catalog allows. */
const SAMPLE_ITEMS: Record<DocKind, Record<string, string>[]> = {
  invoice: [
    {
      no: '1',
      code: 'AYM-001',
      name: 'Ayam Geprek Original',
      qty: '24',
      uom: 'porsi',
      unit_price: 'Rp18.000',
      discount: '—',
      line_total: 'Rp432.000',
    },
    {
      no: '2',
      code: 'AYM-004',
      name: 'Ayam Geprek Sambal Matah',
      qty: '12',
      uom: 'porsi',
      unit_price: 'Rp21.000',
      discount: 'Rp6.000',
      line_total: 'Rp246.000',
    },
    {
      no: '3',
      code: 'MIN-011',
      name: 'Es Teh Manis Jumbo',
      qty: '30',
      uom: 'gelas',
      unit_price: 'Rp6.000',
      discount: '—',
      line_total: 'Rp180.000',
    },
    {
      no: '4',
      code: 'PKT-002',
      name: 'Paket Hemat Berdua',
      qty: '8',
      uom: 'paket',
      unit_price: 'Rp39.000',
      discount: '—',
      line_total: 'Rp312.000',
    },
  ],
  receipt: [
    { name: 'Ayam Geprek Original', qty: '2', unit_price: 'Rp18.000', line_total: 'Rp36.000' },
    { name: 'Nasi Putih', qty: '2', unit_price: 'Rp5.000', line_total: 'Rp10.000' },
    { name: 'Es Teh Manis', qty: '2', unit_price: 'Rp6.000', line_total: 'Rp12.000' },
    { name: 'Kerupuk', qty: '1', unit_price: 'Rp3.000', line_total: 'Rp3.000' },
  ],
  voucher: [],
  surat_jalan: [
    // `qty_received` is EMPTY on purpose — the sample shows the same
    // write-in rule the real document prints for a drop nobody has received
    // yet. Printing '0' there would assert that nothing arrived (see
    // `documents/catalog.ts`), and a sample that lied about it would let an
    // owner lay the column out believing it prints a number.
    {
      no: '1',
      code: 'FRZ-AYM-01',
      name: 'Ayam Potong Beku 1kg',
      qty_sent: '40',
      uom: 'kg',
      qty_received: '',
      notes: '',
    },
    {
      no: '2',
      code: 'FRZ-KTG-02',
      name: 'Kentang Goreng Beku',
      qty_sent: '15',
      uom: 'kg',
      qty_received: '',
      notes: '',
    },
    {
      no: '3',
      code: 'DRY-BRS-01',
      name: 'Beras Premium 25kg',
      qty_sent: '4',
      uom: 'sak',
      qty_received: '',
      notes: '',
    },
  ],
};

/** Totals rows, in the order `DOC_TOTALS_ROWS` stacks them. Values only — labels come from i18n. */
const SAMPLE_TOTALS: Record<string, { value: string; strong?: boolean }> = {
  subtotal: { value: 'Rp1.170.000' },
  discount: { value: '-Rp6.000' },
  total: { value: 'Rp1.164.000', strong: true },
  paid: { value: 'Rp1.164.000' },
  balance: { value: 'Rp0' },
  change: { value: 'Rp12.500' },
};

/**
 * Build the preview data for one kind.
 *
 * `logoUrl` is threaded in rather than defaulted to null so the designer can
 * show the OWNER'S ACTUAL LOGO in the preview — laying out a letterhead around
 * a placeholder box and discovering the real mark is twice as wide is the
 * first thing that would send somebody back into the designer.
 */
export function sampleDocData(
  kind: DocKind,
  brand: BrandPalette,
  options: { logoUrl?: string | null; backgroundUrl?: string | null; t?: Translate } = {},
): DocData {
  const t = options.t ?? translate;
  const copy = copyTokens(kind, t);
  const fields: Record<string, string> = {};

  for (const token of DOC_CATALOGS[kind].fields) {
    fields[token] = copy[token] ?? SAMPLE_VALUES[token] ?? t(`doc.field.${token}`);
  }

  const totals = DOC_TOTALS_ROWS[kind].map((key) => ({
    key,
    value: SAMPLE_TOTALS[key]?.value ?? '—',
    strong: SAMPLE_TOTALS[key]?.strong,
  }));

  // Every `code` element reads its payload from `codes[codeSource]`. Seeding
  // the whole field map means a code element pointed at ANY token in the
  // catalog previews something, not just the kind's default source.
  const codes: Record<string, string> = { ...fields };

  return {
    fields,
    items: SAMPLE_ITEMS[kind],
    totals,
    logoUrl: options.logoUrl ?? null,
    backgroundUrl: options.backgroundUrl ?? null,
    codes,
    brand,
  };
}
