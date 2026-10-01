'use client';

import { useCallback, useEffect, useState } from 'react';
import { dashboardApi } from './dashboard-api';
import type { AnomalyResponse } from './anomaly-types';
import type { ISODate } from '@/lib/shared-types';
import { errMsg } from '@/lib/api-error';

/**
 * `/api/dashboard/anomalies` for the dashboard's date range. Lives in the
 * dashboard SHELL rather than the panel so the tab's count badge and the
 * overview strip read the same response the panel renders — one request, not
 * one per surface. `includeReviewed` is part of the request (the server
 * returns reviewed findings only when asked), so toggling it refetches.
 */
export function useAnomalies(from: ISODate, to: ISODate, includeReviewed: boolean) {
  const [data, setData] = useState<AnomalyResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [reloadToken, setReloadToken] = useState(0);

  const reload = useCallback(() => setReloadToken((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    dashboardApi
      .getAnomalies(from, to, includeReviewed)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errMsg(err, 'Gagal memuat data'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [from, to, includeReviewed, reloadToken]);

  return { data, loading, error, reload };
}
