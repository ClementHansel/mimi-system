/**
 * The seeded default layout for each document kind — what an owner sees the
 * first time they open a designer, and what every document prints as until
 * somebody drags something.
 *
 * TWO RULES THESE DEFAULTS FOLLOW, AND WHY
 * ----------------------------------------
 *  1. EVERY COLOUR IS A BRAND TOKEN, never a literal hex. That is what makes
 *     "all PDFs use the brand colour" true by construction rather than by an
 *     owner remembering to re-pick four colours in four designers: change the
 *     palette in Admin → Merek and every untouched document follows. An owner
 *     who deliberately picks a literal colour for one heading opts that one
 *     element out, which is the right granularity.
 *  2. NO SEEDED `text` ELEMENTS. A default heading would be product copy, and
 *     this package holds no user-facing strings (BUILD-PLAN §6.9). Headings
 *     are the `document_title` FIELD token instead, which the frontend fills
 *     from i18n — so the seeded invoice says "INVOICE"/"FAKTUR" in whatever
 *     the locale says, and an owner who wants their own wording adds a `text`
 *     element and types it.
 *
 * Geometry is CSS px at 96dpi (see `template.ts`). The A4 layouts use a 48px
 * margin, which is ~12.7mm — inside the non-printable border of every office
 * laser printer, including the Epson tray the Surat Jalan is printed on.
 */

import {
  DOC_PAPER_SIZES,
  DOC_TEMPLATE_VERSION,
  type DocElement,
  type DocKind,
  type DocTemplate,
} from './template';

const A4 = DOC_PAPER_SIZES.A4;
const T80 = DOC_PAPER_SIZES.thermal80;
const CARD = DOC_PAPER_SIZES.card;

/** A4 content band: 48px margins left and right. */
const M = 48;
const A4_CONTENT = A4.width - M * 2; // 698

/** Terse element constructors — these tables are read as layouts, not as code. */
function field(id: string, token: string, box: [number, number, number, number], rest: Partial<DocElement> = {}): DocElement {
  const [x, y, w, h] = box;
  return { id, type: 'field', field: token, x, y, w, h, fontSize: 11, color: 'brand.ink', align: 'left', ...rest };
}

function el(id: string, type: DocElement['type'], box: [number, number, number, number], rest: Partial<DocElement> = {}): DocElement {
  const [x, y, w, h] = box;
  return { id, type, x, y, w, h, ...rest };
}

// ── invoice — A4 portrait ─────────────────────────────────────────────────────

const INVOICE_ELEMENTS: DocElement[] = [
  el('logo', 'logo', [M, 40, 160, 64], { align: 'left' }),
  field('company_name', 'company_name', [M, 112, 340, 26], { fontSize: 18, bold: true }),
  field('company_address', 'company_address', [M, 140, 340, 34], { fontSize: 10, color: 'brand.muted', wrap: true }),
  field('company_phone', 'company_phone', [M, 176, 340, 16], { fontSize: 10, color: 'brand.muted' }),
  field('company_npwp', 'company_npwp', [M, 194, 340, 16], { fontSize: 10, color: 'brand.muted' }),

  field('document_title', 'document_title', [446, 40, 300, 40], { fontSize: 30, bold: true, align: 'right', color: 'brand.primary' }),
  field('invoice_number', 'invoice_number', [446, 84, 300, 20], { fontSize: 13, bold: true, align: 'right' }),
  field('invoice_date', 'invoice_date', [446, 106, 300, 16], { fontSize: 10, align: 'right', color: 'brand.muted' }),
  field('due_date', 'due_date', [446, 124, 300, 16], { fontSize: 10, align: 'right', color: 'brand.muted' }),
  field('source_label', 'source_label', [446, 142, 300, 16], { fontSize: 10, align: 'right', color: 'brand.accent' }),

  el('rule_top', 'divider', [M, 232, A4_CONTENT, 1], { color: 'brand.muted' }),
  field('party_label', 'party_label', [M, 244, 340, 14], { fontSize: 9, color: 'brand.muted' }),
  field('party_name', 'party_name', [M, 260, 340, 24], { fontSize: 15, bold: true }),
  field('party_address', 'party_address', [M, 284, 340, 34], { fontSize: 10, color: 'brand.muted', wrap: true }),
  field('party_phone', 'party_phone', [M, 318, 340, 16], { fontSize: 10, color: 'brand.muted' }),
  field('location_name', 'location_name', [446, 260, 300, 18], { fontSize: 10, align: 'right', color: 'brand.muted' }),
  field('issued_by', 'issued_by', [446, 278, 300, 18], { fontSize: 10, align: 'right', color: 'brand.muted' }),

  el('items', 'table', [M, 360, A4_CONTENT, 520], {
    fontSize: 10,
    color: 'brand.ink',
    background: 'brand.primary',
    columns: [
      { key: 'no', width: 40, align: 'center' },
      { key: 'name', width: 300, align: 'left' },
      { key: 'qty', width: 60, align: 'right' },
      { key: 'uom', width: 60, align: 'center' },
      { key: 'unit_price', width: 110, align: 'right' },
      { key: 'line_total', width: 128, align: 'right' },
    ],
  }),

  el('totals', 'totals', [446, 896, 300, 120], { fontSize: 12, color: 'brand.ink', align: 'right' }),
  field('payment_method', 'payment_method', [M, 896, 340, 16], { fontSize: 10, color: 'brand.muted' }),
  field('payment_status', 'payment_status', [M, 914, 340, 16], { fontSize: 10, color: 'brand.muted' }),
  field('notes', 'notes', [M, 940, 340, 44], { fontSize: 10, color: 'brand.muted', wrap: true }),
  field('terms', 'terms', [M, 1030, A4_CONTENT, 40], { fontSize: 9, color: 'brand.muted', wrap: true }),
];

// ── receipt — 80mm thermal roll ───────────────────────────────────────────────

const T80_M = 12;
const T80_CONTENT = T80.width - T80_M * 2; // 259

const RECEIPT_ELEMENTS: DocElement[] = [
  el('logo', 'logo', [(T80.width - 100) / 2, 8, 100, 40], { align: 'center' }),
  field('outlet_name', 'outlet_name', [T80_M, 52, T80_CONTENT, 20], { fontSize: 14, bold: true, align: 'center' }),
  field('outlet_address', 'outlet_address', [T80_M, 72, T80_CONTENT, 24], { fontSize: 9, align: 'center', color: 'brand.muted', wrap: true }),
  field('outlet_phone', 'outlet_phone', [T80_M, 96, T80_CONTENT, 12], { fontSize: 9, align: 'center', color: 'brand.muted' }),

  el('rule_head', 'divider', [T80_M, 114, T80_CONTENT, 1], { color: 'brand.muted' }),
  field('receipt_number', 'receipt_number', [T80_M, 120, T80_CONTENT, 14], { fontSize: 10, bold: true }),
  field('datetime', 'datetime', [T80_M, 134, T80_CONTENT, 14], { fontSize: 10 }),
  field('kasir_name', 'kasir_name', [T80_M, 148, T80_CONTENT, 14], { fontSize: 10 }),
  field('channel_label', 'channel_label', [T80_M, 162, T80_CONTENT, 14], { fontSize: 10 }),
  el('rule_items', 'divider', [T80_M, 180, T80_CONTENT, 1], { color: 'brand.muted' }),

  el('items', 'table', [T80_M, 186, T80_CONTENT, 330], {
    fontSize: 10,
    color: 'brand.ink',
    columns: [
      { key: 'name', width: 129, align: 'left' },
      { key: 'qty', width: 30, align: 'center' },
      { key: 'unit_price', width: 50, align: 'right' },
      { key: 'line_total', width: 50, align: 'right' },
    ],
  }),

  el('totals', 'totals', [T80_M, 524, T80_CONTENT, 90], { fontSize: 11, color: 'brand.ink', align: 'right' }),
  field('payment_method', 'payment_method', [T80_M, 618, T80_CONTENT, 14], { fontSize: 9, align: 'center', color: 'brand.muted' }),
  field('notes', 'notes', [T80_M, 634, T80_CONTENT, 38], { fontSize: 9, align: 'center', color: 'brand.muted', wrap: true }),
];

// ── voucher — card stock, printed 8-up on A4 ──────────────────────────────────

const VOUCHER_ELEMENTS: DocElement[] = [
  // A brand stripe rather than a full-bleed fill: a card-sized voucher is
  // printed on an office laser, and a solid 324×204 block of colour is both
  // a toner sink and unreadable if the printer runs light.
  el('stripe', 'box', [0, 0, 12, CARD.height], { background: 'brand.primary' }),
  el('logo', 'logo', [28, 16, 84, 32], { align: 'left' }),
  field('company_name', 'company_name', [120, 20, 188, 18], { fontSize: 11, bold: true, align: 'right', color: 'brand.muted' }),

  field('voucher_name', 'voucher_name', [28, 58, 280, 22], { fontSize: 15, bold: true, color: 'brand.primary' }),
  field('voucher_value', 'voucher_value', [28, 80, 280, 32], { fontSize: 24, bold: true, color: 'brand.accent' }),

  el('qr', 'code', [228, 100, 80, 80], { codeType: 'qr', codeSource: 'voucher_code', align: 'center' }),
  field('voucher_code', 'voucher_code', [28, 116, 190, 24], { fontSize: 17, bold: true }),
  field('valid_until', 'valid_until', [28, 142, 190, 14], { fontSize: 9, color: 'brand.muted' }),
  field('min_subtotal', 'min_subtotal', [28, 156, 190, 14], { fontSize: 9, color: 'brand.muted' }),
  field('terms', 'terms', [28, 172, 190, 26], { fontSize: 8, color: 'brand.muted', wrap: true }),
];

// ── surat jalan — A4 portrait, ONE COPY SHEET ─────────────────────────────────

/**
 * This template lays out ONE copy of ONE drop. The three-copies-per-drop rule
 * (gudang / outlet / kantor) and the drop loop stay in the print route's code,
 * not in the template: a legal shipping document must not become unsignable
 * because somebody dragged the signature block off the page or deleted a copy.
 * `copy_holder_label` is the token that tells each sheet which copy it is.
 */
const SJ_ELEMENTS: DocElement[] = [
  el('logo', 'logo', [M, 40, 140, 56], { align: 'left' }),
  field('company_name', 'company_name', [M, 100, 360, 22], { fontSize: 16, bold: true }),
  field('company_address', 'company_address', [M, 122, 360, 30], { fontSize: 10, color: 'brand.muted', wrap: true }),

  field('document_title', 'document_title', [446, 40, 300, 34], { fontSize: 24, bold: true, align: 'right', color: 'brand.primary' }),
  field('sj_number', 'sj_number', [446, 78, 300, 20], { fontSize: 13, bold: true, align: 'right' }),
  field('sj_date', 'sj_date', [446, 100, 300, 16], { fontSize: 10, align: 'right', color: 'brand.muted' }),
  field('copy_holder_label', 'copy_holder_label', [446, 118, 300, 18], { fontSize: 11, bold: true, align: 'right', color: 'brand.accent' }),

  el('rule_top', 'divider', [M, 160, A4_CONTENT, 1], { color: 'brand.muted' }),
  field('origin_name', 'origin_name', [M, 174, 330, 18], { fontSize: 10, color: 'brand.muted' }),
  field('destination_name', 'destination_name', [M, 194, 330, 20], { fontSize: 13, bold: true }),
  field('destination_address', 'destination_address', [M, 216, 330, 30], { fontSize: 10, color: 'brand.muted', wrap: true }),
  field('driver_name', 'driver_name', [416, 174, 330, 18], { fontSize: 10, align: 'right' }),
  field('vehicle_plate', 'vehicle_plate', [416, 192, 330, 18], { fontSize: 10, align: 'right' }),
  field('shipment_type_label', 'shipment_type_label', [416, 210, 330, 18], { fontSize: 10, align: 'right' }),
  field('drop_label', 'drop_label', [416, 228, 330, 18], { fontSize: 10, align: 'right', bold: true }),
  field('seal_number', 'seal_number', [M, 250, 330, 16], { fontSize: 10, color: 'brand.muted' }),
  field('temp_c', 'temp_c', [416, 250, 330, 16], { fontSize: 10, align: 'right', color: 'brand.muted' }),

  el('items', 'table', [M, 290, A4_CONTENT, 560], {
    fontSize: 10,
    color: 'brand.ink',
    background: 'brand.primary',
    columns: [
      { key: 'no', width: 36, align: 'center' },
      { key: 'code', width: 90, align: 'left' },
      { key: 'name', width: 260, align: 'left' },
      { key: 'qty_sent', width: 80, align: 'right' },
      { key: 'uom', width: 60, align: 'center' },
      { key: 'qty_received', width: 90, align: 'right' },
      { key: 'notes', width: 82, align: 'left' },
    ],
  }),

  field('notes', 'notes', [M, 866, A4_CONTENT, 40], { fontSize: 10, wrap: true, color: 'brand.muted' }),

  el('sig_sender', 'signature', [M, 930, 210, 110], { signatureRole: 'sender', fontSize: 10, color: 'brand.ink' }),
  el('sig_driver', 'signature', [292, 930, 210, 110], { signatureRole: 'driver', fontSize: 10, color: 'brand.ink' }),
  el('sig_receiver', 'signature', [536, 930, 210, 110], { signatureRole: 'receiver', fontSize: 10, color: 'brand.ink' }),

  field('page_label', 'page_label', [M, 1070, A4_CONTENT, 16], { fontSize: 9, align: 'center', color: 'brand.muted' }),
];

const DEFAULTS: Readonly<Record<DocKind, DocTemplate>> = {
  invoice: { kind: 'invoice', paper: 'A4', width: A4.width, height: A4.height, backgroundAttachmentId: null, elements: INVOICE_ELEMENTS, version: DOC_TEMPLATE_VERSION },
  receipt: { kind: 'receipt', paper: 'thermal80', width: T80.width, height: T80.height, backgroundAttachmentId: null, elements: RECEIPT_ELEMENTS, version: DOC_TEMPLATE_VERSION },
  voucher: { kind: 'voucher', paper: 'card', width: CARD.width, height: CARD.height, backgroundAttachmentId: null, elements: VOUCHER_ELEMENTS, version: DOC_TEMPLATE_VERSION },
  surat_jalan: { kind: 'surat_jalan', paper: 'A4', width: A4.width, height: A4.height, backgroundAttachmentId: null, elements: SJ_ELEMENTS, version: DOC_TEMPLATE_VERSION },
};

/**
 * A DEEP COPY of the seeded default. Callers mutate what they get back (the
 * designer's "reset to default" hands it straight to React state), and these
 * module-level arrays are shared by every caller in the process — including,
 * on the backend, every request.
 */
export function defaultDocTemplate(kind: DocKind): DocTemplate {
  const base = DEFAULTS[kind];
  return {
    ...base,
    elements: base.elements.map((e) => ({
      ...e,
      ...(e.columns ? { columns: e.columns.map((c) => ({ ...c })) } : {}),
    })),
  };
}
