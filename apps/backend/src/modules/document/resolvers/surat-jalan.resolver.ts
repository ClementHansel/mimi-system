/**
 * `GET /api/documents/surat-jalan/:id` — one `DocPayload` per (drop × copy
 * holder), assembled into a `DocCopySet`. Pure function of already-fetched
 * rows so `document.resolver.spec.ts` can drive it from fabricated data — the
 * DB round trips live in `document.service.ts`.
 */
import {
  DOC_CATALOGS,
  type DocCopySet,
  type DocItemRow,
  type DocPayload,
  type SuratJalanFieldToken,
} from '@mimi/shared';
import { formatDateOnly } from '../../../common/date-only.util';
import { formatDateText, formatQtyText, formatTempText } from '../doc-format.util';
import type {
  SjDropRow,
  SjHeaderRow,
  SjLineRow,
  SjSealRow,
  SjTempLogRow,
} from '../document.repository';
import { buildCodes, documentHead, splitFieldsAndLabels, type DocRenderContext } from './common';

/**
 * Copy holders, IN THIS EXACT ORDER — matches
 * `apps/frontend/src/app/print/surat-jalan/[id]/page.tsx`'s `COPY_HOLDERS`
 * constant byte-for-byte. Drop-major, holder-minor iteration below (page
 * N = dropIdx*3 + holderIdx + 1) is what makes this template-driven path
 * produce the SAME page order the hand-coded print page already does, so a
 * dispatcher who has memorised "gudang, then outlet, then kantor, per drop"
 * is not retrained by this feature.
 */
const COPY_HOLDERS = ['gudang', 'outlet', 'kantor'] as const;
type CopyHolder = (typeof COPY_HOLDERS)[number];

const SJ_LABEL_TOKENS: readonly SuratJalanFieldToken[] = [
  'document_title',
  'shipment_type_label',
  'copy_holder_label',
];

export interface ResolveSuratJalanInput {
  header: SjHeaderRow;
  drops: SjDropRow[];
  lines: SjLineRow[];
  seals: SjSealRow[];
  tempLogs: SjTempLogRow[];
  company: { name: string; address: string };
  ctx: DocRenderContext;
}

export function resolveSuratJalan(input: ResolveSuratJalanInput): DocCopySet {
  const { header, drops, lines, seals, tempLogs, company, ctx } = input;
  const sortedDrops = [...drops].sort((a, b) => a.drop_seq - b.drop_seq);
  const totalPages = sortedDrops.length * COPY_HOLDERS.length;

  const copies: DocPayload[] = [];
  sortedDrops.forEach((drop, dropIdx) => {
    COPY_HOLDERS.forEach((holder, holderIdx) => {
      const pageNumber = dropIdx * COPY_HOLDERS.length + holderIdx + 1;
      copies.push(
        resolveSuratJalanCopy({
          header,
          drop,
          dropCount: sortedDrops.length,
          holder,
          pageNumber,
          totalPages,
          lines: lines.filter((l) => l.drop_id === drop.id),
          seals: seals.filter((s) => s.drop_id === drop.id),
          tempLogs: tempLogs.filter((t) => t.drop_id === drop.id),
          company,
          ctx,
        }),
      );
    });
  });

  return { kind: 'surat_jalan', documentNumber: header.sj_number, copies };
}

interface ResolveCopyInput {
  header: SjHeaderRow;
  drop: SjDropRow;
  dropCount: number;
  holder: CopyHolder;
  pageNumber: number;
  totalPages: number;
  lines: SjLineRow[];
  seals: SjSealRow[];
  tempLogs: SjTempLogRow[];
  company: { name: string; address: string };
  ctx: DocRenderContext;
}

function resolveSuratJalanCopy(input: ResolveCopyInput): DocPayload {
  const {
    header,
    drop,
    dropCount,
    holder,
    pageNumber,
    totalPages,
    lines,
    seals,
    tempLogs,
    company,
    ctx,
  } = input;

  // A drop is "received" iff BOTH its own status says so AND the specific
  // line has a recorded `qty_received` — reproducing the exact rule
  // `SURAT_JALAN_COLUMN_KEYS`'s doc comment (catalog.ts) and the pre-template
  // print page both already apply, so a line that was received while its
  // sibling on the same drop was short-shipped (a `completed_discrepancy`
  // drop, still legitimately "received" as a whole) still prints correctly
  // per LINE, not just per drop.
  const dropReceived = drop.status === 'completed' || drop.status === 'completed_discrepancy';

  const all: Record<SuratJalanFieldToken, string> = {
    document_title: 'docs.title.surat_jalan',
    company_name: company.name,
    company_address: company.address,
    sj_number: header.sj_number,
    sj_date: formatDateText(formatDateOnly(header.planned_date)),
    shipment_type_label: `docs.shipmentType.${header.shipment_type_key}`,
    origin_name: header.origin_name,
    // The outlet's own copy names the outlet itself rather than a generic
    // holder word, so a stack of copies for different drops can be sorted by
    // hand — see the print page's identical `holderLabel` special-case for
    // `holder === 'outlet'`. Every OTHER holder value is a translated
    // constant, hence a `labelKeys` entry; this one is real destination
    // data, so it stays in `fields` even though it happens to equal
    // `destination_name` when `holder === 'outlet'`.
    destination_name: drop.location_name,
    destination_address: drop.location_address ?? '',
    driver_name: header.driver_name,
    vehicle_plate: header.vehicle_plate,
    // `copy_holder_label` IS translated copy (`docs.copyHolder.<holder>`) —
    // unlike the special case above, this token always names the literal
    // holder ('gudang'/'outlet'/'kantor'), never the destination outlet's
    // name, because it answers "which physical copy is this" (a Surat Jalan
    // vocabulary word), not "where did this go".
    copy_holder_label: `docs.copyHolder.${holder}`,
    seal_number: seals.map((s) => s.seal_number).join(' · '),
    // Empty string, not '0,0°C', when the shipment isn't frozen or this drop
    // logged nothing — see `formatTempText`'s '—' fallback intentionally NOT
    // used here: an empty cell prints as blank space, while '—' would assert
    // "measured, and there was nothing to report", which is a different,
    // false claim for a dry shipment that was never measured at all.
    temp_c: tempLogs.length > 0 ? tempLogs.map((t) => formatTempText(t.temp_c)).join(' · ') : '',
    dispatcher_name: header.created_by_name ?? '',
    // Language-free numeric forms — see this file's own extensive comment
    // block below for why, mirroring `doc-format.util.ts`'s date rationale.
    page_label: `${pageNumber} / ${totalPages}`,
    drop_label: `${drop.drop_seq} / ${dropCount}`,
    notes: header.notes ?? '',
  };
  const { fields, labelKeys } = splitFieldsAndLabels(all, SJ_LABEL_TOKENS);

  const items: DocItemRow[] = lines.map((line, i) => ({
    no: String(i + 1),
    code: line.item_sku,
    name: line.item_name,
    qty_sent: formatQtyText(line.qty),
    uom: line.unit_code,
    // THE RULE THIS COLUMN EXISTS TO ENFORCE (see `catalog.ts`'s
    // `SURAT_JALAN_COLUMN_KEYS` header): an empty string until the drop is
    // ACTUALLY received, never `'0'`. Printing `'0'` on an undelivered drop
    // would be a false claim that nothing arrived; the driver/outlet writes
    // the real figure on the paper by hand until then. Both halves of the
    // condition matter — a drop marked received with a NULL line (a line
    // added after receiving, or a data anomaly) must still print blank, not
    // a formatted `null`.
    qty_received:
      dropReceived && line.qty_received !== null ? formatQtyText(line.qty_received) : '',
    notes: '',
  }));

  return {
    ...documentHead('surat_jalan', ctx),
    fields,
    labelKeys,
    items,
    totals: [],
    codes: buildCodes(DOC_CATALOGS.surat_jalan.defaultCodeSource, all),
    documentNumber: header.sj_number,
  };
}

/*
 * WHY `page_label`/`drop_label` ARE RESOLVED VALUES, NOT i18n KEYS
 * -------------------------------------------------------------------------
 * The existing on-screen print page renders `t('print.sj.pageOf', { page,
 * total })` → "Halaman 3 dari 9" and `t('driver.dropSeq', { seq })` →
 * "Drop 2 — Toko Bahagia", both via i18n INTERPOLATION (a key plus params).
 * `DocPayload.labelKeys` is `Record<string, string>` — a token maps to a
 * BARE key, with nowhere to carry `{ page, total }` or `{ seq }` alongside
 * it. So a key like `'docs.field.page_label'` on its own would tell the
 * frontend "this is a page number", not WHICH page number — the one piece
 * of information the token exists to carry would be lost between here and
 * the renderer.
 *
 * The alternative of composing the interpolated PARAMS into the key itself
 * (`'docs.field.pageOf.3.9'`) was rejected: that is not a key, it is a
 * value wearing a key's clothing, and it would require the frontend's i18n
 * catalog to contain one entry per possible page count — nonsensical.
 *
 * So these two tokens are the one deliberate case where the backend emits a
 * fully resolved value instead of a key — and they are LANGUAGE-FREE ON
 * PURPOSE, using slash-separated numerics (`'3 / 9'`, `'2 / 4'`) rather than
 * the word "Halaman"/"Drop", so the one thing the backend is not allowed to
 * emit (Bahasa Indonesia copy, BUILD-PLAN §6.9) never appears in them. The
 * destination outlet's name — the other half of what `drop_label` shows on
 * screen today — is not lost by this choice: it already travels separately
 * as the `destination_name` token, so nothing an owner needs to read is
 * missing, only the pre-composed Indonesian sentence around it.
 */
