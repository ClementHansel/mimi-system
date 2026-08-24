'use client';

import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { toDateInput } from '@/lib/dates';
import { formatMoney, formatNumber } from '@/lib/formatters';
import { DataTable, type DataTableColumn } from '@/components/ui/DataTable';
import { Drawer } from '@/components/ui/Drawer';
import { Badge } from '@/components/ui/Badge';
import { ApiError } from '@/lib/api';
import { ExportButton } from '@/components/common/ExportButton';
import type { CsvColumn } from '@/lib/export/csv';
import { dashboardApi } from './lib/dashboard-api';
import { OutletDrilldownContent } from './OutletDrilldownContent';
import type { ISODate } from '@/lib/shared-types';
import type { OutletTile } from './lib/types';

const EXPORT_COLUMNS: CsvColumn<OutletTile>[] = [
  { key: 'name', header: 'Outlet' },
  { key: 'city', header: 'Kota' },
  { key: 'revenue', header: 'Omzet', format: (r) => formatMoney(r.revenue) },
  { key: 'txCount', header: 'Jumlah Transaksi' },
  { key: 'onlineNet', header: 'Omzet Online', format: (r) => formatMoney(r.onlineNet) },
  { key: 'openShifts', header: 'Shift Terbuka' },
  { key: 'lowStockCount', header: 'Stok Rendah' },
  { key: 'offlineDevices', header: 'Perangkat Offline' },
];

/**
 * FR-DASH-02/04 — "all 15-20 outlets, one view" (CONTRACTS §4.18), with a
 * row click driving the `/outlet/:locationId` drill-down (FR-DASH-02). Only
 * ever mounted for a `dashboard.view` holder (Owner/Manager) — `/outlets`
 * requires that permission, so a Supervisor (outlet-view-only) never reaches
 * this component; see `DashboardShell`.
 */
export function OutletsPanel() {
  const { t } = useI18n();
  const [date, setDate] = useState<ISODate>(toDateInput(new Date()));
  const [rows, setRows] = useState<OutletTile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [selected, setSelected] = useState<OutletTile | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    dashboardApi
      .listOutlets(date)
      .then((res) => {
        if (!cancelled) setRows(res);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : t('table.error'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [date, t]);

  const columns: DataTableColumn<OutletTile>[] = [
    {
      key: 'name',
      header: t('dashboard.outlets.columnName'),
      render: (r) => (
        <div className="flex flex-col">
          <span className="font-medium text-text-primary">{r.name}</span>
          <span className="text-xs text-text-muted">{r.city}</span>
        </div>
      ),
    },
    {
      key: 'revenue',
      header: t('dashboard.overview.revenue'),
      align: 'right',
      render: (r) => formatMoney(r.revenue),
    },
    {
      key: 'txCount',
      header: t('dashboard.overview.txCount'),
      align: 'right',
      render: (r) => formatNumber(r.txCount),
    },
    {
      key: 'onlineNet',
      header: t('dashboard.overview.revenueOnline'),
      align: 'right',
      render: (r) => formatMoney(r.onlineNet),
    },
    {
      key: 'openShifts',
      header: t('dashboard.outlets.openShifts'),
      align: 'right',
      render: (r) => formatNumber(r.openShifts),
    },
    {
      key: 'lowStockCount',
      header: t('dashboard.outlets.lowStockCount'),
      align: 'center',
      render: (r) =>
        r.lowStockCount > 0 ? (
          <Badge variant="warning" size="sm">
            {formatNumber(r.lowStockCount)}
          </Badge>
        ) : (
          '—'
        ),
    },
    {
      key: 'offlineDevices',
      header: t('dashboard.outlets.offlineDevices'),
      align: 'center',
      render: (r) =>
        r.offlineDevices > 0 ? (
          <Badge variant="danger" size="sm">
            {formatNumber(r.offlineDevices)}
          </Badge>
        ) : (
          '—'
        ),
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex w-fit items-center gap-2 text-sm text-text-secondary">
          {t('common.date')}
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="rounded-md border border-border-strong bg-surface-raised px-2 py-1.5 text-sm text-text-primary focus-visible:border-brand-500"
          />
        </label>
        <ExportButton
          rows={rows}
          columns={EXPORT_COLUMNS}
          filenameBase="dashboard-outlet"
          pdfTitle="Kinerja Outlet"
        />
      </div>

      <DataTable
        columns={columns}
        data={{ rows, total: rows.length, page: 1, pageSize: Math.max(rows.length, 1) }}
        keyField={(r) => r.locationId}
        loading={loading}
        error={error}
        emptyTitle={t('dashboard.outlets.empty')}
        onRowClick={(r) => setSelected(r)}
      />

      <Drawer
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected?.name ?? ''}
        size="lg"
      >
        {selected && <OutletDrilldownContent locationId={selected.locationId} date={date} />}
      </Drawer>
    </div>
  );
}
