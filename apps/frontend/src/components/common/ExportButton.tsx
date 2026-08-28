'use client';

import { useState } from 'react';
import { Download, FileText } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { toast } from '@/components/ui/Toast';
import { useI18n } from '@/lib/i18n';
import { ApiError } from '@/lib/api';
import { fmtDateTime } from '@/lib/dates';
import { toCsv, downloadCsv, businessDateFilename, type CsvColumn } from '@/lib/export/csv';
import { toPdf, downloadPdf, businessDatePdfFilename } from '@/lib/export/pdf';
import { useBrand } from '@/lib/brand';

export interface ExportButtonProps<T> {
  /** Rows already in memory — whatever the screen's current search/filter produced. */
  rows: T[];
  columns: CsvColumn<T>[];
  /** Slug used to build `<filenameBase>-<WITA business date>.csv` / `.pdf`. */
  filenameBase: string;
  /**
   * Fetch the FULL dataset (ignoring whatever is on-screen) for a second
   * "export all" action. Omit entirely on a screen that has no such
   * fetcher — most of these already hold every row client-side, so there is
   * nothing more to export than `rows` itself.
   */
  fetchAll?: () => Promise<T[]>;
  disabled?: boolean;
  /**
   * Page heading for a companion "Ekspor PDF" action, built from the SAME
   * `rows`/`columns` as the CSV path (see `lib/export/pdf.ts`) — so this one
   * toolbar offers both formats instead of a screen bolting on a second,
   * differently-shaped export affordance. Omit to keep a screen CSV-only
   * (e.g. a table too wide/detailed to read as a monospaced report).
   */
  pdfTitle?: string;
}

/**
 * Reusable CSV + PDF export affordance for list/table toolbars. Two separate
 * buttons per format rather than a dropdown — "what's on screen" vs
 * "everything" is a real choice an operator should see up front, not one
 * hidden behind a menu click on a screen they may only glance at.
 */
export function ExportButton<T>({
  rows,
  columns,
  filenameBase,
  fetchAll,
  disabled,
  pdfTitle,
}: ExportButtonProps<T>) {
  const { t } = useI18n();
  // The exported PDF is branded from the SAME live identity the screens and
  // the designed documents use, so a list export and an invoice printed a
  // minute apart cannot disagree about the company's colour or its name.
  // `useBrand` falls back to the shipped identity before the first fetch
  // settles, so an export triggered on a cold page is still a valid document
  // rather than an un-branded one.
  const { palette, companyProfile } = useBrand();
  const [loadingAllCsv, setLoadingAllCsv] = useState(false);
  const [loadingAllPdf, setLoadingAllPdf] = useState(false);

  function exportCsvRows(data: T[]) {
    downloadCsv(businessDateFilename(filenameBase), toCsv(data, columns));
  }

  function exportPdfRows(data: T[]) {
    if (!pdfTitle) return;
    // Captured once per export (not per page) so every page of one document
    // shows the same generated-at instant, and the filename's WITA business
    // date matches what is printed on the page.
    const now = new Date();
    const bytes = toPdf(data, columns, {
      title: pdfTitle,
      generatedLabel: t('exportData.pdfGeneratedAt', { date: fmtDateTime(now) }),
      pageLabel: (page, total) => t('exportData.pdfPageOf', { page, total }),
      emptyLabel: t('exportData.pdfEmpty'),
      // `CompanyProfile` is deliberately `Record<string, unknown>` (it holds
      // keys this feature does not own — see `brand-api.ts`), so `name` is
      // narrowed here rather than assumed to be a string.
      footerLabel:
        typeof companyProfile.name === 'string'
          ? companyProfile.name.trim() || undefined
          : undefined,
      brand: { primary: palette.primary, muted: palette.muted },
    });
    downloadPdf(businessDatePdfFilename(filenameBase, now), bytes);
  }

  async function handleExportAll(format: 'csv' | 'pdf') {
    if (!fetchAll) return;
    const setLoading = format === 'csv' ? setLoadingAllCsv : setLoadingAllPdf;
    setLoading(true);
    try {
      const data = await fetchAll();
      if (format === 'csv') exportCsvRows(data);
      else exportPdfRows(data);
    } catch (err) {
      toast({
        title: t('exportData.exportError'),
        description: err instanceof ApiError ? err.message : undefined,
        variant: 'danger',
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        leftIcon={<Download className="size-4" aria-hidden />}
        disabled={disabled || rows.length === 0}
        onClick={() => exportCsvRows(rows)}
      >
        {fetchAll ? t('exportData.exportFiltered') : t('exportData.export')}
      </Button>
      {fetchAll && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          loading={loadingAllCsv}
          disabled={disabled}
          onClick={() => handleExportAll('csv')}
        >
          {t('exportData.exportAll')}
        </Button>
      )}

      {pdfTitle && (
        <>
          <Button
            type="button"
            variant="outline"
            size="sm"
            leftIcon={<FileText className="size-4" aria-hidden />}
            disabled={disabled || rows.length === 0}
            onClick={() => exportPdfRows(rows)}
          >
            {fetchAll ? t('exportData.exportPdfFiltered') : t('exportData.exportPdf')}
          </Button>
          {fetchAll && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              loading={loadingAllPdf}
              disabled={disabled}
              onClick={() => handleExportAll('pdf')}
            >
              {t('exportData.exportAllPdf')}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
