import { daysBetween, fixed, locFilter } from '../anomaly-util';
import type { DetectorContext, DetectorOutput, RawAnomalyItem } from '../anomaly.types';

/**
 * Accounts that legitimately run on either side and so must not be judged on
 * their sign. 5090 "Penyesuaian Nilai Persediaan" is an expense, but a stock
 * count that finds MORE than the books credit it — a gain is not an error.
 */
export const SIGN_EXEMPT_ACCOUNT_CODES: readonly string[] = ['5090'];

/** Account types whose normal balance is a debit; the rest are credit-normal. */
const DEBIT_NORMAL = new Set(['asset', 'expense']);

export interface AccountBalance {
  accountId: string;
  code: string;
  name: string;
  type: string;
  locationId: string | null;
  debit: number;
  credit: number;
}

/** Pure sign test: how far the balance sits on the wrong side, or 0 when it does not. */
export function wrongSideAmount(type: string, debit: number, credit: number): number {
  const wrong = DEBIT_NORMAL.has(type) ? credit - debit : debit - credit;
  return wrong > 0 ? wrong : 0;
}

export interface CashAccount {
  locationId: string;
  balance: number;
  lastCredit: string | null;
  firstDebit: string | null;
  lastDebit: string | null;
}

/**
 * Cash that only ever goes up: an outlet's Kas Outlet with debits and no
 * credit for more than `days` days. Measured from the last credit (the last
 * deposit, or any other outflow) — or from the first debit when there has
 * never been one — to the last debit on or before the window end. An outlet
 * that stopped trading is not "growing", so the end is its last debit, not
 * the window end.
 */
export function cashGrowthDays(c: CashAccount): number | null {
  if (c.lastDebit === null || c.balance <= 0) return null;
  if (c.lastCredit !== null && c.lastCredit >= c.lastDebit) return null;
  const since = c.lastCredit ?? c.firstDebit;
  if (since === null) return null;
  return daysBetween(since, c.lastDebit);
}

/**
 * `gl_sanity`, two checks over POSTED journal lines up to the window end:
 *
 *  1. accounts sitting on the wrong side of zero (asset/expense in credit,
 *     liability/equity/revenue in debit) by more than `minAbsBalance`, per
 *     account and outlet;
 *  2. outlet cash (1000 Kas Outlet) that has grown for more than
 *     `cashGrowthDays` days with no credit at all — takings never banked.
 *
 * The line filter goes INSIDE the parenthesised join:
 *
 *     LEFT JOIN (journal_lines jl JOIN journal_entries je ON ... status = 'posted' ...) ON ...
 *
 * so it decides which lines are summed. Put the status/date test on a plain
 * LEFT JOIN to `journal_entries` and SUM still runs over every line whether or
 * not its entry matched — the bug the trial balance and balance sheet shipped
 * with, where every period returned all-time totals.
 *
 * The outlet of a line is `COALESCE(jl.location_id, je.location_id)`; a line
 * with neither is company-level, which only a caller with no location scope
 * can see (a scoped `= ANY(...)` never matches NULL).
 */
export async function detectGlSanity(ctx: DetectorContext): Promise<DetectorOutput> {
  const th = ctx.th.gl_sanity;
  const month = ctx.to.slice(0, 7);
  const items: RawAnomalyItem[] = [];

  // 1) wrong-sign balances
  const params: unknown[] = [ctx.to, SIGN_EXEMPT_ACCOUNT_CODES];
  const scope = locFilter(ctx, 'COALESCE(jl.location_id, je.location_id)', params);
  const bal = await ctx.client.query<{
    id: string;
    code: string;
    name: string;
    type: string;
    location_id: string | null;
    debit: string;
    credit: string;
  }>(
    `SELECT coa.id, coa.code, coa.name, coa.type,
            COALESCE(jl.location_id, je.location_id) AS location_id,
            COALESCE(SUM(jl.debit), 0)::text AS debit,
            COALESCE(SUM(jl.credit), 0)::text AS credit
       FROM chart_of_accounts coa
       LEFT JOIN (journal_lines jl
                  JOIN journal_entries je
                    ON je.id = jl.entry_id AND je.status = 'posted' AND je.entry_date <= $1::date)
              ON jl.account_id = coa.id
      WHERE coa.is_postable = true
        AND NOT (coa.code = ANY($2::text[]))
        ${scope}
      GROUP BY coa.id, coa.code, coa.name, coa.type, COALESCE(jl.location_id, je.location_id)
     HAVING COALESCE(SUM(jl.debit), 0) <> 0 OR COALESCE(SUM(jl.credit), 0) <> 0`,
    params,
  );
  for (const r of bal.rows) {
    const debit = Number(r.debit);
    const credit = Number(r.credit);
    const wrong = wrongSideAmount(r.type, debit, credit);
    if (wrong <= th.minAbsBalance) continue;
    const normalDebit = DEBIT_NORMAL.has(r.type);
    items.push({
      fingerprint: `gl_sign:${r.code}:${r.location_id ?? 'company'}:${month}`,
      severity: wrong > th.minAbsBalance * 10 ? 'high' : 'medium',
      locationId: r.location_id,
      date: ctx.to,
      period: null,
      metric: 'balance',
      unit: 'idr',
      // Expected: a balance on the normal side (zero or more).
      expected: fixed(0),
      actual: fixed(normalDebit ? debit - credit : credit - debit),
      ratio: null,
      detail: {
        account: `${r.code} ${r.name}`,
        accountType: r.type,
        normalSide: normalDebit ? 'debit' : 'credit',
      },
      ref: {
        ...(r.location_id ? { locationId: r.location_id } : {}),
        accountId: r.id,
        date: ctx.to,
      },
      link: null,
    });
  }

  // 2) outlet cash that never leaves
  const cparams: unknown[] = [ctx.to];
  const cscope = locFilter(ctx, 'COALESCE(jl.location_id, je.location_id)', cparams);
  const cash = await ctx.client.query<{
    id: string;
    location_id: string;
    balance: string;
    last_credit: string | null;
    first_debit: string | null;
    last_debit: string | null;
  }>(
    `SELECT coa.id, COALESCE(jl.location_id, je.location_id) AS location_id,
            (COALESCE(SUM(jl.debit), 0) - COALESCE(SUM(jl.credit), 0))::text AS balance,
            MAX(je.entry_date) FILTER (WHERE jl.credit > 0)::text AS last_credit,
            MIN(je.entry_date) FILTER (WHERE jl.debit > 0)::text AS first_debit,
            MAX(je.entry_date) FILTER (WHERE jl.debit > 0)::text AS last_debit
       FROM chart_of_accounts coa
       LEFT JOIN (journal_lines jl
                  JOIN journal_entries je
                    ON je.id = jl.entry_id AND je.status = 'posted' AND je.entry_date <= $1::date)
              ON jl.account_id = coa.id
      WHERE coa.code = '1000'
        AND COALESCE(jl.location_id, je.location_id) IS NOT NULL
        ${cscope}
      GROUP BY coa.id, COALESCE(jl.location_id, je.location_id)`,
    cparams,
  );
  for (const r of cash.rows) {
    const c: CashAccount = {
      locationId: r.location_id,
      balance: Number(r.balance),
      lastCredit: r.last_credit,
      firstDebit: r.first_debit,
      lastDebit: r.last_debit,
    };
    const days = cashGrowthDays(c);
    if (days === null || days <= th.cashGrowthDays) continue;
    items.push({
      // Keyed on the last credit, so it clears the moment any money leaves the
      // till and a LATER streak is a new finding.
      fingerprint: `cash_growth:${r.location_id}:${c.lastCredit ?? 'never'}`,
      severity: days > th.cashGrowthDays * 4 ? 'high' : 'medium',
      locationId: r.location_id,
      date: c.lastDebit,
      period: { from: c.lastCredit ?? c.firstDebit, to: c.lastDebit },
      metric: 'cash_growth_days',
      unit: 'days',
      expected: String(th.cashGrowthDays),
      actual: String(days),
      ratio: Number((days / th.cashGrowthDays).toFixed(2)),
      detail: { balance: fixed(c.balance), neverCredited: c.lastCredit === null ? 1 : 0 },
      ref: { locationId: r.location_id, accountId: r.id, date: ctx.to },
      link: null,
    });
  }

  return { items };
}
