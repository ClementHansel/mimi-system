/**
 * `GET /api/documents/receipt/:saleId` — fills the thermal-roll receipt
 * template from a `sales` row. Pure function of already-fetched rows (no DB
 * access here) so `document.resolver.spec.ts` can drive it from fabricated
 * data — the DB round trips live in `document.service.ts`.
 */
import {
  DOC_CATALOGS,
  DOC_TOTALS_ROWS,
  type DocPayload,
  type DocPayloadTotalRow,
  type ReceiptFieldToken,
} from '@mimi/shared';
import { formatDateTimeText, formatIdr, formatQtyText } from '../doc-format.util';
import type { SaleHeaderRow, SaleLineRow, SalePaymentRow } from '../document.repository';
import { buildCodes, documentHead, splitFieldsAndLabels, type DocRenderContext } from './common';

/** Field tokens whose value is an i18n KEY, not display text — see `common.ts`'s header. */
const RECEIPT_LABEL_TOKENS: readonly ReceiptFieldToken[] = [
  'document_title',
  'channel_label',
  'payment_method',
];

export interface ResolveReceiptInput {
  sale: SaleHeaderRow;
  lines: SaleLineRow[];
  payments: SalePaymentRow[];
  /** Code of the voucher redeemed on this sale, or `null` — see `selectVoucherCodeForSale`. */
  voucherCode: string | null;
  companyName: string;
  ctx: DocRenderContext;
}

export function resolveReceipt(input: ResolveReceiptInput): DocPayload {
  const { sale, lines, payments, voucherCode, companyName, ctx } = input;

  // A receipt prints EXACTLY the payment the till took, so the first payment
  // row is used rather than joining all of them — a POS sale in this schema
  // is rung up with one `sale_payments` row per tender in the common case,
  // and if a future flow adds split-tender receipts, that is a resolver
  // change, not silently swallowed here.
  const payment = payments[0];

  const all: Record<ReceiptFieldToken, string> = {
    document_title: 'docs.title.receipt',
    company_name: companyName,
    outlet_name: sale.location_name,
    outlet_address: sale.location_address ?? '',
    outlet_phone: sale.location_phone ?? '',
    receipt_number: sale.receipt_number,
    datetime: formatDateTimeText(sale.occurred_at),
    kasir_name: sale.kasir_name,
    channel_label: `docs.channel.${sale.channel}`,
    payment_method: payment ? `docs.paymentMethod.${payment.method}` : '',
    paid_amount: formatIdr(sale.paid_amount),
    change_amount: formatIdr(sale.change_amount),
    voucher_code: voucherCode ?? '',
    notes: sale.notes ?? '',
  };

  const { fields, labelKeys } = splitFieldsAndLabels(all, RECEIPT_LABEL_TOKENS);

  const items = lines.map((line) => ({
    name: line.product_name,
    qty: formatQtyText(line.qty),
    unit_price: formatIdr(line.unit_price),
    line_total: formatIdr(line.line_total),
  }));

  const totals: DocPayloadTotalRow[] = DOC_TOTALS_ROWS.receipt.map((key) => ({
    key,
    value: formatIdr(totalsValueFor(key, sale)),
    strong: key === 'total',
  }));

  return {
    ...documentHead('receipt', ctx),
    fields,
    labelKeys,
    items,
    totals,
    codes: buildCodes(DOC_CATALOGS.receipt.defaultCodeSource, all),
    documentNumber: sale.receipt_number,
  };
}

function totalsValueFor(key: string, sale: SaleHeaderRow): string {
  switch (key) {
    case 'subtotal':
      return sale.subtotal;
    case 'discount':
      return sale.discount;
    case 'total':
      return sale.total;
    case 'paid':
      return sale.paid_amount;
    case 'change':
      return sale.change_amount;
    default:
      // `DOC_TOTALS_ROWS.receipt` is a closed, hand-written list — an
      // unrecognised key here would mean the catalog grew a row this
      // resolver was never updated for. `document.resolver.spec.ts` covers
      // this by asserting the exact expected key set, but failing loudly
      // (rather than printing '0.00') is the right default if it ever does.
      throw new Error(`resolveReceipt: unknown totals row key '${key}'`);
  }
}
