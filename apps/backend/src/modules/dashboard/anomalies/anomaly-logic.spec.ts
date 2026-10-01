import { describe, it, expect } from 'vitest';
import {
  THRESHOLD_FIELDS,
  defaultThresholds,
  mergeThresholds,
  validateThresholdInput,
} from './anomaly-thresholds';
import { addDays, daysBetween, eachDate, median } from './anomaly-util';
import { baselineFor, findSalesDayOutliers, type DayRevenue } from './detectors/sales-day-outlier';
import { findProductQtyOutliers, qtySpanStart } from './detectors/product-qty-outlier';
import { actualUsage, findPeriodVariances, findUsageVariances } from './detectors/usage-variance';
import { cashGrowthDays, wrongSideAmount } from './detectors/gl-sanity';

/** Pure logic of the Anomali detectors — no database. The SQL halves are covered by the live-DB specs. */
describe('anomaly thresholds', () => {
  it('defaults are the ones the brief specified', () => {
    const d = defaultThresholds();
    expect(d.sales_day_outlier).toMatchObject({ hi: 3, lo: 0.3, baselineDays: 28 });
    expect(d.product_qty_outlier).toMatchObject({ multiple: 5, minQty: 50 });
    expect(d.usage_variance).toMatchObject({ variancePct: 25, minValue: 500_000 });
    expect(d.price_deviation.sharePct).toBe(10);
    expect(d.payroll_outlier).toMatchObject({ netBelowBasePct: 25, deductionsAboveGrossPct: 50 });
    expect(d.gl_sanity.cashGrowthDays).toBe(7);
  });

  it('the migration seed and the in-code defaults cannot drift apart (every field has a default inside its own range)', () => {
    for (const f of THRESHOLD_FIELDS) {
      expect(f.default).toBeGreaterThanOrEqual(f.min);
      expect(f.default).toBeLessThanOrEqual(f.max);
    }
  });

  it('mergeThresholds takes good values, drops bad ones, and never throws', () => {
    const t = mergeThresholds({
      sales_day_outlier: { hi: 4, lo: 5 /* out of range */, baselineDays: 14.5 /* not an int */ },
      usage_variance: 'garbage',
      gl_sanity: null,
    });
    expect(t.sales_day_outlier.hi).toBe(4);
    expect(t.sales_day_outlier.lo).toBe(0.3);
    expect(t.sales_day_outlier.baselineDays).toBe(28);
    expect(t.usage_variance.variancePct).toBe(25);
    expect(mergeThresholds(undefined)).toEqual(defaultThresholds());
    expect(mergeThresholds([1, 2])).toEqual(defaultThresholds());
  });

  it('validateThresholdInput reports exactly the offending paths', () => {
    expect(validateThresholdInput({ sales_day_outlier: { hi: 5 } })).toEqual([]);
    expect(validateThresholdInput({ sales_day_outlier: { hi: 0 }, gl_sanity: { x: 1 } })).toEqual([
      'sales_day_outlier.hi',
      'gl_sanity.x',
    ]);
    expect(validateThresholdInput('nope')).toEqual(['thresholds']);
    expect(validateThresholdInput({ payroll_outlier: 3 })).toEqual(['payroll_outlier']);
  });
});

describe('date + stats helpers', () => {
  it('addDays / daysBetween / eachDate agree and ignore timezones', () => {
    expect(addDays('2099-03-01', -1)).toBe('2099-02-28');
    expect(addDays('2096-03-01', -1)).toBe('2096-02-29');
    expect(daysBetween('2099-06-01', '2099-06-21')).toBe(20);
    expect(eachDate('2099-06-01', '2099-06-03')).toEqual([
      '2099-06-01',
      '2099-06-02',
      '2099-06-03',
    ]);
  });

  it('median: odd, even, empty', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe('sales_day_outlier logic', () => {
  const th = defaultThresholds().sales_day_outlier;
  const run = (from: string, n: number, revenue: (i: number) => number, loc = 'A'): DayRevenue[] =>
    eachDate(from, addDays(from, n - 1)).map((date, i) => ({
      locationId: loc,
      date,
      revenue: revenue(i),
      txCount: 10,
    }));

  it('uses the median of the previous 28 days, so the day being judged cannot hide itself', () => {
    const rows = [
      ...run('2099-06-01', 20, () => 17_000_000),
      ...run('2099-06-21', 1, () => 507_000_000),
    ];
    const items = findSalesDayOutliers(rows, '2099-06-21', '2099-06-21', th);
    expect(items).toHaveLength(1);
    expect(items[0]!.ratio).toBeCloseTo(29.82, 1);
    expect(items[0]!.severity).toBe('high');
  });

  it('boundaries: exactly 3x and exactly 0.3x are NOT flagged, just past them are', () => {
    const base = run('2099-06-01', 10, () => 1_000_000);
    const at = (rev: number) =>
      findSalesDayOutliers(
        [...base, { locationId: 'A', date: '2099-06-11', revenue: rev, txCount: 1 }],
        '2099-06-11',
        '2099-06-11',
        th,
      );
    expect(at(3_000_000)).toHaveLength(0);
    expect(at(3_000_001)).toHaveLength(1);
    expect(at(300_000)).toHaveLength(0);
    expect(at(299_999)).toHaveLength(1);
  });

  it('falls back to the other days in the window when history is short, and gives up below 3 of them', () => {
    const win = run('2099-06-01', 6, (i) => (i === 5 ? 9_000_000 : 1_000_000));
    // The first day has no days before it, so the median of the 5 OTHER days in the window stands in.
    expect(baselineFor(win, '2099-06-01', '2099-06-01', '2099-06-06', th)).toBe(1_000_000);
    expect(findSalesDayOutliers(win, '2099-06-01', '2099-06-06', th)).toHaveLength(1);
    const tiny = run('2099-06-01', 3, () => 1_000_000);
    expect(baselineFor(tiny, '2099-06-03', '2099-06-01', '2099-06-03', th)).toBeNull();
  });

  it('judges each outlet against its own history', () => {
    const rows = [
      ...run('2099-06-01', 10, () => 1_000_000, 'A'),
      ...run('2099-06-01', 10, () => 20_000_000, 'B'),
      { locationId: 'A', date: '2099-06-11', revenue: 20_000_000, txCount: 1 },
      { locationId: 'B', date: '2099-06-11', revenue: 20_000_000, txCount: 1 },
    ];
    const items = findSalesDayOutliers(rows, '2099-06-11', '2099-06-11', th);
    expect(items.map((i) => i.locationId)).toEqual(['A']); // 20M is normal for B, 20x for A
  });
});

describe('product_qty_outlier logic', () => {
  const th = defaultThresholds().product_qty_outlier;
  const row = (date: string, qty: number, product = 'P') => ({
    locationId: 'A',
    productId: product,
    productName: product,
    date,
    qty,
  });

  it('widens a short window to 28 days so a one-day window has a baseline', () => {
    expect(qtySpanStart('2099-06-21', '2099-06-21')).toBe('2099-05-25');
    expect(qtySpanStart('2099-04-01', '2099-06-21')).toBe('2099-04-01');
  });

  it('zero-fills quiet days: a product that sells twice a month has a median of 0', () => {
    const rows = [row('2099-06-05', 2), row('2099-06-19', 3), row('2099-06-21', 1394)];
    const items = findProductQtyOutliers(rows, '2099-06-21', '2099-06-21', th);
    expect(items).toHaveLength(1);
    expect(items[0]!.expected).toBe('0.000');
    expect(items[0]!.ratio).toBeNull(); // infinite, not a made-up number
  });

  it('respects the absolute floor and the multiple', () => {
    const steady = eachDate('2099-05-25', '2099-06-20').map((d) => row(d, 100));
    expect(
      findProductQtyOutliers([...steady, row('2099-06-21', 120)], '2099-06-21', '2099-06-21', th),
    ).toHaveLength(0);
    expect(
      findProductQtyOutliers([...steady, row('2099-06-21', 500)], '2099-06-21', '2099-06-21', th),
    ).toHaveLength(0); // exactly 5x
    expect(
      findProductQtyOutliers([...steady, row('2099-06-21', 501)], '2099-06-21', '2099-06-21', th),
    ).toHaveLength(1);
    expect(
      findProductQtyOutliers([row('2099-06-21', 49)], '2099-06-21', '2099-06-21', th),
    ).toHaveLength(0);
  });
});

describe('usage_variance logic', () => {
  const th = defaultThresholds().usage_variance;
  const line = (theoretical: number, diff: number, avgCost = 100_000) => ({
    opnameId: 'o',
    opnameNumber: 'OPN/1',
    locationId: 'A',
    itemId: 'i',
    itemName: 'Teh',
    unit: 'kg',
    countedOn: '2099-06-10',
    periodStart: '2099-06-01',
    theoretical,
    diff,
    avgCost,
  });

  it('actual = theoretical - diff, clamped at zero', () => {
    expect(actualUsage(48, 47)).toBe(1); // counted 47 more than the books: only 1 was used
    expect(actualUsage(100, -10)).toBe(110); // 10 short: 10 more was used than the recipe says
    expect(actualUsage(5, 50)).toBe(0);
  });

  it('flags only above BOTH the percentage and the value floor', () => {
    expect(findUsageVariances([line(48, 47)], th)).toHaveLength(1); // 98%, Rp 4.7M
    expect(findUsageVariances([line(100, -10)], th)).toHaveLength(0); // 9%
    expect(findUsageVariances([line(100, 80, 10)], th)).toHaveLength(0); // 80% but Rp 800
    expect(findUsageVariances([line(100, -34)], th)).toHaveLength(1); // 134 vs 100: 25.4%, Rp 3.4M
    expect(findUsageVariances([line(100, -33)], th)).toHaveLength(0); // 133 vs 100: 24.8%
  });

  it('period variance: over the share of sales, or over the stock still held', () => {
    const p = (variance: number, sales: number, closing: number) => ({
      opnameId: 'o',
      opnameNumber: 'OPN/1',
      locationId: 'A',
      countedOn: '2099-06-10',
      periodStart: null,
      variance,
      sales,
      closingStockValue: closing,
    });
    expect(findPeriodVariances([p(-6_000_000, 10_000_000, 50_000_000)], th)).toHaveLength(1); // 60% of sales
    expect(findPeriodVariances([p(-1_000_000, 100_000_000, 50_000_000)], th)).toHaveLength(0); // 1%
    const over = findPeriodVariances([p(-1_000_000, 100_000_000, 400_000)], th);
    expect(over).toHaveLength(1); // under 5% of sales but bigger than the stock held
    expect(over[0]!.severity).toBe('high');
    expect(findPeriodVariances([p(-400_000, 1_000_000, 100)], th)).toHaveLength(0); // under the Rp 500k floor
  });
});

describe('gl_sanity logic', () => {
  it('wrongSideAmount: asset/expense in credit and liability/equity/revenue in debit', () => {
    expect(wrongSideAmount('asset', 0, 5)).toBe(5);
    expect(wrongSideAmount('expense', 1, 4)).toBe(3);
    expect(wrongSideAmount('liability', 9, 2)).toBe(7);
    expect(wrongSideAmount('revenue', 3, 0)).toBe(3);
    expect(wrongSideAmount('equity', 0, 3)).toBe(0);
    expect(wrongSideAmount('asset', 5, 5)).toBe(0);
  });

  it('cashGrowthDays counts from the last credit (or first debit) to the last debit, and not at all once money left', () => {
    const c = (o: Partial<Parameters<typeof cashGrowthDays>[0]>) => ({
      locationId: 'A',
      balance: 1,
      lastCredit: null,
      firstDebit: '2099-06-01',
      lastDebit: '2099-06-20',
      ...o,
    });
    expect(cashGrowthDays(c({}))).toBe(19);
    expect(cashGrowthDays(c({ lastCredit: '2099-06-18' }))).toBe(2);
    expect(cashGrowthDays(c({ lastCredit: '2099-06-20' }))).toBeNull(); // deposited on the last takings day
    expect(cashGrowthDays(c({ balance: 0 }))).toBeNull();
    expect(cashGrowthDays(c({ lastDebit: null, firstDebit: null }))).toBeNull();
  });
});
