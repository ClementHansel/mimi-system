/**
 * `GET /api/documents/voucher/:voucherId` and `.../voucher/batch/:batchId` —
 * fills the card-stock voucher template from a `vouchers`/`voucher_batches`
 * row. Pure function of already-fetched rows so `document.resolver.spec.ts`
 * can drive it from fabricated data — the DB round trips live in
 * `document.service.ts`.
 */
import {
  DOC_CATALOGS,
  type DocCopySet,
  type DocPayload,
  type VoucherFieldToken,
} from '@mimi/shared';
import { formatDateOnly } from '../../../common/date-only.util';
import { formatDateText, formatIdr, formatQtyText } from '../doc-format.util';
import type { VoucherBatchRow, VoucherRow } from '../document.repository';
import { buildCodes, documentHead, splitFieldsAndLabels, type DocRenderContext } from './common';

const VOUCHER_LABEL_TOKENS: readonly VoucherFieldToken[] = ['document_title', 'voucher_type_label'];

/**
 * A voucher card sheet is the 8-up-on-A4 template (`DOC_PAPER_SIZES.card`,
 * `template.ts`) — printing a whole promo batch is a real, bounded print job
 * an office laser has to physically finish, not an on-screen list. 240 is 30
 * sheets at 8-up: a typical office tray refill (most laser trays hold
 * 250-ish sheets of card stock before jamming risk climbs), rounded DOWN to
 * a multiple of 8 so the print job never ends mid-sheet with orphaned blank
 * card slots. A batch bigger than this is legitimately handled as several
 * print runs by the owner, not a system limitation this ticket should hide
 * behind an error — see `resolveVoucherBatch`'s truncation-not-rejection
 * behaviour below.
 */
export const VOUCHER_BATCH_PRINT_CAP = 240;

export interface ResolveVoucherInput {
  voucher: VoucherRow;
  batch: VoucherBatchRow;
  companyName: string;
  /** Names of the batch's `location_ids`, already resolved — `''` when unrestricted (see `resolveOutletScope`). */
  locationNames: string[];
  ctx: DocRenderContext;
}

export function resolveVoucher(input: ResolveVoucherInput): DocPayload {
  const { voucher, batch, companyName, locationNames, ctx } = input;

  const all: Record<VoucherFieldToken, string> = {
    document_title: 'docs.title.voucher',
    company_name: companyName,
    voucher_code: voucher.code,
    voucher_name: batch.name,
    voucher_value: formatVoucherValue(batch),
    voucher_type_label: `docs.voucherType.${batch.type}`,
    min_subtotal: formatIdr(batch.min_subtotal),
    valid_from: formatDateText(formatDateOnly(batch.valid_from)),
    valid_until: formatDateText(formatDateOnly(batch.valid_until)),
    batch_code: batch.code,
    outlet_scope: resolveOutletScope(batch, locationNames),
    terms: batch.terms ?? '',
  };
  const { fields, labelKeys } = splitFieldsAndLabels(all, VOUCHER_LABEL_TOKENS);

  return {
    ...documentHead('voucher', ctx),
    fields,
    labelKeys,
    items: [],
    totals: [],
    codes: buildCodes(DOC_CATALOGS.voucher.defaultCodeSource, all),
    documentNumber: voucher.code,
  };
}

export interface ResolveVoucherBatchInput {
  batch: VoucherBatchRow;
  /** ALL vouchers of the batch, ordered by `code` ASC — capping happens here, not at the caller. */
  vouchers: VoucherRow[];
  companyName: string;
  locationNames: string[];
  ctx: DocRenderContext;
}

/**
 * Truncates to `VOUCHER_BATCH_PRINT_CAP` rather than rejecting an
 * over-sized batch — a print job that quietly gives the owner the first 240
 * cards (by code, i.e. deterministic and reproducible on a re-print) is
 * recoverable; a 400 that blocks printing ANY of a 500-voucher batch is not.
 * See `VOUCHER_BATCH_PRINT_CAP`'s own comment for the number's origin.
 */
export function resolveVoucherBatch(input: ResolveVoucherBatchInput): DocCopySet {
  const { batch, vouchers, companyName, locationNames, ctx } = input;
  const capped = vouchers.slice(0, VOUCHER_BATCH_PRINT_CAP);
  const copies = capped.map((voucher) =>
    resolveVoucher({ voucher, batch, companyName, locationNames, ctx }),
  );
  return { kind: 'voucher', documentNumber: batch.code, copies };
}

/** Fixed batches print a rupiah amount; percentage batches print `'10%'` — see `voucher_batches.value`'s dual meaning (migration 254's header). */
function formatVoucherValue(batch: VoucherBatchRow): string {
  return batch.type === 'percentage' ? `${formatQtyText(batch.value)}%` : formatIdr(batch.value);
}

/**
 * `''` when a batch is usable at every outlet (`location_ids IS NULL`) — a
 * language-free empty cell rather than an i18n key, because "no
 * restriction" is not one of the fixed enum values `docs.*` keys exist for;
 * an owner-facing "Semua outlet" copy belongs to the frontend rendering an
 * empty scope, the same way it already renders an empty `notes` field as
 * nothing rather than the word "none". A restricted batch prints the actual
 * outlet names, comma-joined — real data, not copy.
 */
function resolveOutletScope(batch: VoucherBatchRow, locationNames: string[]): string {
  if (batch.location_ids === null) return '';
  return locationNames.join(', ');
}
