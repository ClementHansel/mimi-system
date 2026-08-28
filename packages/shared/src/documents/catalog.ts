/**
 * What each document kind is ALLOWED to contain — the closed list of field
 * tokens, table columns and totals rows per kind, plus which element types
 * its designer offers.
 *
 * This is the contract between three parties that would otherwise drift:
 *
 *  1. the DESIGNER, which offers "add field" buttons from `fields` here;
 *  2. the RESOLVER (`backend/modules/document/resolvers/*`), which must be
 *     able to produce a value for every token it advertises;
 *  3. the RENDERER, which prints whatever the template asks for.
 *
 * A token that exists in the palette but that no resolver fills prints as an
 * empty box on a real customer's invoice. So `DOC_FIELD_TOKENS` is exported
 * as a closed union per kind and the resolvers are typed as
 * `Record<InvoiceFieldToken, string>` — a resolver that forgets a token is a
 * compile error, not a blank line on paper. `document.resolver.spec.ts`
 * additionally asserts every advertised token resolves for a real row.
 *
 * Labels are NOT here (see `template.ts`'s header): the frontend renders
 * `t('docs.field.' + token)`.
 */

import type { DocElementType, DocKind } from './template';

// ── Field tokens, per kind ────────────────────────────────────────────────────

/**
 * Invoice. The bill-to party is deliberately generic (`party_*`) rather than
 * `customer_*`: one invoice template serves all three sources the owner asked
 * for — a POS sale (party = the walk-in/online customer), a purchase order
 * (party = the supplier) and a manual invoice (party = whatever was typed).
 * Naming the tokens `customer_name` would have forced either three templates
 * or a lie on two of the three.
 */
export const INVOICE_FIELD_TOKENS = [
  'document_title',
  'company_name',
  'company_address',
  'company_city',
  'company_phone',
  'company_npwp',
  'invoice_number',
  'invoice_date',
  'due_date',
  'source_label',
  'party_label',
  'party_name',
  'party_address',
  'party_phone',
  'location_name',
  'issued_by',
  'payment_method',
  'payment_status',
  'terms',
  'notes',
] as const;
export type InvoiceFieldToken = (typeof INVOICE_FIELD_TOKENS)[number];

export const RECEIPT_FIELD_TOKENS = [
  'document_title',
  'company_name',
  'outlet_name',
  'outlet_address',
  'outlet_phone',
  'receipt_number',
  'datetime',
  'kasir_name',
  'channel_label',
  'payment_method',
  'paid_amount',
  'change_amount',
  'voucher_code',
  'notes',
] as const;
export type ReceiptFieldToken = (typeof RECEIPT_FIELD_TOKENS)[number];

export const VOUCHER_FIELD_TOKENS = [
  'document_title',
  'company_name',
  'voucher_code',
  'voucher_name',
  'voucher_value',
  'voucher_type_label',
  'min_subtotal',
  'valid_from',
  'valid_until',
  'batch_code',
  'outlet_scope',
  'terms',
] as const;
export type VoucherFieldToken = (typeof VOUCHER_FIELD_TOKENS)[number];

export const SURAT_JALAN_FIELD_TOKENS = [
  'document_title',
  'company_name',
  'company_address',
  'sj_number',
  'sj_date',
  'shipment_type_label',
  'origin_name',
  'destination_name',
  'destination_address',
  'driver_name',
  'vehicle_plate',
  'drop_label',
  'copy_holder_label',
  'seal_number',
  'temp_c',
  'dispatcher_name',
  'page_label',
  'notes',
] as const;
export type SuratJalanFieldToken = (typeof SURAT_JALAN_FIELD_TOKENS)[number];

export type DocFieldToken =
  InvoiceFieldToken | ReceiptFieldToken | VoucherFieldToken | SuratJalanFieldToken;

// ── Table columns, per kind ───────────────────────────────────────────────────

export const INVOICE_COLUMN_KEYS = [
  'no',
  'code',
  'name',
  'qty',
  'uom',
  'unit_price',
  'discount',
  'line_total',
] as const;
export type InvoiceColumnKey = (typeof INVOICE_COLUMN_KEYS)[number];

export const RECEIPT_COLUMN_KEYS = ['name', 'qty', 'unit_price', 'line_total'] as const;
export type ReceiptColumnKey = (typeof RECEIPT_COLUMN_KEYS)[number];

/**
 * `qty_received` is printed as an EMPTY ruled cell for a drop that has not
 * been received yet — the driver writes it in. That rule lives in the
 * resolver (it returns `''`), not in the renderer, so it is one decision in
 * one place; printing `0` would be a claim that nothing arrived. This is the
 * same reasoning the hand-coded Surat Jalan page recorded before it became
 * template-driven.
 */
export const SURAT_JALAN_COLUMN_KEYS = [
  'no',
  'code',
  'name',
  'qty_sent',
  'uom',
  'qty_received',
  'notes',
] as const;
export type SuratJalanColumnKey = (typeof SURAT_JALAN_COLUMN_KEYS)[number];

export type DocColumnKey = InvoiceColumnKey | ReceiptColumnKey | SuratJalanColumnKey;

// ── Per-kind capability descriptor ────────────────────────────────────────────

export interface DocCatalog {
  kind: DocKind;
  /** Field tokens offered in the designer's "add field" palette. */
  fields: readonly string[];
  /** Column keys a `table` element may show. Empty = the kind has no line items. */
  columns: readonly string[];
  /** Element types the designer offers for this kind. */
  elements: readonly DocElementType[];
  /** Which field token a `code` element defaults to. `null` = no code element. */
  defaultCodeSource: string | null;
  /**
   * Signature-block roles this kind offers, as token suffixes under
   * `docs.signature.*`. A Surat Jalan is signed by three parties; a thermal
   * receipt by nobody.
   */
  signatureRoles: readonly string[];
}

const COMMON_ELEMENTS: readonly DocElementType[] = [
  'text',
  'field',
  'logo',
  'divider',
  'box',
] as const;

export const DOC_CATALOGS: Readonly<Record<DocKind, DocCatalog>> = {
  invoice: {
    kind: 'invoice',
    fields: INVOICE_FIELD_TOKENS,
    columns: INVOICE_COLUMN_KEYS,
    elements: [...COMMON_ELEMENTS, 'table', 'totals', 'code', 'signature'],
    defaultCodeSource: 'invoice_number',
    signatureRoles: ['issuer', 'recipient'],
  },
  receipt: {
    kind: 'receipt',
    fields: RECEIPT_FIELD_TOKENS,
    columns: RECEIPT_COLUMN_KEYS,
    // No `box`/`signature`: a thermal head prints a 1-bit bitmap on a narrow
    // roll — a filled rectangle wastes ribbon and nobody signs a receipt.
    elements: ['text', 'field', 'logo', 'divider', 'table', 'totals', 'code'],
    defaultCodeSource: 'receipt_number',
    signatureRoles: [],
  },
  voucher: {
    kind: 'voucher',
    fields: VOUCHER_FIELD_TOKENS,
    columns: [],
    elements: [...COMMON_ELEMENTS, 'code'],
    defaultCodeSource: 'voucher_code',
    signatureRoles: [],
  },
  surat_jalan: {
    kind: 'surat_jalan',
    fields: SURAT_JALAN_FIELD_TOKENS,
    columns: SURAT_JALAN_COLUMN_KEYS,
    // No `totals`: a delivery note carries quantities, never money. Offering
    // a totals block here would invite an owner to print a rupiah figure on
    // a document that travels with the goods.
    elements: [...COMMON_ELEMENTS, 'table', 'code', 'signature'],
    defaultCodeSource: 'sj_number',
    signatureRoles: ['sender', 'driver', 'receiver'],
  },
};

/** Totals rows a kind may print, in the order the renderer stacks them. Empty = no totals block. */
export const DOC_TOTALS_ROWS: Readonly<Record<DocKind, readonly string[]>> = {
  invoice: ['subtotal', 'discount', 'total', 'paid', 'balance'],
  receipt: ['subtotal', 'discount', 'total', 'paid', 'change'],
  voucher: [],
  surat_jalan: [],
};
