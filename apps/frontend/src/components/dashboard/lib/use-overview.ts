'use client';

import { useCallback, useEffect, useState } from 'react';
import { dashboardApi } from './dashboard-api';
import type { OverviewResponse } from './types';
import type { ISODate } from '@/lib/shared-types';
import { errMsg } from '@/lib/api-error';

/** `/api/dashboard/overview` fetch, with a `reload()` escape hatch for the manual-refresh button. */
export function useOverview(from: ISODate, to: ISODate) {
  const [data, setData] = useState<OverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [reloadToken, setReloadToken] = useState(0);

  const reload = useCallback(() => setReloadToken((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    dashboardApi
      .getOverview(from, to)
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
  }, [from, to, reloadToken]);

  return { data, loading, error, reload };
}
