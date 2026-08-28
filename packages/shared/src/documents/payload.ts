/**
 * `DocPayload` — the wire shape `GET /api/documents/**` returns: everything a
 * template needs to print ONE sheet, resolved from one real row.
 *
 * WHY THIS IS NOT JUST `DocData`
 * ------------------------------
 * `DocData` (`./data.ts`) is what the renderer consumes, and it is entirely
 * display strings — including labels like "FAKTUR", "Ditagihkan kepada",
 * "Salinan: Gudang". Those are USER-FACING COPY, and the backend may not hold
 * user-facing copy (BUILD-PLAN §6.9: Bahasa Indonesia lives in
 * `frontend/lib/i18n/id.ts`, nowhere else).
 *
 * So the server splits what it knows into two maps:
 *
 *   `fields`    — values only it can know: an invoice number, a customer name,
 *                 a formatted rupiah total, a date.
 *   `labelKeys` — tokens whose value IS copy: `document_title`, `party_label`,
 *                 `copy_holder_label`, `channel_label`, an enum's display name.
 *                 The server names the i18n KEY; the client resolves it.
 *
 * The client merges `labelKeys` (translated) OVER `fields` to build
 * `DocData.fields`. See `frontend/components/documents/doc-payload.ts`, the
 * one place that merge happens.
 *
 * The alternative — the server returning finished Indonesian text — would have
 * put product copy in two repos' worth of places and made the locale
 * un-changeable without a backend deploy. The alternative in the other
 * direction — the client re-deriving values from raw rows — would have meant
 * reimplementing money formatting and the WITA business date in the print
 * window.
 */

import type { BrandPalette } from './template';
import type { DocItemRow } from './data';
import type { DocKind } from './template';

export interface DocPayloadTotalRow {
  /** Token under `docs.total.*`. */
  key: string;
  /**
   * Already formatted, in the SAME format `frontend/lib/formatters.ts`
   * produces — `'Rp125.000'`, no space after the symbol, `.` thousands
   * separator, no sub-rupiah decimals. A payload that formatted money its own
   * way would put two different renderings of one number on the screen and on
   * the paper.
   */
  value: string;
  strong?: boolean;
}

export interface DocPayload {
  kind: DocKind;
  /** Resolved values. Keys are field tokens from the kind's catalog. */
  fields: Record<string, string>;
  /** Field token → i18n key. Resolved client-side and merged OVER `fields`. */
  labelKeys: Record<string, string>;
  items: DocItemRow[];
  totals: DocPayloadTotalRow[];
  /** `codeSource` field token → the string to encode as QR/barcode. */
  codes: Record<string, string>;
  /** Resolved client-side through `GET /api/attachments/:id/url`. */
  logoAttachmentId: string | null;
  backgroundAttachmentId: string | null;
  brand: BrandPalette;
  /**
   * What the browser should call the file if the user prints to PDF (it
   * becomes `document.title`, which is what `PrintFrame` already does for the
   * Surat Jalan). Never a path — the client sanitises separators.
   */
  documentNumber: string;
}

/**
 * A document that prints as SEVERAL sheets from one source row: a Surat Jalan
 * (one sheet per drop × per copy holder) and a voucher batch (one card per
 * issued voucher). Each element is a complete, self-contained `DocPayload` —
 * a copy that referred to "see sheet 1" would be worthless in a dispute, and
 * a voucher card that shared a code with the next one would be a fraud.
 */
export interface DocCopySet {
  kind: DocKind;
  documentNumber: string;
  copies: DocPayload[];
}

/** Where an invoice's contents come from. */
export type InvoiceSource = 'sale' | 'purchase_order' | 'manual';

export const INVOICE_SOURCES: readonly InvoiceSource[] = ['sale', 'purchase_order', 'manual'];

export function isInvoiceSource(value: unknown): value is InvoiceSource {
  return typeof value === 'string' && (INVOICE_SOURCES as readonly string[]).includes(value);
}
