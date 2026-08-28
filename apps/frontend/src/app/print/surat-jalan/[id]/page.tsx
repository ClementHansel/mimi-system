'use client';

import { use, useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { ApiError } from '@/lib/api';
import { EmptyState } from '@/components/ui';
import { PrintFrame } from '@/components/print/PrintFrame';
import { DocumentRenderer, DocPageStyle } from '@/components/documents/DocumentRenderer';
import { docDataFromCopySet } from '@/components/documents/doc-payload';
import { getDocTemplate, getSuratJalanDocument } from '@/components/documents/doc-api';
import type { DocData, DocTemplate } from '@/lib/shared-types';

/**
 * F-DOC print route — the printable Surat Jalan, now TEMPLATE-DRIVEN.
 *
 * This is the one document in the system that is a LEGAL shipping record
 * (D-14): it travels with the goods, the receiving outlet signs it, and a
 * dispute later is settled by what it says. It used to be hand-laid-out JSX
 * in this file (see the git history of this route for that version); it now
 * fetches `getSuratJalanDocument(id)` — a `DocCopySet` the SERVER resolves —
 * and renders every copy through the same `DocumentRenderer` every other
 * document in F-DOC uses, so an owner can restyle the Surat Jalan in the
 * designer exactly like an invoice or a receipt.
 *
 * Three rules survive the rework unchanged in EFFECT, but two of the three
 * moved to where they are enforced:
 *
 *  a. THREE COPIES PER DROP (gudang / outlet / kantor) — owner, 2026-08-21.
 *     The paper is printed in gudang, and each drop needs three signed
 *     originals: one stays in gudang, one at the receiving outlet, one goes
 *     back to the office. This rule now lives in the RESOLVER
 *     (`backend/modules/document/resolvers/surat-jalan.resolver.ts`), which
 *     emits `DocCopySet.copies` as drops × 3 already split into complete,
 *     self-contained sheets — a copy that said "see sheet 1" would be
 *     worthless in a dispute. This file no longer performs the split; it only
 *     ASSERTS the count still divides evenly by `COPY_HOLDERS.length` (see
 *     `pageCountNotice` below) and renders whatever the server sent.
 *
 *  b. THE PAGE-COUNT NOTICE, printed once on screen before the operator
 *     commits paper to the printer, is still this file's job — the resolver
 *     has no UI to put a banner in. `COPY_HOLDERS` is kept here (rather than
 *     derived as `copies.length / drops`, which is fragile the moment a
 *     resolver bug or a future holder change makes the division not come out
 *     even) specifically so this notice can compute `drops` independently and
 *     say so when the numbers stop matching, instead of silently reporting a
 *     wrong count. IT MUST STAY IN STEP WITH THE RESOLVER'S OWN copy-holder
 *     list — there is no compile-time link between the two, only this
 *     comment and the equivalent one in the resolver.
 *
 *  c. UNRECEIVED QTY PRINTS BLANK, NEVER `0`. This used to be a conditional
 *     right here in the JSX (`received && line.qtyReceived !== null ? ... :
 *     <blank ruled cell>`). It is now the RESOLVER's job — it returns `''`
 *     for `qty_received` on a drop that has not been received yet — and the
 *     RENDERER's job to draw a write-in rule for any empty table cell (see
 *     `DocumentRenderer.tsx`'s `renderTable`, and `SURAT_JALAN_COLUMN_KEYS`'s
 *     comment in `@mimi/shared`'s `documents/catalog.ts`). Printing `0` would
 *     be a claim that nothing arrived, which is exactly what the resolver and
 *     the renderer now conspire to avoid without this file doing anything at
 *     all — the rule has NO code left in this file, only this note that it
 *     used to.
 */

/**
 * Who each printed copy belongs to, in the order the resolver emits them for
 * one drop. Purely descriptive here — the resolver does the actual splitting
 * — but the page-count notice below needs to know how many copies make up
 * one drop, and this is the one place that number is allowed to live on the
 * frontend. MUST stay in step with the resolver's own copy-holder list.
 */
const COPY_HOLDERS = ['gudang', 'outlet', 'kantor'] as const;

export default function PrintSuratJalanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t } = useI18n();
  const [template, setTemplate] = useState<DocTemplate | null>(null);
  const [sheets, setSheets] = useState<DocData[] | null>(null);
  const [documentNumber, setDocumentNumber] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getDocTemplate('surat_jalan'), getSuratJalanDocument(id)])
      .then(async ([tpl, copySet]) => {
        const docs = await docDataFromCopySet(copySet, t);
        if (cancelled) return;
        setTemplate(tpl);
        setSheets(docs);
        setDocumentNumber(copySet.documentNumber);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : t('doc.print.loadFailed'));
      });
    return () => {
      cancelled = true;
    };
  }, [id, t]);

  const ready = !!template && !!sheets;
  const pages = sheets?.length ?? 0;
  // Derived, not trusted blindly: if the resolver ever emits a page count
  // that is not a whole multiple of `COPY_HOLDERS.length`, showing the raw
  // page count (and skipping the "N tujuan" framing) is the honest choice —
  // inventing a fractional drop count would be a more confident-looking lie.
  const dropsExact = pages % COPY_HOLDERS.length === 0;
  const drops = dropsExact ? pages / COPY_HOLDERS.length : null;

  return (
    <PrintFrame
      title={t('print.sj.title')}
      documentNumber={documentNumber}
      ready={ready}
      // Every copy is a complete, separately-signed sheet with its own
      // letterhead baked into the template (see rule (a) above) — the
      // frame's single letterhead would just duplicate the first page's.
      letterhead={false}
    >
      {error && <EmptyState title={error} size="sm" />}
      {!ready && !error && <p className="text-sm">{t('common.loading')}</p>}

      {ready && sheets && sheets.length === 0 && (
        <EmptyState title={t('doc.print.sjEmpty')} size="sm" />
      )}

      {ready && template && sheets && sheets.length > 0 && (
        <>
          <DocPageStyle width={template.width} height={template.height} />

          <p className="print-hide mb-4 rounded-md bg-surface-sunken px-3 py-2 text-sm text-text-secondary">
            {dropsExact
              ? t('doc.print.sjCopyNotice', {
                  drops: drops ?? 0,
                  copies: COPY_HOLDERS.length,
                  pages,
                })
              : t('doc.print.sjCopyNoticeFallback', { pages })}
          </p>

          {sheets.map((sheet, i) => (
            <div key={i} className="print-copy">
              <DocumentRenderer template={template} data={sheet} />
            </div>
          ))}
        </>
      )}
    </PrintFrame>
  );
}
