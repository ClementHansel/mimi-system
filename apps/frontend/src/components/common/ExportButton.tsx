'use client';

import { useState } from 'react';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { toast } from '@/components/ui/Toast';
import { useI18n } from '@/lib/i18n';
import { ApiError } from '@/lib/api';
import { toCsv, downloadCsv, businessDateFilename, type CsvColumn } from '@/lib/export/csv';

export interface ExportButtonProps<T> {
  /** Rows already in memory — whatever the screen's current search/filter produced. */
  rows: T[];
  columns: CsvColumn<T>[];
  /** Slug used to build `<filenameBase>-<WITA business date>.csv`. */
  filenameBase: string;
  /**
   * Fetch the FULL dataset (ignoring whatever is on-screen) for a second
   * "export all" action. Omit entirely on a screen that has no such
   * fetcher — most of these already hold every row client-side, so there is
   * nothing more to export than `rows` itself.
   */
  fetchAll?: () => Promise<T[]>;
  disabled?: boolean;
}

/**
 * Reusable CSV export affordance for list/table toolbars. Two separate
 * buttons rather than a dropdown — "what's on screen" vs "everything" is a
 * real choice an operator should see up front, not one hidden behind a menu
 * click on a screen they may only glance at.
 */
export function ExportButton<T>({
  rows,
  columns,
  filenameBase,
  fetchAll,
  disabled,
}: ExportButtonProps<T>) {
  const { t } = useI18n();
  const [loadingAll, setLoadingAll] = useState(false);

  function exportRows(data: T[]) {
    downloadCsv(businessDateFilename(filenameBase), toCsv(data, columns));
  }

  async function handleExportAll() {
    if (!fetchAll) return;
    setLoadingAll(true);
    try {
      exportRows(await fetchAll());
    } catch (err) {
      toast({
        title: t('exportData.exportError'),
        description: err instanceof ApiError ? err.message : undefined,
        variant: 'danger',
      });
    } finally {
      setLoadingAll(false);
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
        onClick={() => exportRows(rows)}
      >
        {fetchAll ? t('exportData.exportFiltered') : t('exportData.export')}
      </Button>
      {fetchAll && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          loading={loadingAll}
          disabled={disabled}
          onClick={handleExportAll}
        >
          {t('exportData.exportAll')}
        </Button>
      )}
    </div>
  );
}
