'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { Paginated } from '@/lib/api';
import { errMsg } from '@/lib/api-error';

/**
 * Generic `Paginated<T>` list-fetch hook for F10 admin's list screens (Users,
 * Items, Products, Locations, Audit — CONTRACTS §4.2-4.4/4.20, §4.0 audit).
 * DataTable is fully controlled (BUILD-PLAN component contract), so the
 * caller — here — is the one place that owns "what page/sort/filter am I on"
 * and re-fetches when any of it changes. `params` values of `''`/`undefined`
 * are dropped so an empty filter never sends `?role=` to the API.
 */
export function useApiList<T>(
  path: string,
  params: Record<string, string | number | boolean | undefined>,
) {
  const [data, setData] = useState<Paginated<T>>({ rows: [], total: 0, page: 1, pageSize: 25 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [reloadToken, setReloadToken] = useState(0);
  const paramsKey = JSON.stringify(params);

  const reload = useCallback(() => setReloadToken((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') qs.set(k, String(v));
    }
    const query = qs.toString();
    api
      .get<Paginated<T>>(`${path}${query ? `?${query}` : ''}`)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(errMsg(err, 'Gagal memuat data'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `params` is intentionally represented by its stable JSON key — the
    // object literal callers pass changes identity every render — so the
    // effect depends on `paramsKey`, not `params` itself.
  }, [path, paramsKey, reloadToken]);

  return { data, loading, error, reload };
}
