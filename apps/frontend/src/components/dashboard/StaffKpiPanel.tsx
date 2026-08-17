'use client';

import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { formatMoney, formatNumber, formatPercent } from '@/lib/formatters';
import { DataTable, type DataTableColumn } from '@/components/ui/DataTable';
import { ApiError } from '@/lib/api';
import { dashboardApi } from './lib/dashboard-api';
import type { ISODate } from '@/lib/shared-types';
import type { StaffKpiRow } from './lib/types';

/**
 * FR-DASH-03 — cashier performance + attendance. `attendanceRate` is a
 * backend-computed display percentage (bare `string`, same reasoning as
 * `OverviewResponse.vs.*` — see `staff-kpi.service.ts`), so `Number()` on it
 * only is safe; `salesAmount` stays on the `formatMoney` string path.
 */
export interface StaffKpiPanelProps {
  from: ISODate;
  to: ISODate;
  locationId?: string;
}

export function StaffKpiPanel({ from, to, locationId }: StaffKpiPanelProps) {
  const { t } = useI18n();
  const [rows, setRows] = useState<StaffKpiRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    dashboardApi
      .getStaffKpi(from, to, locationId)
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
  }, [from, to, locationId, t]);

  const columns: DataTableColumn<StaffKpiRow>[] = [
    { key: 'name', header: t('dashboard.staffKpi.columnName'), render: (r) => (
      <div className="flex flex-col">
        <span className="font-medium text-text-primary">{r.name}</span>
        <span className="text-xs text-text-muted">{r.role}</span>
      </div>
    ) },
    { key: 'salesCount', header: t('dashboard.staffKpi.columnSalesCount'), align: 'right', render: (r) => formatNumber(r.salesCount) },
    { key: 'salesAmount', header: t('dashboard.staffKpi.columnSalesAmount'), align: 'right', render: (r) => formatMoney(r.salesAmount) },
    { key: 'attendanceRate', header: t('dashboard.staffKpi.columnAttendanceRate'), align: 'right', render: (r) => formatPercent(Number(r.attendanceRate)) },
    { key: 'lateCount', header: t('dashboard.staffKpi.columnLateCount'), align: 'right', render: (r) => formatNumber(r.lateCount) },
  ];

  return (
    <DataTable
      columns={columns}
      data={{ rows, total: rows.length, page: 1, pageSize: Math.max(rows.length, 1) }}
      keyField={(r) => r.employeeId}
      loading={loading}
      error={error}
      emptyTitle={t('dashboard.staffKpi.empty')}
    />
  );
}
