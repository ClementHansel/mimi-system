import { api } from '@/lib/api';
import type { ISODate } from '@/lib/shared-types';
import type {
  LocationOption,
  OnlineOrderReportRow,
  SalesGroupBy,
  SalesReportResult,
} from './report-types';

/**
 * Thin, typed wrappers over the `/api/reports/*` routes the dashboard's Sales
 * and Marketing tabs read (CONTRACTS.md §4.19) — the §4.19 sibling of
 * `./dashboard-api.ts`.
 *
 * `locationId` is passed through as-is and is NEVER the thing that enforces
 * scope: `SalesReportService.assertLocationInScope` rejects a locationId
 * outside the caller's `user_locations`, and omitting it returns the caller's
 * own scope (every outlet for a central role, exactly their own for a
 * supervisor). So "Semua Outlet" in the UI means "everything I'm entitled
 * to", which is why the scope banner above these tabs is not decorative.
 *
 * Every call here asks for JSON. The backend's `?format=csv|xlsx` arm is
 * deliberately unused — see `./report-types.ts`'s header for why the file
 * export is client-side.
 */

function qs(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') search.set(k, String(v));
  }
  const s = search.toString();
  return s ? `?${s}` : '';
}

export const reportApi = {
  getSales: (groupBy: SalesGroupBy, from: ISODate, to: ISODate, locationId?: string) =>
    api.get<SalesReportResult>(`/reports/sales${qs({ groupBy, from, to, locationId })}`),

  getOnlineOrders: (from: ISODate, to: ISODate, locationId?: string, platform?: string) =>
    api.get<OnlineOrderReportRow[]>(
      `/reports/online-orders${qs({ from, to, locationId, platform })}`,
    ),

  /**
   * Outlet options for the "Semua Outlet / satu outlet" filter. Tolerates all
   * three envelopes the locations route has been seen to return, exactly as
   * `InventoryPanel` does — an unwrapped array, `{rows}`, or `{data}`. Guessing
   * this wrong once already shipped a panel that rendered "no data" over
   * 1,372 real rows, so it is not narrowed here on assumption.
   */
  listLocations: () =>
    api
      .get<{ rows?: LocationOption[]; data?: LocationOption[] } | LocationOption[]>(
        '/locations?active=true',
      )
      .then((res) => (Array.isArray(res) ? res : (res.rows ?? res.data ?? []))),
};
