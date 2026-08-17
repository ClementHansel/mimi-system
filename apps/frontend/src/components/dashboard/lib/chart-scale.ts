/**
 * The ONE place a dashboard chart is allowed to touch `Number()` on a
 * Money/Qty wire string. This never feeds a displayed number — `TrendPanel`/
 * `OutletDrilldownContent` always render the actual figure via
 * `formatMoney`/`formatQty`/`formatNumber` (string-safe, CONTRACTS §0). This
 * function only answers "how tall should this bar be relative to the
 * others," a purely visual ratio where float imprecision is invisible (a
 * business running on IDR revenue never has a figure anywhere near
 * `Number.MAX_SAFE_INTEGER`, so there is no precision loss to begin with —
 * the prohibition on `parseFloat` is about protecting the DISPLAYED value,
 * which this function never produces).
 */
export function ratiosForChart(values: string[]): number[] {
  const nums = values.map((v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, n) : 0;
  });
  const max = Math.max(0, ...nums);
  if (max === 0) return nums.map(() => 0);
  return nums.map((n) => n / max);
}
