import { witaDateRange } from '../../../../kernel/time/wita-range.sql';
import { fixed, locFilter, severityByExcess } from '../anomaly-util';
import type { DetectorContext, DetectorOutput, RawAnomalyItem } from '../anomaly.types';

/** `payment_verifications.ref_type` values that are money coming in for a sale. */
export const SETTLEMENT_REF_TYPES = ['sale_payment', 'online_order'] as const;

/**
 * The WITA calendar date a settlement belongs to: the day of the sale it
 * settles when it points at one (`ref_type = 'sale_payment'`), else the day
 * it was paid / verified / raised. The outlet likewise: the sale's, else the
 * verification's own `location_id`. A settlement with neither (a platform
 * payout raised with no outlet) cannot be attributed to an outlet-day and is
 * not counted against one.
 */
const SETTLEMENT_ROWS_SQL = `
  SELECT COALESCE(s2.location_id, pv.location_id) AS location_id,
         (COALESCE(s2.occurred_at, pv.paid_at, pv.verified_at, pv.created_at)
            AT TIME ZONE 'Asia/Makassar')::date AS day,
         pv.amount
    FROM payment_verifications pv
    LEFT JOIN sale_payments sp2 ON pv.ref_type = 'sale_payment' AND sp2.id = pv.ref_id
    LEFT JOIN sales s2 ON s2.id = sp2.sale_id
   WHERE pv.ref_type = ANY($3::text[])
     AND pv.status IN ('verified', 'paid')`;

/**
 * `settlement_gap` — per outlet-day, card/transfer takings (`sale_payments`
 * with method qris or bank_transfer on completed sales) against the
 * settlements recorded in `payment_verifications` for sale payments and
 * online orders.
 *
 * IF NO SETTLEMENT EXISTS AT ALL in the window — the case for every outlet
 * until somebody starts recording payouts — the detector says so once
 * (`notice = 'no_settlement_recorded'`) and reports no findings. Flagging
 * every outlet-day for a ledger that is simply not being kept would bury the
 * panel and teach people to ignore it.
 *
 * Only a SHORTFALL is flagged (takings exceeding settlements by at least
 * `minGapAmount` and `gapPct`): a settlement larger than the day's takings is
 * usually an earlier day's money arriving, not a loss.
 */
export async function detectSettlementGap(ctx: DetectorContext): Promise<DetectorOutput> {
  const th = ctx.th.settlement_gap;

  const sparams: unknown[] = [ctx.from, ctx.to, SETTLEMENT_REF_TYPES];
  const sscope = locFilter(ctx, 'x.location_id', sparams);
  const settled = await ctx.client.query<{ location_id: string; d: string; amt: string }>(
    `SELECT x.location_id, x.day::text AS d, SUM(x.amount)::text AS amt
       FROM (${SETTLEMENT_ROWS_SQL}) x
      WHERE x.location_id IS NOT NULL
        AND x.day BETWEEN $1::date AND $2::date
        ${sscope}
      GROUP BY x.location_id, x.day`,
    sparams,
  );
  if (settled.rows.length === 0) return { items: [], notice: 'no_settlement_recorded' };
  const settledBy = new Map(settled.rows.map((r) => [`${r.location_id}:${r.d}`, Number(r.amt)]));

  const params: unknown[] = [ctx.from, ctx.to, th.minGapAmount];
  const scope = locFilter(ctx, 's.location_id', params);
  const takings = await ctx.client.query<{
    location_id: string;
    d: string;
    qris: string;
    transfer: string;
  }>(
    `SELECT s.location_id,
            (s.occurred_at AT TIME ZONE 'Asia/Makassar')::date::text AS d,
            COALESCE(SUM(sp.amount) FILTER (WHERE sp.method = 'qris'), 0)::text AS qris,
            COALESCE(SUM(sp.amount) FILTER (WHERE sp.method = 'bank_transfer'), 0)::text AS transfer
       FROM sales s
       JOIN sale_payments sp ON sp.sale_id = s.id
      WHERE s.status = 'completed'
        AND sp.method IN ('qris', 'bank_transfer')
        AND ${witaDateRange('s.occurred_at', 1, 2)}
        ${scope}
      GROUP BY s.location_id, (s.occurred_at AT TIME ZONE 'Asia/Makassar')::date
     HAVING SUM(sp.amount) >= $3::numeric`,
    params,
  );

  const items: RawAnomalyItem[] = [];
  for (const r of takings.rows) {
    const qris = Number(r.qris);
    const transfer = Number(r.transfer);
    const noncash = qris + transfer;
    const settledAmt = settledBy.get(`${r.location_id}:${r.d}`) ?? 0;
    const gap = noncash - settledAmt;
    const gapPct = (gap / noncash) * 100;
    if (gap < th.minGapAmount || gapPct <= th.gapPct) continue;
    items.push({
      fingerprint: `settlement_gap:${r.location_id}:${r.d}`,
      severity: severityByExcess(gapPct / th.gapPct),
      locationId: r.location_id,
      date: r.d,
      period: null,
      metric: 'settlement',
      unit: 'idr',
      expected: fixed(noncash),
      actual: fixed(settledAmt),
      ratio: Number((settledAmt / noncash).toFixed(3)),
      detail: {
        qris: fixed(qris),
        transfer: fixed(transfer),
        gap: fixed(gap),
        gapPct: Number(gapPct.toFixed(1)),
      },
      ref: { locationId: r.location_id, date: r.d },
      link: null,
    });
  }
  return { items: items.sort((a, b) => Number(b.detail.gap) - Number(a.detail.gap)) };
}
