import { witaDateRange } from '../../../../kernel/time/wita-range.sql';
import { addDays, daysBetween, eachDate, fixed, locFilter, median } from '../anomaly-util';
import type { AnomalyThresholds } from '../anomaly-thresholds';
import type { DetectorContext, DetectorOutput, RawAnomalyItem } from '../anomaly.types';

export interface ProductDayQty {
  locationId: string;
  productId: string;
  productName: string;
  date: string;
  qty: number;
}

/**
 * The longest stretch the baseline looks at. A single-day window has no
 * "median day" of its own, so the span is widened to at least this many days
 * ending at the window's end — the 1,394 "Sayap" has to be judged against how
 * the product normally sells, not against itself.
 */
export const MIN_QTY_SPAN_DAYS = 28;

/** The first day of the span the medians are taken over. */
export function qtySpanStart(from: string, to: string): string {
  const widest = addDays(to, -(MIN_QTY_SPAN_DAYS - 1));
  return from < widest ? from : widest;
}

/**
 * Pure core. For each outlet x product, the median is taken over EVERY
 * calendar day in the span, a day with no sale counting as 0 — that is what
 * makes "normally ~0" mean something: a product that sells twice a month has a
 * median of 0, so a day of 1,394 is flagged however the rest of the span looks.
 */
export function findProductQtyOutliers(
  rows: readonly ProductDayQty[],
  from: string,
  to: string,
  th: AnomalyThresholds['product_qty_outlier'],
): RawAnomalyItem[] {
  const spanStart = qtySpanStart(from, to);
  const days = eachDate(spanStart, to);
  const groups = new Map<string, ProductDayQty[]>();
  for (const r of rows) {
    const key = `${r.locationId}:${r.productId}`;
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  const items: RawAnomalyItem[] = [];
  for (const list of groups.values()) {
    const byDate = new Map(list.map((r) => [r.date, r.qty]));
    const med = median(days.map((d) => byDate.get(d) ?? 0)) ?? 0;
    for (const r of list) {
      if (r.date < from || r.date > to) continue;
      if (r.qty < th.minQty) continue;
      if (r.qty <= th.multiple * med) continue;
      const ratio = med > 0 ? r.qty / med : null;
      items.push({
        fingerprint: `product_qty_outlier:${r.locationId}:${r.productId}:${r.date}`,
        severity: ratio === null || ratio >= th.multiple * 2 ? 'high' : 'medium',
        locationId: r.locationId,
        date: r.date,
        period: null,
        metric: 'qty',
        unit: 'qty',
        expected: fixed(med, 3),
        actual: fixed(r.qty, 3),
        ratio: ratio === null ? null : Number(ratio.toFixed(2)),
        detail: { product: r.productName, spanDays: daysBetween(spanStart, to) + 1 },
        ref: { locationId: r.locationId, date: r.date, productId: r.productId },
        link: null,
      });
    }
  }
  return items.sort((a, b) => Number(b.actual) - Number(a.actual));
}

/**
 * `product_qty_outlier` — a day's sold qty of one product at one outlet
 * against that product's median day there.
 *
 * Only (outlet, product) pairs that have at least one day at or above
 * `minQty` inside the window get a baseline fetched (step 2 below) — the
 * overwhelming majority of pairs can never be flagged, and shipping every
 * outlet x product x day row to the application would be the slow part.
 */
export async function detectProductQtyOutliers(ctx: DetectorContext): Promise<DetectorOutput> {
  const th = ctx.th.product_qty_outlier;

  // Step 1 — which (outlet, product) pairs could possibly be flagged: those
  // with at least one day at or above `minQty` INSIDE the window. Only the
  // window is read, so on a typical week this is the cheap query and, when it
  // finds nothing (the usual case), the 28-day history is never touched.
  const cparams: unknown[] = [ctx.from, ctx.to, th.minQty];
  const cscope = locFilter(ctx, 's.location_id', cparams);
  const cand = await ctx.client.query<{ location_id: string; product_id: string }>(
    `SELECT DISTINCT s.location_id, sl.product_id
       FROM sales s
       JOIN sale_lines sl ON sl.sale_id = s.id
      WHERE s.status = 'completed'
        AND ${witaDateRange('s.occurred_at', 1, 2)}
        ${cscope}
      GROUP BY s.location_id, sl.product_id, (s.occurred_at AT TIME ZONE 'Asia/Makassar')::date
     HAVING SUM(sl.qty) >= $3::numeric`,
    cparams,
  );
  if (cand.rows.length === 0) return { items: [] };
  const pairs = new Set(cand.rows.map((r) => `${r.location_id}:${r.product_id}`));

  // Step 2 — the daily series for just those pairs, over the whole baseline
  // span, for the median. The outlet/product arrays are a superset of the
  // pairs (a cross product); the exact pairs are re-checked below.
  const spanStart = qtySpanStart(ctx.from, ctx.to);
  const params: unknown[] = [
    spanStart,
    ctx.to,
    [...new Set(cand.rows.map((r) => r.location_id))],
    [...new Set(cand.rows.map((r) => r.product_id))],
  ];
  const res = await ctx.client.query<{
    location_id: string;
    product_id: string;
    name: string;
    d: string;
    qty: string;
  }>(
    `SELECT s.location_id, sl.product_id, p.name,
            (s.occurred_at AT TIME ZONE 'Asia/Makassar')::date::text AS d,
            SUM(sl.qty)::text AS qty
       FROM sales s
       JOIN sale_lines sl ON sl.sale_id = s.id
       JOIN products p ON p.id = sl.product_id
      WHERE s.status = 'completed'
        AND ${witaDateRange('s.occurred_at', 1, 2)}
        AND s.location_id = ANY($3::uuid[])
        AND sl.product_id = ANY($4::uuid[])
      GROUP BY s.location_id, sl.product_id, p.name, (s.occurred_at AT TIME ZONE 'Asia/Makassar')::date`,
    params,
  );
  const rows: ProductDayQty[] = res.rows
    .filter((r) => pairs.has(`${r.location_id}:${r.product_id}`))
    .map((r) => ({
      locationId: r.location_id,
      productId: r.product_id,
      productName: r.name,
      date: r.d,
      qty: Number(r.qty),
    }));
  return { items: findProductQtyOutliers(rows, ctx.from, ctx.to, th) };
}
