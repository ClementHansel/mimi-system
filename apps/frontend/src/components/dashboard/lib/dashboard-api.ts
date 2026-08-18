import { api } from '@/lib/api';
import type { ISODate } from '@/lib/shared-types';
import type {
  OpsStatusResponse,
  OutletDrilldown,
  OutletTile,
  OverviewResponse,
  RefreshResult,
  StaffKpiRow,
  TopProductRow,
  TrendGranularity,
  TrendMetric,
  TrendPoint,
} from './types';

/**
 * Thin, typed wrappers over `/api/dashboard/*` (CONTRACTS.md §4.18). Every
 * query param that scopes the result server-side (`locationId`) is passed
 * through as-is — the backend, not this file, is what enforces that a scoped
 * caller can't widen their own view (`assertLocationInScope`/`scopeClause`).
 * This layer only shapes URLs and keeps call sites free of query-string
 * plumbing.
 */

function qs(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') search.set(k, String(v));
  }
  const s = search.toString();
  return s ? `?${s}` : '';
}

export const dashboardApi = {
  getOverview: (from: ISODate, to: ISODate) =>
    api.get<OverviewResponse>(`/dashboard/overview${qs({ from, to })}`),

  listOutlets: (date?: ISODate) => api.get<OutletTile[]>(`/dashboard/outlets${qs({ date })}`),

  getOutletDrilldown: (locationId: string, date?: ISODate) =>
    api.get<OutletDrilldown>(`/dashboard/outlet/${locationId}${qs({ date })}`),

  getTopProducts: (from: ISODate, to: ISODate, locationId?: string, limit = 10) =>
    api.get<TopProductRow[]>(`/dashboard/top-products${qs({ from, to, locationId, limit })}`),

  getStaffKpi: (from: ISODate, to: ISODate, locationId?: string) =>
    api.get<StaffKpiRow[]>(`/dashboard/staff-kpi${qs({ from, to, locationId })}`),

  getTrend: (
    metric: TrendMetric,
    granularity: TrendGranularity,
    from: ISODate,
    to: ISODate,
    locationId?: string,
  ) =>
    api.get<TrendPoint[]>(`/dashboard/trend${qs({ metric, granularity, from, to, locationId })}`),

  getOpsStatus: () => api.get<OpsStatusResponse>('/dashboard/ops-status'),

  refresh: () => api.post<RefreshResult[]>('/dashboard/refresh'),
};
