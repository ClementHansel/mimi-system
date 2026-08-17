'use client';

import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { formatMoney, formatQty } from '@/lib/formatters';
import { DataTable, type DataTableColumn } from '@/components/ui/DataTable';
import { ApiError } from '@/lib/api';
import { dashboardApi } from './lib/dashboard-api';
import type { ISODate } from '@/lib/shared-types';
import type { TopProductRow } from './lib/types';

/** FR-DASH-03 — top products by outlet/period. `locationId` narrows to one outlet; omitted for the company-wide ranking. */
export interface TopProductsPanelProps {
  from: ISODate;
  to: ISODate;
  locationId?: string;
}

export function TopProductsPanel({ from, to, locationId }: TopProductsPanelProps) {
  const { t } = useI18n();
  const [rows, setRows] = useState<TopProductRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    dashboardApi
      .getTopProducts(from, to, locationId, 10)
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

  const columns: DataTableColumn<TopProductRow>[] = [
    { key: 'name', header: t('dashboard.topProducts.columnProduct') },
    { key: 'qty', header: t('dashboard.topProducts.columnQty'), align: 'right', render: (r) => formatQty(r.qty) },
    { key: 'revenue', header: t('dashboard.overview.revenue'), align: 'right', render: (r) => formatMoney(r.revenue) },
  ];

  return (
    <DataTable
      columns={columns}
      data={{ rows, total: rows.length, page: 1, pageSize: Math.max(rows.length, 1) }}
      keyField={(r) => r.productId}
      loading={loading}
      error={error}
      emptyTitle={t('dashboard.topProducts.empty')}
    />
  );
}
