'use client';

import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Truck,
  ClipboardCheck,
  Receipt,
  WifiOff,
  GitPullRequestClosed,
  Thermometer,
  Wrench,
} from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { formatNumber } from '@/lib/formatters';
import { ApiError } from '@/lib/api';
import { dashboardApi } from './lib/dashboard-api';
import type { OpsStatusResponse } from './lib/types';

/** FR-DASH-04 — operational monitoring counters, each a live (non-matview) read scoped to the caller. */
export function OpsStatusPanel() {
  const { t } = useI18n();
  const [data, setData] = useState<OpsStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    dashboardApi
      .getOpsStatus()
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
  }, [t]);

  const tiles: {
    key: keyof OpsStatusResponse;
    label: string;
    icon: typeof AlertTriangle;
    alert?: boolean;
  }[] = [
    {
      key: 'lowStockOutlets',
      label: t('dashboard.ops.lowStockOutlets'),
      icon: AlertTriangle,
      alert: true,
    },
    { key: 'sjInTransit', label: t('dashboard.ops.sjInTransit'), icon: Truck },
    {
      key: 'pendingApprovals',
      label: t('dashboard.ops.pendingApprovals'),
      icon: ClipboardCheck,
      alert: true,
    },
    {
      key: 'pendingPayments',
      label: t('dashboard.ops.pendingPayments'),
      icon: Receipt,
      alert: true,
    },
    { key: 'offlineOutlets', label: t('dashboard.ops.offlineOutlets'), icon: WifiOff, alert: true },
    {
      key: 'openConflicts',
      label: t('dashboard.ops.openConflicts'),
      icon: GitPullRequestClosed,
      alert: true,
    },
    {
      key: 'coldChainBreaches24h',
      label: t('dashboard.ops.coldChainBreaches24h'),
      icon: Thermometer,
      alert: true,
    },
    { key: 'maintenanceDue', label: t('dashboard.ops.maintenanceDue'), icon: Wrench },
  ];

  if (error) return <p className="text-sm text-danger-600">{error}</p>;

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {tiles.map(({ key, label, icon: Icon, alert }) => {
        const value = data?.[key] ?? 0;
        const flagged = alert && value > 0;
        return (
          <div
            key={key}
            className={cn(
              'flex items-center gap-3 rounded-lg border p-3',
              flagged ? 'border-warning-200 bg-warning-50' : 'border-border bg-surface-raised',
            )}
          >
            <span
              className={cn(
                'flex size-8 flex-none items-center justify-center rounded-full',
                flagged ? 'bg-warning-100 text-warning-700' : 'bg-stone-100 text-stone-600',
              )}
            >
              <Icon className="size-4" aria-hidden />
            </span>
            <div className="flex flex-col">
              {loading ? (
                <div className="h-5 w-8 animate-pulse rounded bg-surface-sunken" />
              ) : (
                <span
                  className={cn(
                    'font-display text-lg font-semibold',
                    flagged ? 'text-warning-800' : 'text-text-primary',
                  )}
                >
                  {formatNumber(value)}
                </span>
              )}
              <span className="text-xs text-text-secondary">{label}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
