'use client';

import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { fmtDate } from '@/lib/dates';
import { formatMoney, formatNumber, formatQty } from '@/lib/formatters';
import { Select } from '@/components/ui/Select';
import { ChartCard } from '@/components/ui/ChartCard';
import { ApiError } from '@/lib/api';
import { dashboardApi } from './lib/dashboard-api';
import { ratiosForChart } from './lib/chart-scale';
import type { ISODate } from '@/lib/shared-types';
import type { TrendGranularity, TrendMetric, TrendPoint } from './lib/types';

export interface TrendPanelProps {
  from: ISODate;
  to: ISODate;
  /** Present for a scoped (single-outlet) caller; omitted for the company-wide view. */
  locationId?: string;
}

/** Renders a trend point's `value` through the formatter that matches its metric — never a bare number. */
function formatTrendValue(metric: TrendMetric, value: string): string {
  if (metric === 'revenue') return formatMoney(value);
  if (metric === 'usage') return formatQty(value);
  return formatNumber(Number(value));
}

export function TrendPanel({ from, to, locationId }: TrendPanelProps) {
  const { t } = useI18n();
  const [metric, setMetric] = useState<TrendMetric>('revenue');
  const [granularity, setGranularity] = useState<TrendGranularity>('daily');
  const [points, setPoints] = useState<TrendPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    dashboardApi
      .getTrend(metric, granularity, from, to, locationId)
      .then((res) => {
        if (!cancelled) setPoints(res);
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
  }, [metric, granularity, from, to, locationId, t]);

  const ratios = ratiosForChart(points.map((p) => p.value));

  return (
    <ChartCard
      title={t('dashboard.trend.title')}
      description={t('dashboard.trend.description')}
      loading={loading}
      empty={!loading && !error && points.length === 0}
      emptyMessage={t('dashboard.trend.empty')}
      height={300}
      action={
        <div className="flex gap-2">
          <Select
            size="sm"
            value={metric}
            onValueChange={(v) => setMetric(v as TrendMetric)}
            wrapperClassName="w-36"
            options={[
              { value: 'revenue', label: t('dashboard.trend.metricRevenue') },
              { value: 'tx', label: t('dashboard.trend.metricTx') },
              { value: 'usage', label: t('dashboard.trend.metricUsage') },
            ]}
          />
          <Select
            size="sm"
            value={granularity}
            onValueChange={(v) => setGranularity(v as TrendGranularity)}
            wrapperClassName="w-32"
            options={[
              { value: 'daily', label: t('dashboard.trend.granularityDaily') },
              { value: 'weekly', label: t('dashboard.trend.granularityWeekly') },
            ]}
          />
        </div>
      }
    >
      {error ? (
        <p className="text-sm text-danger-600">{error}</p>
      ) : (
        <div
          className="flex h-full items-end gap-1"
          role="img"
          aria-label={t('dashboard.trend.title')}
        >
          {points.map((p, i) => (
            <div
              key={p.t}
              className="group relative flex flex-1 flex-col items-center justify-end gap-1"
            >
              <div className="pointer-events-none absolute -top-8 hidden whitespace-nowrap rounded bg-stone-900 px-1.5 py-0.5 text-xs text-white group-hover:block">
                {formatTrendValue(metric, p.value)}
              </div>
              <div
                className="w-full rounded-t bg-brand-400 transition-colors group-hover:bg-brand-500"
                style={{ height: `${Math.max(2, ratios[i]! * 100)}%` }}
              />
              <span className="text-[10px] text-text-muted">{fmtDate(p.t).slice(0, 6)}</span>
            </div>
          ))}
        </div>
      )}
    </ChartCard>
  );
}
