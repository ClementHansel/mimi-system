'use client';

import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { formatMoney, formatNumber, formatQty } from '@/lib/formatters';
import { EmptyState } from '@/components/ui/EmptyState';
import { ApiError } from '@/lib/api';
import { dashboardApi } from './lib/dashboard-api';
import { ratiosForChart } from './lib/chart-scale';
import type { ISODate } from '@/lib/shared-types';
import type { OutletDrilldown } from './lib/types';

/**
 * FR-DASH-02/04 outlet drill-down body — the tile + hourly trend + top
 * products + staff on shift, exactly `GET /api/dashboard/outlet/:locationId`
 * (CONTRACTS §4.18). Shared between the Owner/Manager drawer (opened from
 * `OutletsPanel`'s table) and a Supervisor's whole-page view, since a
 * Supervisor only ever holds `dashboard.outlet.view` for their own outlet —
 * same response shape, same component either way.
 */
export interface OutletDrilldownContentProps {
  locationId: string;
  date?: ISODate;
}

export function OutletDrilldownContent({ locationId, date }: OutletDrilldownContentProps) {
  const { t } = useI18n();
  const [data, setData] = useState<OutletDrilldown | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    dashboardApi
      .getOutletDrilldown(locationId, date)
      .then((res) => {
        if (!cancelled) setData(res);
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
  }, [locationId, date, t]);

  if (loading) {
    return (
      <div className="flex flex-col gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-16 animate-pulse rounded-lg bg-surface-sunken" />
        ))}
      </div>
    );
  }

  if (error || !data) {
    return <EmptyState title={error ?? t('table.error')} size="sm" />;
  }

  const hourlyRatios = ratiosForChart(data.hourlyTrend.map((h) => h.revenue));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h3 className="font-display text-lg font-semibold text-text-primary">{data.name}</h3>
        <p className="text-sm text-text-secondary">{data.city}</p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Stat label={t('dashboard.overview.revenue')} value={formatMoney(data.revenue)} />
        <Stat label={t('dashboard.overview.revenueOnline')} value={formatMoney(data.onlineNet)} />
        <Stat label={t('dashboard.overview.txCount')} value={formatNumber(data.txCount)} />
        <Stat label={t('dashboard.outlets.openShifts')} value={formatNumber(data.openShifts)} />
        <Stat
          label={t('dashboard.outlets.lowStockCount')}
          value={formatNumber(data.lowStockCount)}
          alert={data.lowStockCount > 0}
        />
        <Stat
          label={t('dashboard.outlets.offlineDevices')}
          value={formatNumber(data.offlineDevices)}
          alert={data.offlineDevices > 0}
        />
      </div>

      <section>
        <h4 className="mb-2 text-sm font-semibold text-text-primary">
          {t('dashboard.outlets.hourlyTrend')}
        </h4>
        {data.hourlyTrend.length === 0 ? (
          <p className="text-sm text-text-muted">{t('dashboard.trend.empty')}</p>
        ) : (
          <div className="flex h-24 items-end gap-0.5">
            {data.hourlyTrend.map((h, i) => (
              <div
                key={h.hour}
                className="group relative flex flex-1 flex-col items-center justify-end gap-0.5"
              >
                <div className="pointer-events-none absolute -top-7 hidden whitespace-nowrap rounded bg-stone-900 px-1.5 py-0.5 text-xs text-white group-hover:block">
                  {formatMoney(h.revenue)}
                </div>
                <div
                  className="w-full rounded-t bg-brand-400"
                  style={{ height: `${Math.max(2, hourlyRatios[i]! * 100)}%` }}
                />
                <span className="text-[9px] text-text-muted">{h.hour}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h4 className="mb-2 text-sm font-semibold text-text-primary">
          {t('dashboard.outlets.topProducts')}
        </h4>
        {data.topProducts.length === 0 ? (
          <p className="text-sm text-text-muted">{t('table.empty')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {data.topProducts.map((p) => (
              <li key={p.productId} className="flex items-center justify-between py-1.5 text-sm">
                <span className="text-text-primary">{p.name}</span>
                <span className="text-text-secondary">
                  {formatQty(p.qty)} · {formatMoney(p.revenue)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h4 className="mb-2 text-sm font-semibold text-text-primary">
          {t('dashboard.outlets.staffOnShift')}
        </h4>
        {data.staffOnShift.length === 0 ? (
          <p className="text-sm text-text-muted">{t('table.empty')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {data.staffOnShift.map((s) => (
              <li key={s.employeeId} className="flex items-center justify-between py-1.5 text-sm">
                <span className="text-text-primary">{s.name}</span>
                <span className="text-text-secondary">{s.position}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value, alert }: { label: string; value: string; alert?: boolean }) {
  return (
    <div
      className={`flex flex-col gap-0.5 rounded-lg border p-3 ${alert ? 'border-warning-200 bg-warning-50' : 'border-border bg-surface-raised'}`}
    >
      <span className="text-xs text-text-secondary">{label}</span>
      <span className="font-display text-base font-semibold text-text-primary">{value}</span>
    </div>
  );
}
