'use client';

import { use, useEffect, useMemo, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { EmptyState } from '@/components/ui';
import { PrintFrame } from '@/components/print/PrintFrame';
import { DocumentRenderer, DocPageStyle } from '@/components/documents/DocumentRenderer';
import { docDataFromCopySet } from '@/components/documents/doc-payload';
import {
  VOUCHER_BATCH_CARD_CAP,
  getDocTemplate,
  getVoucherBatchDocument,
} from '@/components/documents/doc-api';
import { DOC_PAPER_SIZES, type DocData, type DocTemplate } from '@/lib/shared-types';
import { errMsg } from '@/lib/api-error';

/**
 * F-DOC print route — a voucher BATCH as an N-up A4 sheet with cut guides.
 *
 * A single voucher card (`getVoucherDocument`) prints one card per page,
 * which is correct for reprinting a lost card but wasteful for a batch of a
 * hundred: nobody feeds a thermal-card printer for a promo run, they print
 * A4 and cut. So this route is the one place in the print layer that lays
 * out MULTIPLE `DocData` sheets onto a SINGLE page instead of giving each its
 * own — everything else here (`surat-jalan`, and every `.print-copy` in
 * `print.css`) is built on "one copy = one page" and would need to change if
 * this route reused that pattern.
 *
 * HOW MANY CARDS FIT, AND WHY IT IS COMPUTED, NOT HARDCODED. The template
 * that shapes a voucher card is owner-authored (`documents/defaults.ts`
 * only seeds it; `DocumentDesigner` lets an owner resize it), so "2 columns ×
 * 5 rows" is a fact about TODAY's default card (324×204px) fitting TODAY's
 * A4 canvas (794×1123px, `DOC_PAPER_SIZES.A4`), not a constant this file is
 * allowed to assume. `cardsPerSheet` below is `Math.floor` of both axes
 * against the fetched template's own `width`/`height`, so a batch printed
 * after an owner nudges the card size still tiles correctly instead of
 * silently overflowing (or under-filling) the sheet.
 */
export default function PrintVoucherBatchPage({
  params,
}: {
  params: Promise<{ batchId: string }>;
}) {
  const { batchId } = use(params);
  const { t } = useI18n();
  const [template, setTemplate] = useState<DocTemplate | null>(null);
  const [sheets, setSheets] = useState<DocData[] | null>(null);
  const [documentNumber, setDocumentNumber] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getDocTemplate('voucher'), getVoucherBatchDocument(batchId)])
      .then(async ([tpl, copySet]) => {
        const docs = await docDataFromCopySet(copySet, t);
        if (cancelled) return;
        setTemplate(tpl);
        setSheets(docs);
        setDocumentNumber(copySet.documentNumber);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(errMsg(err, t('doc.print.loadFailed')));
      });
    return () => {
      cancelled = true;
    };
  }, [batchId, t]);

  const ready = !!template && !!sheets;

  // Columns/rows are floors, not rounded — a card that is only PARTLY on the
  // sheet is not printable, so a fractional remainder (e.g. A4 height 1123 /
  // card height 204 = 5.5) is simply unused margin at the bottom of the
  // sheet, never a sixth half-card.
  const layout = useMemo(() => {
    if (!template) return null;
    const cols = Math.max(1, Math.floor(DOC_PAPER_SIZES.A4.width / template.width));
    const rows = Math.max(1, Math.floor(DOC_PAPER_SIZES.A4.height / template.height));
    return { cols, rows, perSheet: cols * rows };
  }, [template]);

  const pages = layout && sheets ? Math.ceil(sheets.length / layout.perSheet) : 0;

  return (
    <PrintFrame
      title={t('doc.print.voucherTitle')}
      documentNumber={documentNumber}
      ready={ready}
      // Each voucher card is one grid cell of a shared A4 page, not its own
      // sheet — a per-card letterhead has no meaning here, and the cards
      // themselves already carry whatever branding the template places on
      // them (see the file header on why this route tiles instead of paging).
      letterhead={false}
    >
      {error && <EmptyState title={error} size="sm" />}
      {!ready && !error && <p className="text-sm">{t('common.loading')}</p>}

      {ready && sheets && sheets.length === 0 && (
        <EmptyState title={t('doc.print.voucherEmpty')} size="sm" />
      )}

      {ready && template && sheets && sheets.length > 0 && layout && (
        <>
          {/*
            `DocPageStyle` is fed A4's own dimensions here, NOT the
            template's. Every other print route hands it the template size
            because there the template IS the page; here the PAGE is a fixed
            A4 sheet and the template is just the repeating unit tiled across
            it, so sizing `@page` to a 324×204 card would print ten separate
            tiny A4-sized pages instead of one A4 sheet of ten cards.
          */}
          <DocPageStyle width={DOC_PAPER_SIZES.A4.width} height={DOC_PAPER_SIZES.A4.height} />

          <p className="print-hide mb-4 rounded-md bg-surface-sunken px-3 py-2 text-sm text-text-secondary">
            {t('doc.print.voucherSheetNotice', {
              count: sheets.length,
              perSheet: layout.perSheet,
              pages,
            })}
          </p>

          {/*
            The endpoint truncates at `VOUCHER_BATCH_CARD_CAP`. Landing EXACTLY
            on the cap is the only signal available that there may be more —
            the response carries no total — so this warns on equality and is
            deliberately worded as "more than", not "N remaining". A batch of
            exactly 240 gets one unnecessary warning; a batch of 500 does not
            get silently half-printed. That trade is the right way round.
          */}
          {sheets.length >= VOUCHER_BATCH_CARD_CAP && (
            <p className="print-hide mb-4 rounded-md bg-warning-50 px-3 py-2 text-sm text-warning-700">
              {t('doc.print.voucherCapNotice', { cap: VOUCHER_BATCH_CARD_CAP })}
            </p>
          )}

          {chunk(sheets, layout.perSheet).map((pageCards, pageIdx) => (
            <div
              key={pageIdx}
              className="print-copy"
              style={{
                width: DOC_PAPER_SIZES.A4.width,
                height: DOC_PAPER_SIZES.A4.height,
                display: 'grid',
                gridTemplateColumns: `repeat(${layout.cols}, ${template.width}px)`,
                gridTemplateRows: `repeat(${layout.rows}, ${template.height}px)`,
                justifyContent: 'center',
                alignContent: 'start',
              }}
            >
              {pageCards.map((card, cardIdx) => (
                <div
                  key={cardIdx}
                  // Dashed cut guides on every edge but the sheet's own outer
                  // border — a guide around the whole page would just be a
                  // frame, not a cut line, and printing it would waste
                  // toner tracing the paper's own edge.
                  style={{
                    outline: '1px dashed #9ca3af',
                    outlineOffset: '-0.5px',
                  }}
                >
                  <DocumentRenderer template={template} data={card} />
                </div>
              ))}
            </div>
          ))}
        </>
      )}
    </PrintFrame>
  );
}

/** Splits `items` into consecutive groups of at most `size`. `size` is always ≥ 1 (see `layout` above). */
function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
