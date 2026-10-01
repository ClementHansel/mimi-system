import { fixed, locFilter, severityByExcess } from '../anomaly-util';
import type { DetectorContext, DetectorOutput, RawAnomalyItem } from '../anomaly.types';

/**
 * `payroll_outlier` — for payroll runs whose period overlaps the window (a run
 * that is not cancelled), per employee:
 *
 *   - net pay below `netBelowBasePct` of their `base_salary` line, or
 *   - total deductions above `deductionsAboveGrossPct` of gross earnings.
 *
 * `employer_cost` components (statutory employer BPJS) are neither earnings
 * nor deductions from the employee's side and are left out of both. An
 * employee with no `base_salary` line is only tested on the deductions rule —
 * there is nothing to compare net against.
 *
 * Scoped by the employee's home location (`employees.location_id`): payroll
 * lines carry no location of their own.
 */
export async function detectPayrollOutliers(ctx: DetectorContext): Promise<DetectorOutput> {
  const th = ctx.th.payroll_outlier;
  const params: unknown[] = [ctx.from, ctx.to, th.netBelowBasePct, th.deductionsAboveGrossPct];
  const scope = locFilter(ctx, 'e.location_id', params);
  const res = await ctx.client.query<{
    run_id: string;
    run_number: string;
    period_code: string;
    employee_id: string;
    employee_name: string;
    location_id: string;
    gross: string;
    ded: string;
    base: string;
  }>(
    `WITH agg AS (
       SELECT r.id AS run_id, r.run_number, pp.period_code,
              e.id AS employee_id, e.name AS employee_name, e.location_id,
              COALESCE(SUM(pl.amount) FILTER (WHERE sc.type = 'earning'), 0) AS gross,
              COALESCE(SUM(pl.amount) FILTER (WHERE sc.type = 'deduction'), 0) AS ded,
              COALESCE(SUM(pl.amount) FILTER (WHERE sc.code = 'base_salary'), 0) AS base
         FROM payroll_runs r
         JOIN payroll_periods pp ON pp.id = r.period_id
         JOIN payroll_lines pl ON pl.run_id = r.id
         JOIN salary_components sc ON sc.id = pl.component_id
         JOIN employees e ON e.id = pl.employee_id
        WHERE r.status <> 'cancelled'
          AND pp.start_date <= $2::date AND pp.end_date >= $1::date
          ${scope}
        GROUP BY r.id, r.run_number, pp.period_code, e.id, e.name, e.location_id
     )
     SELECT run_id, run_number, period_code, employee_id, employee_name, location_id,
            gross::text, ded::text, base::text
       FROM agg
      WHERE (base > 0 AND (gross - ded) < base * $3::numeric / 100)
         OR (gross > 0 AND ded > gross * $4::numeric / 100)
      ORDER BY (gross - ded) / NULLIF(base, 0) NULLS LAST`,
    params,
  );
  const items: RawAnomalyItem[] = [];
  for (const r of res.rows) {
    const gross = Number(r.gross);
    const ded = Number(r.ded);
    const base = Number(r.base);
    const net = gross - ded;
    const netLow = base > 0 && net < (base * th.netBelowBasePct) / 100;
    const dedHigh = gross > 0 && ded > (gross * th.deductionsAboveGrossPct) / 100;
    // Net-vs-base is the headline when it fires; deductions-vs-gross otherwise.
    const excess = netLow
      ? th.netBelowBasePct / Math.max((net / base) * 100, 0.01)
      : ((ded / gross) * 100) / th.deductionsAboveGrossPct;
    items.push({
      fingerprint: `payroll_outlier:${r.run_id}:${r.employee_id}`,
      severity: net <= 0 ? 'high' : severityByExcess(excess),
      locationId: r.location_id,
      date: null,
      period: { from: null, to: null },
      metric: netLow ? 'net_pay' : 'deductions',
      unit: 'idr',
      expected: netLow ? fixed(base) : fixed((gross * th.deductionsAboveGrossPct) / 100),
      actual: netLow ? fixed(net) : fixed(ded),
      ratio: netLow ? Number((net / base).toFixed(3)) : Number((ded / gross).toFixed(3)),
      detail: {
        employee: r.employee_name,
        run: r.run_number,
        periodCode: r.period_code,
        gross: fixed(gross),
        deductions: fixed(ded),
        net: fixed(net),
        base: fixed(base),
        netLow: netLow ? 1 : 0,
        deductionsHigh: dedHigh ? 1 : 0,
      },
      ref: { locationId: r.location_id, runId: r.run_id, employeeId: r.employee_id },
      link: null,
    });
  }
  return { items };
}
