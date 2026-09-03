'use client';

import { use, useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { EmptyState } from '@/components/ui';
import { PrintFrame } from '@/components/print/PrintFrame';
import { DocumentRenderer, DocPageStyle } from '@/components/documents/DocumentRenderer';
import { docDataFromPayload } from '@/components/documents/doc-payload';
import { getDocTemplate, getReceiptDocument } from '@/components/documents/doc-api';
import type { DocData, DocTemplate } from '@/lib/shared-types';
import { errMsg } from '@/lib/api-error';

/**
 * F-DOC print route — the printable POS receipt (thermal, template-driven).
 *
 * This route replaces nothing hand-coded: unlike the payslip and the old
 * Surat Jalan, a receipt was never laid out as JSX here. Its whole shape
 * comes from `getDocTemplate('receipt')` (an owner-designed layout, usually
 * an 80mm/58mm roll) and `getReceiptDocument(saleId)` (the resolved values
 * for one sale) — this file only wires the two together and hands the result
 * to `DocumentRenderer`, the single renderer shared with the designer canvas
 * and the print window builder (see that file's header for why there is
 * exactly one implementation).
 *
 * Template and payload are fetched IN PARALLEL rather than sequentially: they
 * are independent reads (one keyed by `kind`, one by `saleId`) and a thermal
 * till printing between orders should not pay two round trips back to back.
 */
export default function PrintReceiptPage({ params }: { params: Promise<{ saleId: string }> }) {
  const { saleId } = use(params);
  const { t } = useI18n();
  const [template, setTemplate] = useState<DocTemplate | null>(null);
  const [data, setData] = useState<DocData | null>(null);
  const [documentNumber, setDocumentNumber] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getDocTemplate('receipt'), getReceiptDocument(saleId)])
      .then(async ([tpl, payload]) => {
        const doc = await docDataFromPayload(payload, t);
        if (cancelled) return;
        setTemplate(tpl);
        setData(doc);
        setDocumentNumber(payload.documentNumber);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(errMsg(err, t('doc.print.loadFailed')));
      });
    return () => {
      cancelled = true;
    };
  }, [saleId, t]);

  const ready = !!template && !!data;

  return (
    <PrintFrame
      title={t('doc.print.receiptTitle')}
      documentNumber={documentNumber}
      ready={ready}
      // A template-driven sheet carries its own letterhead — whatever the
      // owner dragged onto the canvas already includes the company name and
      // document title (see `DocumentRenderer`'s header). `PrintFrame`'s
      // built-in letterhead would print a second one above it.
      letterhead={false}
    >
      {error && <EmptyState title={error} size="sm" />}
      {!ready && !error && <p className="text-sm">{t('common.loading')}</p>}

      {ready && template && data && (
        <>
          <DocPageStyle width={template.width} height={template.height} />
          <div className="print-copy">
            <DocumentRenderer template={template} data={data} />
          </div>
        </>
      )}
    </PrintFrame>
  );
}
