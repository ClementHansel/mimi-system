import { witaDateRange } from '../../../../kernel/time/wita-range.sql';
import { addDays, fixed, locFilter, median } from '../anomaly-util';
import type { AnomalyThresholds } from '../anomaly-thresholds';
import type { DetectorContext, DetectorOutput, RawAnomalyItem } from '../anomaly.types';

export interface DayRevenue {
  locationId: string;
  /** WITA calendar date. */
  date: string;
  revenue: number;
  txCount: number;
}

/**
 * The expected revenue for one outlet-day: the median of that outlet's
 * previous `baselineDays` days that had sales. With fewer than
 * `minHistoryDays` of them (a new outlet, or a short import) it falls back to
 * the median of the OTHER days in the selected window, and with fewer than 3
 * of those it gives up (`null`) — flagging a day against two data points
 * would be noise.
 *
 * A median, not a mean: the day being judged may itself be the 507M that
 * would drag a mean far enough to hide itself.
 */
export function baselineFor(
  history: readonly DayRevenue[],
  date: string,
  from: string,
  to: string,
  th: AnomalyThresholds['sales_day_outlier'],
): number | null {
  const lo = addDays(date, -th.baselineDays);
  const prior = history.filter((r) => r.date >= lo && r.date < date).map((r) => r.revenue);
  if (prior.length >= th.minHistoryDays) return median(prior);
  const inWindow = history.filter((r) => r.date >= from && r.date <= to && r.date !== date);
  if (inWindow.length >= 3) return median(inWindow.map((r) => r.revenue));
  return null;
}

/** Pure core, separated from the SQL so the threshold logic can be tested without a database. */
export function findSalesDayOutliers(
  rows: readonly DayRevenue[],
  from: string,
  to: string,
  th: AnomalyThresholds['sales_day_outlier'],
): RawAnomalyItem[] {
  const byLoc = new Map<string, DayRevenue[]>();
  for (const r of rows) {
    const list = byLoc.get(r.locationId) ?? [];
    list.push(r);
    byLoc.set(r.locationId, list);
  }
  const items: RawAnomalyItem[] = [];
  for (const [locationId, history] of byLoc) {
    for (const day of history) {
      if (day.date < from || day.date > to) continue;
      const base = baselineFor(history, day.date, from, to, th);
      if (base === null || base <= 0) continue;
      const ratio = day.revenue / base;
      const high = ratio > th.hi;
      const low = ratio < th.lo;
      if (!high && !low) continue;
      // Direction-aware excess: how many times past its own trigger.
      const excess = high ? ratio / th.hi : th.lo / Math.max(ratio, 1e-9);
      items.push({
        fingerprint: `sales_day_outlier:${locationId}:${day.date}`,
        severity: excess >= 2 ? 'high' : 'medium',
        locationId,
        date: day.date,
        period: null,
        metric: 'revenue',
        unit: 'idr',
        expected: fixed(base),
        actual: fixed(day.revenue),
        ratio: Number(ratio.toFixed(2)),
        detail: { direction: high ? 'high' : 'low', txCount: day.txCount },
        ref: { locationId, date: day.date },
        link: null,
      });
    }
  }
  // Worst first: biggest swing in either direction.
  return items.sort((a, b) => swing(b) - swing(a));
}

function swing(i: RawAnomalyItem): number {
  const r = i.ratio ?? 1;
  return r >= 1 ? r : 1 / Math.max(r, 1e-9);
}

/**
 * `sales_day_outlier` — one outlet-day's completed-sales revenue against that
 * outlet's own median. Reads `sales` directly (the matview carries online
 * rows too and can be stale; this is the figure the till actually rang up).
 *
 * The date column stays bare in WHERE: `witaDateRange` does the Asia/Makassar
 * arithmetic on the bind parameters so the filter can use
 * `idx_sales_completed_occurred_at` under RLS (see wita-range.sql.ts). The
 * `AT TIME ZONE` appears only in SELECT/GROUP BY, where it costs nothing.
 */
export async function detectSalesDayOutliers(ctx: DetectorContext): Promise<DetectorOutput> {
  const th = ctx.th.sales_day_outlier;
  const params: unknown[] = [addDays(ctx.from, -th.baselineDays), ctx.to];
  const scope = locFilter(ctx, 's.location_id', params);
  const res = await ctx.client.query<{
    location_id: string;
    d: string;
    revenue: string;
    n: number;
  }>(
    `SELECT s.location_id,
            (s.occurred_at AT TIME ZONE 'Asia/Makassar')::date::text AS d,
            SUM(s.total)::text AS revenue,
            COUNT(*)::int AS n
       FROM sales s
      WHERE s.status = 'completed'
        AND ${witaDateRange('s.occurred_at', 1, 2)}
        ${scope}
      GROUP BY s.location_id, (s.occurred_at AT TIME ZONE 'Asia/Makassar')::date`,
    params,
  );
  const rows: DayRevenue[] = res.rows.map((r) => ({
    locationId: r.location_id,
    date: r.d,
    revenue: Number(r.revenue),
    txCount: r.n,
  }));
  return { items: findSalesDayOutliers(rows, ctx.from, ctx.to, th) };
}
