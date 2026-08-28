/**
 * `GET /api/documents/invoice/sale/:saleId`, `.../purchase_order/:poId`, and
 * `POST /api/documents/invoice/manual` — three sources filling the ONE
 * invoice template (see `catalog.ts`'s `INVOICE_FIELD_TOKENS` header for why
 * the party tokens are generic `party_*` rather than `customer_*`: a POS
 * sale, a purchase order and a manually-typed invoice all resolve into this
 * same shape).
 *
 * Pure functions of already-fetched rows / already-validated request bodies
 * — no DB access here, so `document.resolver.spec.ts` can drive each from
 * fabricated data. The DB round trips live in `document.service.ts`.
 */
import {
  clampMoneyToZero,
  DOC_CATALOGS,
  DOC_TOTALS_ROWS,
  mulMoneyByQty,
  subMoney,
  sumMoney,
  type DocItemRow,
  type DocPayload,
  type DocPayloadTotalRow,
  type InvoiceFieldToken,
  type Money,
  type Qty,
} from '@mimi/shared';
import { businessDateOf } from '@mimi/shared';
import { formatDateOnly } from '../../../common/date-only.util';
import { formatDateText, formatIdr, formatQtyText } from '../doc-format.util';
import type {
  PurchaseOrderHeaderRow,
  PurchaseOrderLineRow,
  SaleHeaderRow,
  SaleLineRow,
  SalePaymentRow,
} from '../document.repository';
import { buildCodes, documentHead, splitFieldsAndLabels, type DocRenderContext } from './common';

/** Field tokens whose value is an i18n KEY, not display text — see `resolvers/common.ts`'s header. */
const INVOICE_LABEL_TOKENS: readonly InvoiceFieldToken[] = [
  'document_title',
  'source_label',
  'party_label',
  'payment_method',
  'payment_status',
];

interface CompanyInfo {
  name: string;
  address: string;
  city: string;
}

function totalRows(
  rows: readonly string[],
  values: Partial<Record<'subtotal' | 'discount' | 'total' | 'paid' | 'balance', Money>>,
): DocPayloadTotalRow[] {
  return rows.map((key) => ({
    key,
    value: formatIdr(values[key as keyof typeof values] ?? '0.00'),
    strong: key === 'total',
  }));
}

// ── From a POS sale ─────────────────────────────────────────────────────────

export interface ResolveInvoiceFromSaleInput {
  sale: SaleHeaderRow;
  lines: SaleLineRow[];
  payments: SalePaymentRow[];
  company: CompanyInfo;
  ctx: DocRenderContext;
}

/**
 * A POS sale has no separate "invoice" identity — `receipt_number` doubles
 * as `invoice_number` here, same as a retail till anywhere: the receipt
 * IS the invoice for a walk-in/online-channel transaction. There is also no
 * customer record on a `sales` row (retail is anonymous by design) and no
 * due date (payment is at point of sale) — `party_name`/`party_address`/
 * `party_phone`/`due_date` resolve to `''`, documented once here rather
 * than at each empty assignment below.
 */
export function resolveInvoiceFromSale(input: ResolveInvoiceFromSaleInput): DocPayload {
  const { sale, lines, payments, company, ctx } = input;
  const payment = payments[0];

  const all: Record<InvoiceFieldToken, string> = {
    document_title: 'docs.title.invoice',
    company_name: company.name,
    company_address: company.address,
    company_city: company.city,
    company_phone: '',
    company_npwp: '',
    invoice_number: sale.receipt_number,
    invoice_date: formatDateText(businessDateOf(sale.occurred_at.toISOString())),
    due_date: '',
    source_label: 'docs.source.sale',
    party_label: 'docs.party.customer',
    party_name: '',
    party_address: '',
    party_phone: '',
    location_name: sale.location_name,
    issued_by: sale.kasir_name,
    payment_method: payment ? `docs.paymentMethod.${payment.method}` : '',
    payment_status: payment ? `docs.paymentStatus.${payment.payment_status}` : '',
    terms: '',
    notes: sale.notes ?? '',
  };
  const { fields, labelKeys } = splitFieldsAndLabels(all, INVOICE_LABEL_TOKENS);

  const items: DocItemRow[] = lines.map((line, i) => ({
    no: String(i + 1),
    code: line.product_code,
    name: line.product_name,
    qty: formatQtyText(line.qty),
    uom: '',
    unit_price: formatIdr(line.unit_price),
    discount: formatIdr(line.discount),
    line_total: formatIdr(line.line_total),
  }));

  const balance = clampMoneyToZero(subMoney(sale.total, sale.paid_amount));
  const totals = totalRows(DOC_TOTALS_ROWS.invoice, {
    subtotal: sale.subtotal,
    discount: sale.discount,
    total: sale.total,
    paid: sale.paid_amount,
    balance,
  });

  return {
    ...documentHead('invoice', ctx),
    fields,
    labelKeys,
    items,
    totals,
    codes: buildCodes(DOC_CATALOGS.invoice.defaultCodeSource, all),
    documentNumber: sale.receipt_number,
  };
}

// ── From a purchase order ───────────────────────────────────────────────────

export interface ResolveInvoiceFromPurchaseOrderInput {
  po: PurchaseOrderHeaderRow;
  lines: PurchaseOrderLineRow[];
  company: CompanyInfo;
  ctx: DocRenderContext;
}

/**
 * Here the "party" is the SUPPLIER, not a customer — this is the invoice a
 * purchase order becomes when printed, i.e. what the supplier is owed, so
 * `party_label` resolves to `'docs.party.supplier'` (see `catalog.ts`'s note
 * on why the tokens are generic). Payment status against a PO is tracked by
 * `purchasing`/`payment` modules (`payment_verifications`), which this
 * resolver does not read (out of this ticket's scope — see `document.repository.ts`'s
 * header on why this module writes its own narrow SELECTs rather than
 * reaching into another module's service); `payment_method`/`payment_status`
 * therefore resolve to `''` and `paid`/`balance` conservatively show nothing
 * paid yet (`paid = 0`, `balance = total`) — the correct default for an
 * invoice printed at PO-issue time, before any payment has been recorded.
 */
export function resolveInvoiceFromPurchaseOrder(
  input: ResolveInvoiceFromPurchaseOrderInput,
): DocPayload {
  const { po, lines, company, ctx } = input;

  const all: Record<InvoiceFieldToken, string> = {
    document_title: 'docs.title.invoice',
    company_name: company.name,
    company_address: company.address,
    company_city: company.city,
    company_phone: '',
    company_npwp: '',
    invoice_number: po.po_number,
    invoice_date: formatDateText(formatDateOnly(po.order_date)),
    due_date: po.expected_date ? formatDateText(formatDateOnly(po.expected_date)) : '',
    source_label: 'docs.source.purchase_order',
    party_label: 'docs.party.supplier',
    party_name: po.supplier_name,
    party_address: po.supplier_address ?? '',
    party_phone: po.supplier_phone ?? '',
    location_name: po.location_name,
    issued_by: po.created_by_name ?? '',
    payment_method: '',
    payment_status: '',
    terms: '',
    notes: po.notes ?? '',
  };
  const { fields, labelKeys } = splitFieldsAndLabels(all, INVOICE_LABEL_TOKENS);

  const items: DocItemRow[] = lines.map((line, i) => ({
    no: String(i + 1),
    code: line.item_sku,
    name: line.item_name,
    qty: formatQtyText(line.qty_ordered),
    uom: line.unit_code,
    unit_price: formatIdr(line.unit_price),
    discount: formatIdr('0.00'),
    line_total: formatIdr(line.line_total),
  }));

  const totals = totalRows(DOC_TOTALS_ROWS.invoice, {
    subtotal: po.subtotal,
    discount: '0.00',
    total: po.total,
    paid: '0.00',
    balance: po.total,
  });

  return {
    ...documentHead('invoice', ctx),
    fields,
    labelKeys,
    items,
    totals,
    codes: buildCodes(DOC_CATALOGS.invoice.defaultCodeSource, all),
    documentNumber: po.po_number,
  };
}

// ── Manual invoice ───────────────────────────────────────────────────────────

export interface ManualInvoiceLineInput {
  code: string;
  name: string;
  /** Qty decimal string. */
  qty: Qty;
  uom: string;
  /** Unit price, Money decimal string. */
  unitPrice: Money;
  /** Line-level discount, Money decimal string. Default `'0.00'`. */
  discount?: Money;
}

export interface ManualInvoiceInput {
  invoiceNumber: string;
  /** ISO `YYYY-MM-DD`. */
  invoiceDate: string;
  /** ISO `YYYY-MM-DD`, or `''` for no due date. */
  dueDate: string;
  partyName: string;
  partyAddress: string;
  partyPhone: string;
  locationName: string;
  issuedBy: string;
  paymentMethod: 'cash' | 'qris' | 'bank_transfer' | '';
  paymentStatus: 'pending' | 'verified' | 'paid' | '';
  /** Money decimal string; amount already paid, if any. */
  paidAmount: Money;
  terms: string;
  notes: string;
  lines: ManualInvoiceLineInput[];
  company: CompanyInfo;
  ctx: DocRenderContext;
}

/**
 * The one invoice source with no backing row at all — an owner typing a
 * one-off bill (e.g. for a corporate catering order never entered as a POS
 * sale). `doc_template.manage` gates this route (not a lighter permission)
 * because, unlike the other two sources, EVERY number on the resulting
 * document is caller-supplied rather than read from an authoritative ledger
 * row — the same reasoning that keeps this endpoint out of reach of a plain
 * cashier.
 *
 * Line totals ARE computed here (qty × unit price − discount, via the shared
 * `@mimi/shared` money arithmetic — never `Number()`/float, D-10) rather than
 * trusted from the request body, so a caller cannot make the printed
 * subtotal disagree with its own line items.
 */
export function resolveInvoiceManual(input: ManualInvoiceInput): DocPayload {
  const { company, ctx } = input;

  const lineTotals = input.lines.map((line) =>
    clampMoneyToZero(subMoney(mulMoneyByQty(line.unitPrice, line.qty), line.discount ?? '0.00')),
  );
  const subtotal = lineTotals.length > 0 ? sumMoney(lineTotals) : '0.00';
  const discountTotal =
    input.lines.length > 0
      ? sumMoney(input.lines.map((line) => line.discount ?? '0.00'))
      : '0.00';
  const total = subtotal;
  const balance = clampMoneyToZero(subMoney(total, input.paidAmount));

  const all: Record<InvoiceFieldToken, string> = {
    document_title: 'docs.title.invoice',
    company_name: company.name,
    company_address: company.address,
    company_city: company.city,
    company_phone: '',
    company_npwp: '',
    invoice_number: input.invoiceNumber,
    invoice_date: formatDateText(input.invoiceDate),
    due_date: input.dueDate ? formatDateText(input.dueDate) : '',
    source_label: 'docs.source.manual',
    party_label: 'docs.party.manual',
    party_name: input.partyName,
    party_address: input.partyAddress,
    party_phone: input.partyPhone,
    location_name: input.locationName,
    issued_by: input.issuedBy,
    payment_method: input.paymentMethod ? `docs.paymentMethod.${input.paymentMethod}` : '',
    payment_status: input.paymentStatus ? `docs.paymentStatus.${input.paymentStatus}` : '',
    terms: input.terms,
    notes: input.notes,
  };
  const { fields, labelKeys } = splitFieldsAndLabels(all, INVOICE_LABEL_TOKENS);

  const items: DocItemRow[] = input.lines.map((line, i) => ({
    no: String(i + 1),
    code: line.code,
    name: line.name,
    qty: formatQtyText(line.qty),
    uom: line.uom,
    unit_price: formatIdr(line.unitPrice),
    discount: formatIdr(line.discount ?? '0.00'),
    line_total: formatIdr(lineTotals[i]!),
  }));

  const totals = totalRows(DOC_TOTALS_ROWS.invoice, {
    subtotal,
    discount: discountTotal,
    total,
    paid: input.paidAmount,
    balance,
  });

  return {
    ...documentHead('invoice', ctx),
    fields,
    labelKeys,
    items,
    totals,
    codes: buildCodes(DOC_CATALOGS.invoice.defaultCodeSource, all),
    documentNumber: input.invoiceNumber,
  };
}
