import { witaDateRange } from '../../../../kernel/time/wita-range.sql';
import { fixed, locFilter, severityByExcess } from '../anomaly-util';
import type { DetectorContext, DetectorOutput, RawAnomalyItem } from '../anomaly.types';

/**
 * The price a product SHOULD sell at on a given channel, as SQL — the same
 * rule as `priceForChannel` in the frontend's `pos/channel-pricing.ts` and
 * the POS catalog: walk-in is `price`; GoFood / ShopeeFood use their own
 * column and fall back to `price` when it is NULL ("never zero").
 *
 * Any other channel (a platform added after this was written) looks for a
 * `products.price_<channel>` column by name through `to_jsonb(p)` and falls
 * back to `price` when there is none — so a new platform with its own price
 * column is judged against it, and one without is judged against the walk-in
 * price, rather than every one of its lines being reported as a deviation.
 * The jsonb branch is only evaluated for such channels.
 *
 * `channel` is the SQL expression holding the sale's channel (`s.channel`);
 * `p` is the products alias in the calling query.
 */
export function expectedChannelPriceSql(channel = 's.channel'): string {
  return `CASE ${channel}
       WHEN 'walk_in' THEN p.price
       WHEN 'gofood' THEN COALESCE(p.price_gofood, p.price)
       WHEN 'shopeefood' THEN COALESCE(p.price_shopeefood, p.price)
       ELSE COALESCE(NULLIF(to_jsonb(p) ->> ('price_' || ${channel}), '')::numeric, p.price)
     END`;
}

export const EXPECTED_CHANNEL_PRICE_SQL = expectedChannelPriceSql('s.channel');

/** A line deviates when it sold for more than half a rupiah off the channel price. */
export const PRICE_TOLERANCE = 0.5;

/**
 * `price_deviation` — per outlet x product, the share of completed-sale lines
 * whose `unit_price` differs from the product's CURRENT price for that sale's
 * channel. Flagged when more than `sharePct` of at least `minLines` lines
 * deviate.
 *
 * "Current" is the point: a product repriced last week will show its older
 * lines as deviations until they age out of the window. That is the signal
 * the owner asked for (an outlet still selling at the old price, or at a
 * hand-typed one), and the drill-down lists each line so a legitimate
 * repricing is recognisable at a glance.
 *
 * SHAPE, FOR SPEED. Lines are first collapsed to (outlet, product, channel,
 * unit_price) with a count — a few thousand groups for a quarter of trading,
 * because most lines of a product share one price — and only THEN joined to
 * `products` to evaluate the expected price. Evaluating the channel CASE (with
 * its jsonb fallback) per line over 475k lines, several times each, cost 2.6s
 * on a 90-day window; per group it is noise.
 */
export async function detectPriceDeviation(ctx: DetectorContext): Promise<DetectorOutput> {
  const th = ctx.th.price_deviation;
  const params: unknown[] = [ctx.from, ctx.to, PRICE_TOLERANCE, th.sharePct, th.minLines];
  const scope = locFilter(ctx, 's.location_id', params);
  const res = await ctx.client.query<{
    location_id: string;
    product_id: string;
    name: string;
    n: number;
    dev: number;
    avg_actual: string;
    avg_expected: string;
  }>(
    `WITH g AS (
       SELECT s.location_id, sl.product_id, s.channel, sl.unit_price, COUNT(*) AS n
         FROM sales s
         JOIN sale_lines sl ON sl.sale_id = s.id
        WHERE s.status = 'completed'
          AND ${witaDateRange('s.occurred_at', 1, 2)}
          ${scope}
        GROUP BY s.location_id, sl.product_id, s.channel, sl.unit_price
     ), e AS (
       SELECT g.location_id, g.product_id, p.name, g.n, g.unit_price,
              ${expectedChannelPriceSql('g.channel')} AS expected
         FROM g
         JOIN products p ON p.id = g.product_id
     ), d AS (
       SELECT e.*, (ABS(e.unit_price - e.expected) > $3::numeric) AS off
         FROM e
     )
     SELECT location_id, product_id, name,
            SUM(n)::int AS n,
            COALESCE(SUM(n) FILTER (WHERE off), 0)::int AS dev,
            COALESCE(SUM(unit_price * n) FILTER (WHERE off) / NULLIF(SUM(n) FILTER (WHERE off), 0), 0)::text AS avg_actual,
            COALESCE(SUM(expected * n) FILTER (WHERE off) / NULLIF(SUM(n) FILTER (WHERE off), 0), 0)::text AS avg_expected
       FROM d
      GROUP BY location_id, product_id, name
     HAVING SUM(n) >= $5::int
        AND COALESCE(SUM(n) FILTER (WHERE off), 0) * 100.0 / SUM(n) > $4::numeric
      ORDER BY COALESCE(SUM(n) FILTER (WHERE off), 0) * 100.0 / SUM(n) DESC`,
    params,
  );
  const items: RawAnomalyItem[] = res.rows.map((r) => {
    const share = (r.dev * 100) / r.n;
    return {
      // No date: the finding is about a stretch, and "this outlet sells this
      // product off-price" is the same finding whichever week it is seen in —
      // the default window slides every day, so a fingerprint carrying the
      // window end would make a review vanish overnight. The calendar MONTH
      // of the window end is the identity instead: reviewed once for May,
      // and a fresh deviation in June is a new finding.
      fingerprint: `price_deviation:${r.location_id}:${r.product_id}:${ctx.to.slice(0, 7)}`,
      severity: severityByExcess(share / th.sharePct),
      locationId: r.location_id,
      date: null,
      period: { from: ctx.from, to: ctx.to },
      metric: 'unit_price',
      unit: 'idr',
      expected: fixed(Number(r.avg_expected)),
      actual: fixed(Number(r.avg_actual)),
      ratio: Number((share / 100).toFixed(3)),
      detail: { product: r.name, lines: r.n, deviating: r.dev, sharePct: Number(share.toFixed(1)) },
      ref: { locationId: r.location_id, productId: r.product_id },
      link: null,
    };
  });
  return { items };
}
