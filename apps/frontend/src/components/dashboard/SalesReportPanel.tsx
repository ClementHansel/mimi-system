'use client';

import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { usePermissions } from '@/lib/permissions';
import { ApiError } from '@/lib/api';
import { formatMoney, formatNumber } from '@/lib/formatters';
import { sumMoney } from '@/lib/money';
import { Select, type SelectOption } from '@/components/ui/Select';
import { DataTable, type DataTableColumn } from '@/components/ui/DataTable';
import { ExportButton } from '@/components/common/ExportButton';
import { reportApi } from './lib/report-api';
import {
  salesExportColumns,
  salesGroupByLabelI18nKey,
  salesGroupColumnI18nKey,
} from './lib/sales-columns';
import type { ISODate } from '@/lib/shared-types';
import type { LocationOption, SalesGroupBy, SalesReportRow } from './lib/report-types';

export interface SalesReportPanelProps {
  from: ISODate;
  to: ISODate;
  /**
   * Outlet-scoped mode (Supervisor's dashboard): pins the report to one
   * location and renders NO outlet dropdown. Omitted = company mode, which
   * renders the "Semua Outlet / <outlet>" filter.
   */
  lockedLocationId?: string;
  /** Outlet name shown in the export/PDF title in locked mode. */
  lockedLocationName?: string;
}

const GROUP_BY_OPTIONS: SalesGroupBy[] = ['day', 'outlet', 'product', 'method', 'channel'];

/** A report row with a collision-proof table key — `groupBy=method` can legitimately repeat a `groupKey`. */
type SalesTableRow = SalesReportRow & { _rowKey: string };

/**
 * F03 dashboard — Sales report tab (CONTRACTS §4.19 `GET /reports/sales`).
 * Mounted both from the company dashboard (no `lockedLocationId`, own outlet
 * filter) and from a Supervisor's single-outlet dashboard (`lockedLocationId`
 * pinned, no filter rendered) — see `DashboardShell`. `from`/`to` are owned by
 * the shell's `DateRangePicker`; this panel never renders its own.
 */
export function SalesReportPanel({
  from,
  to,
  lockedLocationId,
  lockedLocationName,
}: SalesReportPanelProps) {
  const { t } = useI18n();
  const { can } = usePermissions();
  const isLockedMode = lockedLocationId !== undefined;

  const [locations, setLocations] = useState<LocationOption[]>([]);
  const [selectedLocationId, setSelectedLocationId] = useState('');
  const [groupBy, setGroupBy] = useState<SalesGroupBy>('day');
  const [rows, setRows] = useState<SalesReportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

  // Company mode only — a locked-mode caller (Supervisor) has no other
  // outlet to pick from, so there is nothing to populate the dropdown with.
  useEffect(() => {
    if (isLockedMode) return;
    let cancelled = false;
    reportApi
      .listLocations()
      .then((res) => {
        if (!cancelled) setLocations(res);
      })
      .catch(() => {
        // Non-fatal: the outlet filter just stays "Semua Outlet"-only. The
        // report fetch below carries its own error state for the data itself.
      });
    return () => {
      cancelled = true;
    };
  }, [isLockedMode]);

  // Locked mode always sends the pinned id (never ''); company mode sends
  // '' (blank) as `undefined` so the backend reads it as "my full scope".
  const effectiveLocationId = lockedLocationId ?? (selectedLocationId || undefined);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    reportApi
      .getSales(groupBy, from, to, effectiveLocationId)
      .then((res) => {
        if (!cancelled) setRows(res.rows);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const message = err instanceof ApiError ? err.message : t('table.error');
          setError(`${message} — ${t('dashboard.sales.loadErrorHint')}`);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [groupBy, from, to, effectiveLocationId, t]);

  const tableRows: SalesTableRow[] = useMemo(
    () => rows.map((r, i) => ({ ...r, _rowKey: `${r.groupKey}-${i}` })),
    [rows],
  );

  const columns: DataTableColumn<SalesTableRow>[] = [
    { key: 'groupLabel', header: t(salesGroupColumnI18nKey(groupBy)) },
    {
      key: 'txCount',
      header: t('dashboard.sales.columnTxCount'),
      align: 'right',
      render: (r) => formatNumber(r.txCount),
    },
    {
      key: 'gross',
      header: t('dashboard.sales.columnGross'),
      align: 'right',
      render: (r) => formatMoney(r.gross),
    },
    {
      key: 'discount',
      header: t('dashboard.sales.columnDiscount'),
      align: 'right',
      render: (r) => formatMoney(r.discount),
    },
    {
      key: 'platformFees',
      header: t('dashboard.sales.columnPlatformFees'),
      align: 'right',
      render: (r) => formatMoney(r.platformFees),
    },
    {
      key: 'net',
      header: t('dashboard.sales.columnNet'),
      align: 'right',
      render: (r) => formatMoney(r.net),
    },
  ];

  const outletOptions: SelectOption[] = [
    { value: '', label: t('dashboard.sales.allOutlets') },
    ...locations.map((l) => ({ value: l.id, label: `${l.code} — ${l.name}` })),
  ];

  const groupByOptions: SelectOption[] = GROUP_BY_OPTIONS.map((g) => ({
    value: g,
    label: t(salesGroupByLabelI18nKey(g)),
  }));

  const selectedLocation = locations.find((l) => l.id === selectedLocationId);
  const scopeLabel =
    lockedLocationName ??
    (selectedLocation
      ? `${selectedLocation.code} — ${selectedLocation.name}`
      : t('dashboard.sales.allOutlets'));
  const scopeSuffix = lockedLocationId
    ? `-${lockedLocationId}`
    : selectedLocation
      ? `-${selectedLocation.code}`
      : '';
  const filenameBase = `sales-report-${from}-${to}${scopeSuffix}`;
  const pdfTitle = t('dashboard.sales.exportTitle', { scope: scopeLabel, from, to });

  const showTotals = !loading && !error && rows.length > 0;
  const totals = {
    txCount: rows.reduce((sum, r) => sum + r.txCount, 0),
    gross: sumMoney(rows.map((r) => r.gross)),
    discount: sumMoney(rows.map((r) => r.discount)),
    platformFees: sumMoney(rows.map((r) => r.platformFees)),
    net: sumMoney(rows.map((r) => r.net)),
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="flex flex-wrap items-end gap-2">
          {!isLockedMode && (
            <Select
              label={t('dashboard.sales.outlet')}
              value={selectedLocationId}
              onValueChange={setSelectedLocationId}
              options={outletOptions}
              wrapperClassName="w-56"
            />
          )}
          <Select
            label={t('dashboard.sales.groupBy')}
            value={groupBy}
            onValueChange={(v) => setGroupBy(v as SalesGroupBy)}
            options={groupByOptions}
            wrapperClassName="w-44"
          />
        </div>
        {can('report.export') && (
          <ExportButton
            rows={rows}
            columns={salesExportColumns(t, groupBy)}
            filenameBase={filenameBase}
            pdfTitle={pdfTitle}
          />
        )}
      </div>

      <p className="text-xs text-text-muted">{t('dashboard.sales.platformFeesNote')}</p>

      <DataTable
        columns={columns}
        data={{
          rows: tableRows,
          total: tableRows.length,
          page: 1,
          pageSize: Math.max(tableRows.length, 1),
        }}
        keyField={(r) => r._rowKey}
        loading={loading}
        error={error}
        emptyTitle={t('dashboard.sales.empty')}
        emptyDescription={t('dashboard.sales.emptyHint')}
      />

      {showTotals && (
        <div className="flex flex-col gap-2 rounded-md border border-border bg-surface-sunken p-3 text-sm">
          <span className="font-semibold text-text-primary">{t('dashboard.sales.totals')}</span>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <div className="flex flex-col">
              <span className="text-xs text-text-muted">{t('dashboard.sales.columnTxCount')}</span>
              <span className="font-semibold tabular-nums">{formatNumber(totals.txCount)}</span>
            </div>
            <div className="flex flex-col">
              <span className="text-xs text-text-muted">{t('dashboard.sales.columnGross')}</span>
              <span className="font-semibold tabular-nums">{formatMoney(totals.gross)}</span>
            </div>
            <div className="flex flex-col">
              <span className="text-xs text-text-muted">{t('dashboard.sales.columnDiscount')}</span>
              <span className="font-semibold tabular-nums">{formatMoney(totals.discount)}</span>
            </div>
            <div className="flex flex-col">
              <span className="text-xs text-text-muted">
                {t('dashboard.sales.columnPlatformFees')}
              </span>
              <span className="font-semibold tabular-nums">{formatMoney(totals.platformFees)}</span>
            </div>
            <div className="flex flex-col">
              <span className="text-xs text-text-muted">{t('dashboard.sales.columnNet')}</span>
              <span className="font-semibold tabular-nums">{formatMoney(totals.net)}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
