'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Printer, X } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui';

/**
 * The chrome around a printable document (W5-05): a branded letterhead, the
 * on-screen action bar, and the print trigger itself.
 *
 * WHY NOT AUTO-PRINT ON LOAD. The obvious implementation calls
 * `window.print()` in an effect. It is wrong here for two reasons: the dialog
 * would open before the document's data has finished loading (printing a
 * spinner), and a user who opened the page to CHECK a Surat Jalan before
 * dispatch gets a modal dialog they did not ask for. The button is explicit,
 * and `autoPrint` exists for the caller that genuinely wants it — but it only
 * fires once `ready` is true.
 */
export function PrintFrame({
  title,
  documentNumber,
  ready,
  autoPrint = false,
  children,
}: {
  title: string;
  /** Shown in the letterhead and used as the suggested filename when the
   * browser prints to PDF (that is what `document.title` becomes). */
  documentNumber: string | null;
  /** False while data is still loading — gates both the button and autoPrint
   * so we never print a half-rendered page. */
  ready: boolean;
  autoPrint?: boolean;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const [printed, setPrinted] = useState(false);

  // The browser uses `document.title` for the print-to-PDF filename, so a
  // saved Surat Jalan lands as `SJ-202608-0001.pdf` rather than
  // "Mimi Chicken OS". Restored on unmount so it does not leak to other routes.
  useEffect(() => {
    if (!documentNumber) return;
    const previous = document.title;
    document.title = documentNumber.replace(/[/\\]/g, '-');
    return () => {
      document.title = previous;
    };
  }, [documentNumber]);

  useEffect(() => {
    if (!autoPrint || !ready || printed) return;
    setPrinted(true);
    // A frame's delay so layout/fonts settle before the dialog snapshots the
    // page; without it the first print can miss webfont metrics.
    const id = window.setTimeout(() => window.print(), 250);
    return () => window.clearTimeout(id);
  }, [autoPrint, ready, printed]);

  return (
    <>
      <div className="print-hide sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 border-b border-border bg-surface-raised px-4 py-3">
        <div>
          <p className="font-display font-semibold text-text-primary">{title}</p>
          {documentNumber && <p className="text-xs text-text-muted">{documentNumber}</p>}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            leftIcon={<X className="size-4" />}
            onClick={() => window.close()}
          >
            {t('print.close')}
          </Button>
          <Button
            size="sm"
            disabled={!ready}
            leftIcon={<Printer className="size-4" />}
            onClick={() => window.print()}
          >
            {t('print.print')}
          </Button>
        </div>
      </div>

      <div className="print-sheet">
        <header className="print-keep mb-6 flex items-start justify-between border-b-2 border-black pb-3">
          <div>
            <p className="font-display text-xl font-bold">Mimi Chicken OS</p>
            <p className="text-xs">{t('print.company')}</p>
          </div>
          <div className="text-right">
            <p className="font-display text-lg font-bold uppercase">{title}</p>
            {documentNumber && <p className="font-mono text-sm">{documentNumber}</p>}
          </div>
        </header>

        {children}
      </div>
    </>
  );
}
