import { scopeClause } from '../scope.util';
import type { DetectorContext } from './anomaly.types';

/** `YYYY-MM-DD` shifted by whole days — pure calendar arithmetic, no timezone involved. */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** Whole days from `a` to `b` (positive when `b` is later). */
export function daysBetween(a: string, b: string): number {
  return Math.round(
    (Date.parse(`${b}T00:00:00.000Z`) - Date.parse(`${a}T00:00:00.000Z`)) / 86_400_000,
  );
}

/** Every calendar date from `from` to `to`, inclusive. */
export function eachDate(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Median of a list (average of the two middles for an even count); `null` when empty. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** A number as a fixed-decimal string, for the `expected`/`actual` fields. */
export function fixed(n: number, dp = 2): string {
  return n.toFixed(dp);
}

/**
 * The location restriction every detector query applies: the caller's scope
 * (`scopeClause`, as every dashboard service does) and, when the panel is
 * filtered to one outlet, that outlet as well. Appends bind parameters to
 * `params` and returns a fragment to AND onto the WHERE clause.
 */
export function locFilter(ctx: DetectorContext, column: string, params: unknown[]): string {
  let sql = scopeClause(ctx.scope, column, params);
  if (ctx.locationId) {
    params.push(ctx.locationId);
    sql += ` AND ${column} = $${params.length}`;
  }
  return sql;
}

/** Severity from how far past its threshold a finding is: 2x the trigger is high, 1.0x-2x medium. */
export function severityByExcess(excess: number): 'high' | 'medium' | 'low' {
  if (excess >= 2) return 'high';
  if (excess >= 1.25) return 'medium';
  return 'low';
}
