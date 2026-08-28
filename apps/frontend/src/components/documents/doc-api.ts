'use client';

import { api } from '@/lib/api';
import type {
  DocCopySet,
  DocKind,
  DocPayload,
  DocTemplate,
  InvoiceSource,
  Money,
  Qty,
  UUID,
} from '@/lib/shared-types';

/**
 * The document API surface, in one place: template CRUD, and the resolvers
 * that turn a real row (a sale, a PO, a Surat Jalan, a voucher batch) into
 * something printable.
 *
 * WHY A MODULE AND NOT `api.get(...)` AT EACH CALL SITE. Five print routes, a
 * designer and the POS receipt path all reach for these. Spelling the paths
 * inline would put `/documents/invoice/purchase_order/${id}` in two files with
 * one of them eventually saying `purchase-order`, and that failure is a 404 at
 * print time on a customer-facing document. It also gives the response types
 * exactly one declaration each.
 *
 * EVERY ENDPOINT HERE IS AUTHORIZATION-CHECKED SERVER-SIDE. `doc_template.read`
 * is universal (a till must fetch the receipt layout to print, a driver the
 * Surat Jalan layout — see `rbac.ts`'s note), `doc_template.manage` is not, and
 * the resolvers below are additionally scoped by RLS to the caller's own
 * locations. The `can()` checks in the UI above this module hide buttons; they
 * are never the boundary.
 */

// ── Templates ────────────────────────────────────────────────────────────────

/**
 * The stored layout for a kind, or the seeded default.
 *
 * The FALLBACK IS SERVER-SIDE, on purpose: `GET /doc-templates/:kind` returns
 * `defaultDocTemplate(kind)` when nothing has been saved. The client could do
 * the same thing itself — `defaultDocTemplate` is exported from `@mimi/shared`
 * and this module imports the type from it already — and that is precisely why
 * it must not: two fallbacks means the day the default changes, a POS tablet
 * with a stale bundle prints a different receipt from the one the office
 * previews. One authority, and it is the one that also holds the saved rows.
 */
export function getDocTemplate(kind: DocKind): Promise<DocTemplate> {
  return api.get<DocTemplate>(`/doc-templates/${kind}`);
}

/**
 * Save a layout. The server re-runs `validateDocTemplate` and rejects with
 * `ERR_VALIDATION` + a `details` array of the same strings the designer
 * already checked against — see `DocumentDesigner`'s save path, which surfaces
 * them verbatim rather than replacing them with "gagal menyimpan".
 */
export function putDocTemplate(kind: DocKind, template: DocTemplate): Promise<DocTemplate> {
  return api.put<DocTemplate>(`/doc-templates/${kind}`, template);
}

/**
 * Reset to the seeded default. Returns the default it reset TO, so the caller
 * renders the server's idea of "default" rather than its own bundled copy —
 * same reasoning as `getDocTemplate`.
 */
export function resetDocTemplate(kind: DocKind): Promise<DocTemplate> {
  return api.delete<DocTemplate>(`/doc-templates/${kind}`);
}

// ── Resolvers: one row → one printable document ──────────────────────────────

export function getReceiptDocument(saleId: UUID): Promise<DocPayload> {
  return api.get<DocPayload>(`/documents/receipt/${saleId}`);
}

/**
 * An invoice from a POS sale or from a purchase order. The `source` segment is
 * the wire spelling of `InvoiceSource` (`sale` | `purchase_order`) — the same
 * literal the route param uses, so `/print/invoice/[source]/[id]` can pass its
 * param straight through after `isInvoiceSource` narrows it.
 */
export function getInvoiceDocument(
  source: Exclude<InvoiceSource, 'manual'>,
  id: UUID,
): Promise<DocPayload> {
  return api.get<DocPayload>(`/documents/invoice/${source}/${id}`);
}

/** One line of a manually-typed invoice. Money/Qty are decimal strings (D-10), never numbers. */
export interface ManualInvoiceLine {
  name: string;
  qty: Qty;
  uom: string;
  unitPrice: Money;
}

/**
 * A manual invoice — a bill to somebody who is neither a POS customer nor a
 * supplier on a PO.
 *
 * This one POSTs where its siblings GET, and that is not an inconsistency: the
 * others read a row that already exists, while this one has no source row at
 * all until the request creates it. The invoice NUMBER is issued by the server
 * (doc-numbering, `@mimi/shared`'s `doc-number.ts`), never by the form — two
 * operators typing a manual invoice at once must not be able to mint the same
 * number.
 */
export interface ManualInvoiceRequest {
  partyName: string;
  partyAddress?: string;
  partyPhone?: string;
  dueDate?: string;
  notes?: string;
  lines: ManualInvoiceLine[];
}

export function createManualInvoiceDocument(body: ManualInvoiceRequest): Promise<DocPayload> {
  return api.post<DocPayload>('/documents/invoice/manual', body);
}

/**
 * A Surat Jalan as a COPY SET: one payload per drop × per copy holder. The
 * three-copies rule is the server's (it emits the sheets); the print route
 * still owns the page-count notice and the "what happens if a copy is missing"
 * behaviour — see `app/print/surat-jalan/[id]/page.tsx`.
 */
export function getSuratJalanDocument(id: UUID): Promise<DocCopySet> {
  return api.get<DocCopySet>(`/documents/surat-jalan/${id}`);
}

/** One voucher card. */
export function getVoucherDocument(voucherId: UUID): Promise<DocPayload> {
  return api.get<DocPayload>(`/documents/voucher/${voucherId}`);
}

/**
 * The most cards `GET /documents/voucher/batch/:id` will ever return in one
 * response. The server truncates at this number rather than streaming an
 * unbounded run: 240 cards is already 24 sheets of A4 and several megabytes of
 * resolved payloads on a tablet.
 *
 * The client's job is to NOTICE the truncation and say so. A print route that
 * silently rendered a capped run would hand somebody 24 sheets for a batch of
 * 500 and let them believe the print job was complete — the exact failure mode
 * that turns into 260 unprinted coupons discovered at the counter.
 */
export const VOUCHER_BATCH_CARD_CAP = 240;

/** Every issued card in a batch, one payload each — each carries its own code. */
export function getVoucherBatchDocument(batchId: UUID): Promise<DocCopySet> {
  return api.get<DocCopySet>(`/documents/voucher/batch/${batchId}`);
}
