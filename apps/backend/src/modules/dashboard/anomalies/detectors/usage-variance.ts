import { witaDateRange } from '../../../../kernel/time/wita-range.sql';
import { fixed, locFilter, severityByExcess } from '../anomaly-util';
import type { AnomalyThresholds } from '../anomaly-thresholds';
import type { DetectorContext, DetectorOutput, RawAnomalyItem } from '../anomaly.types';

export interface UsageLine {
  opnameId: string;
  opnameNumber: string;
  locationId: string;
  itemId: string;
  itemName: string;
  unit: string;
  /** WITA date the count was taken. */
  countedOn: string;
  periodStart: string | null;
  theoretical: number;
  /** counted - system, summed over the item's storage areas. */
  diff: number;
  avgCost: number;
}

/**
 * Actual usage between two counts, derived from the count itself.
 *
 * The book balance at count time is `opening + receipts - everything posted
 * out` (recipe usage included), and the count found `diff = counted - book`.
 * So whatever the books did NOT explain is `-diff`, and
 *
 *     actual = theoretical - diff
 *
 * i.e. `theoretical + |adjustment|` when stock came up short, less when it
 * came up long. That is the same number as `opening + receipts - closing`
 * with the other outflows (waste, transfers) already posted separately, and it
 * avoids re-deriving an opening balance from the movement ledger. Clamped at
 * 0: a count that finds more than the recipe says was ever used cannot have
 * "used" a negative amount.
 */
export function actualUsage(theoretical: number, diff: number): number {
  return Math.max(0, theoretical - diff);
}

export function findUsageVariances(
  lines: readonly UsageLine[],
  th: AnomalyThresholds['usage_variance'],
): RawAnomalyItem[] {
  const items: RawAnomalyItem[] = [];
  for (const l of lines) {
    const actual = actualUsage(l.theoretical, l.diff);
    const denom = Math.max(l.theoretical, actual);
    if (denom <= 0) continue;
    const gap = Math.abs(actual - l.theoretical);
    const pct = (gap / denom) * 100;
    const value = gap * l.avgCost;
    if (pct <= th.variancePct || value <= th.minValue) continue;
    items.push({
      fingerprint: `usage_variance:${l.opnameId}:${l.itemId}`,
      severity: severityByExcess(pct / th.variancePct),
      locationId: l.locationId,
      date: l.countedOn,
      period: { from: l.periodStart, to: l.countedOn },
      metric: 'usage',
      unit: 'qty',
      expected: fixed(l.theoretical, 3),
      actual: fixed(actual, 3),
      ratio: l.theoretical > 0 ? Number((actual / l.theoretical).toFixed(2)) : null,
      detail: {
        item: l.itemName,
        unit: l.unit,
        opname: l.opnameNumber,
        variancePct: Number(pct.toFixed(1)),
        value: fixed(value),
      },
      ref: { locationId: l.locationId, opnameId: l.opnameId, itemId: l.itemId },
      link: null,
    });
  }
  return items.sort((a, b) => Number(b.detail.value) - Number(a.detail.value));
}

export interface PeriodVariance {
  opnameId: string;
  opnameNumber: string;
  locationId: string;
  countedOn: string;
  periodStart: string | null;
  /** Signed: negative = stock lost. */
  variance: number;
  closingStockValue: number;
  sales: number;
}

/**
 * Period-level stock variance (the sum of the count's adjustments, valued) as
 * a share of the outlet's sales over the same stretch — and, separately, a
 * variance larger than the stock the outlet still holds, which no amount of
 * trading can explain.
 */
export function findPeriodVariances(
  periods: readonly PeriodVariance[],
  th: AnomalyThresholds['usage_variance'],
): RawAnomalyItem[] {
  const items: RawAnomalyItem[] = [];
  for (const p of periods) {
    const abs = Math.abs(p.variance);
    if (abs <= th.minValue) continue;
    const pctOfSales = p.sales > 0 ? (abs / p.sales) * 100 : null;
    const overSales = pctOfSales !== null && pctOfSales > th.periodPctOfSales;
    const overStock = abs > p.closingStockValue;
    if (!overSales && !overStock) continue;
    items.push({
      fingerprint: `usage_variance:${p.opnameId}:period`,
      severity: overStock ? 'high' : severityByExcess((pctOfSales ?? 0) / th.periodPctOfSales),
      locationId: p.locationId,
      date: p.countedOn,
      period: { from: p.periodStart, to: p.countedOn },
      metric: 'stock_variance',
      unit: 'idr',
      expected: fixed(0),
      actual: fixed(p.variance),
      ratio: pctOfSales === null ? null : Number(pctOfSales.toFixed(2)),
      detail: {
        opname: p.opnameNumber,
        pctOfSales: pctOfSales === null ? null : Number(pctOfSales.toFixed(2)),
        sales: fixed(p.sales),
        closingStockValue: fixed(p.closingStockValue),
        overStock: overStock ? 1 : 0,
      },
      ref: { locationId: p.locationId, opnameId: p.opnameId },
      link: null,
    });
  }
  return items.sort((a, b) => Math.abs(Number(b.actual)) - Math.abs(Number(a.actual)));
}

/**
 * `usage_variance` — for every stock count in the window that was adjusted
 * (`status = 'adjusted'`), per item, the recipe-theoretical usage between the
 * previous adjusted count of that item at that outlet and this one, against
 * what the count says was actually used.
 *
 * Theoretical usage is the sale-posted ledger: `usage_out` with
 * `ref_type = 'sale'`, net of the `return_in` a void posts back. It rides
 * `idx_stock_movements_loc_item_time (location_id, item_id, occurred_at)`; the
 * previous-count lookup is a correlated MAX over `stock_opname_lines`
 * (`idx_stock_opname_lines_item`). The first count of an item has no previous
 * count, so its period is unbounded on the left (`periodStart = null`) — the
 * book balance it was reconciled against started from nothing too.
 *
 * A count scoped to one storage area only counts that area's movements.
 */
export async function detectUsageVariance(ctx: DetectorContext): Promise<DetectorOutput> {
  const th = ctx.th.usage_variance;
  const params: unknown[] = [ctx.from, ctx.to];
  const scope = locFilter(ctx, 'o.location_id', params);
  const lines = await ctx.client.query<{
    opname_id: string;
    opname_number: string;
    location_id: string;
    item_id: string;
    item_name: string;
    unit: string;
    counted_on: string;
    period_start: string | null;
    theoretical: string;
    diff: string;
    avg_cost: string;
  }>(
    `WITH op AS (
       SELECT o.id, o.opname_number, o.location_id, o.storage_area_id,
              COALESCE(o.submitted_at, o.started_at) AS end_at
         FROM stock_opname o
        WHERE o.status = 'adjusted'
          AND ${witaDateRange('COALESCE(o.submitted_at, o.started_at)', 1, 2)}
          ${scope}
     ), ln AS (
       SELECT op.id AS opname_id, op.opname_number, op.location_id, op.storage_area_id, op.end_at,
              l.item_id, SUM(l.diff_qty) AS diff
         FROM op
         JOIN stock_opname_lines l ON l.opname_id = op.id
        GROUP BY op.id, op.opname_number, op.location_id, op.storage_area_id, op.end_at, l.item_id
     ), per AS (
       SELECT ln.*,
              (SELECT MAX(COALESCE(o2.submitted_at, o2.started_at))
                 FROM stock_opname o2
                 JOIN stock_opname_lines l2 ON l2.opname_id = o2.id
                WHERE o2.location_id = ln.location_id
                  AND o2.status = 'adjusted'
                  AND l2.item_id = ln.item_id
                  AND COALESCE(o2.submitted_at, o2.started_at) < ln.end_at) AS start_at
         FROM ln
     )
     SELECT per.opname_id, per.opname_number, per.location_id, per.item_id,
            i.name AS item_name, u.code AS unit, i.avg_cost::text AS avg_cost,
            (per.end_at AT TIME ZONE 'Asia/Makassar')::date::text AS counted_on,
            (per.start_at AT TIME ZONE 'Asia/Makassar')::date::text AS period_start,
            per.diff::text AS diff,
            (SELECT COALESCE(SUM(CASE m.movement_type WHEN 'usage_out' THEN m.qty ELSE -m.qty END), 0)
               FROM stock_movements m
              WHERE m.location_id = per.location_id
                AND m.item_id = per.item_id
                AND m.ref_type = 'sale'
                AND m.movement_type IN ('usage_out', 'return_in')
                AND (per.storage_area_id IS NULL OR m.storage_area_id = per.storage_area_id)
                AND (per.start_at IS NULL OR m.occurred_at > per.start_at)
                AND m.occurred_at <= per.end_at)::text AS theoretical
       FROM per
       JOIN items i ON i.id = per.item_id
       JOIN units u ON u.id = i.base_unit_id`,
    params,
  );
  const usageLines: UsageLine[] = lines.rows.map((r) => ({
    opnameId: r.opname_id,
    opnameNumber: r.opname_number,
    locationId: r.location_id,
    itemId: r.item_id,
    itemName: r.item_name,
    unit: r.unit,
    countedOn: r.counted_on,
    periodStart: r.period_start,
    theoretical: Number(r.theoretical),
    diff: Number(r.diff),
    avgCost: Number(r.avg_cost),
  }));

  // Period level: one row per adjusted count.
  const pparams: unknown[] = [ctx.from, ctx.to];
  const pscope = locFilter(ctx, 'o.location_id', pparams);
  const periods = await ctx.client.query<{
    opname_id: string;
    opname_number: string;
    location_id: string;
    counted_on: string;
    period_start: string | null;
    variance: string;
    closing_value: string;
    sales: string;
  }>(
    `WITH op AS (
       SELECT o.id, o.opname_number, o.location_id,
              COALESCE(o.submitted_at, o.started_at) AS end_at,
              (SELECT MAX(COALESCE(o2.submitted_at, o2.started_at))
                 FROM stock_opname o2
                WHERE o2.location_id = o.location_id AND o2.status = 'adjusted'
                  AND COALESCE(o2.submitted_at, o2.started_at) < COALESCE(o.submitted_at, o.started_at)) AS start_at
         FROM stock_opname o
        WHERE o.status = 'adjusted'
          AND ${witaDateRange('COALESCE(o.submitted_at, o.started_at)', 1, 2)}
          ${pscope}
     )
     SELECT op.id AS opname_id, op.opname_number, op.location_id,
            (op.end_at AT TIME ZONE 'Asia/Makassar')::date::text AS counted_on,
            (op.start_at AT TIME ZONE 'Asia/Makassar')::date::text AS period_start,
            (SELECT COALESCE(SUM(a.qty_delta * a.unit_cost), 0)
               FROM stock_adjustments a WHERE a.opname_id = op.id)::text AS variance,
            (SELECT COALESCE(SUM(l.counted_qty * i.avg_cost), 0)
               FROM stock_opname_lines l JOIN items i ON i.id = l.item_id
              WHERE l.opname_id = op.id)::text AS closing_value,
            (SELECT COALESCE(SUM(s.total), 0)
               FROM sales s
              WHERE s.location_id = op.location_id AND s.status = 'completed'
                AND s.occurred_at <= op.end_at
                AND (op.start_at IS NULL OR s.occurred_at > op.start_at))::text AS sales
       FROM op`,
    pparams,
  );
  const periodRows: PeriodVariance[] = periods.rows.map((r) => ({
    opnameId: r.opname_id,
    opnameNumber: r.opname_number,
    locationId: r.location_id,
    countedOn: r.counted_on,
    periodStart: r.period_start,
    variance: Number(r.variance),
    closingStockValue: Number(r.closing_value),
    sales: Number(r.sales),
  }));

  return {
    items: [...findPeriodVariances(periodRows, th), ...findUsageVariances(usageLines, th)],
  };
}
