import { Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { addMoney, ERR_NOT_FOUND, subMoney, ZERO_MONEY, type Money } from '@mimi/shared';

interface TrialBalanceLine {
  accountCode: string;
  accountName: string;
  type: string;
  debit: Money;
  credit: Money;
}
interface PLLine {
  accountCode: string;
  name: string;
  amount: Money;
}

/**
 * M17 reports (CONTRACTS.md §4.17): trial balance, P&L, balance sheet,
 * stock value. All read `journal_lines`/`chart_of_accounts` directly —
 * derived reporting, no writes, so no idempotency/balance concerns beyond
 * what `JournalService`'s writers already guaranteed on the way in.
 */
@Injectable()
export class ReportsService {
  async trialBalance(
    client: PoolClient,
    periodCode: string,
  ): Promise<{
    rows: TrialBalanceLine[];
    totalDebit: Money;
    totalCredit: Money;
    balanced: boolean;
  }> {
    const period = await client.query<{ id: string }>(
      `SELECT id FROM fiscal_periods WHERE period_code = $1`,
      [periodCode],
    );
    if (!period.rows[0])
      throw new NotFoundException({
        code: ERR_NOT_FOUND,
        message: `Fiscal period '${periodCode}' not found`,
      });

    const res = await client.query<{
      code: string;
      name: string;
      type: string;
      debit: Money;
      credit: Money;
    }>(
      `SELECT coa.code, coa.name, coa.type,
              COALESCE(SUM(jl.debit), 0)::text AS debit,
              COALESCE(SUM(jl.credit), 0)::text AS credit
         FROM chart_of_accounts coa
         LEFT JOIN journal_lines jl ON jl.account_id = coa.id
         LEFT JOIN journal_entries je ON je.id = jl.entry_id AND je.fiscal_period_id = $1 AND je.status = 'posted'
        WHERE coa.is_postable = true
        GROUP BY coa.code, coa.name, coa.type, coa.id
       HAVING COALESCE(SUM(jl.debit), 0) <> 0 OR COALESCE(SUM(jl.credit), 0) <> 0
        ORDER BY coa.code`,
      [period.rows[0]!.id],
    );

    let totalDebit = ZERO_MONEY;
    let totalCredit = ZERO_MONEY;
    const rows: TrialBalanceLine[] = res.rows.map((r) => {
      totalDebit = addMoney(totalDebit, r.debit);
      totalCredit = addMoney(totalCredit, r.credit);
      return {
        accountCode: r.code,
        accountName: r.name,
        type: r.type,
        debit: r.debit,
        credit: r.credit,
      };
    });

    return { rows, totalDebit, totalCredit, balanced: totalDebit === totalCredit };
  }

  async profitLoss(
    client: PoolClient,
    from: string,
    to: string,
    locationId?: string,
  ): Promise<{
    revenue: PLLine[];
    expenses: PLLine[];
    totalRevenue: Money;
    totalExpense: Money;
    netProfit: Money;
  }> {
    const args: unknown[] = [from, to];
    let locFilter = '';
    if (locationId) {
      args.push(locationId);
      locFilter = `AND je.location_id = $3`;
    }

    const rows = await client.query<{ code: string; name: string; type: string; amount: Money }>(
      `SELECT coa.code, coa.name, coa.type,
              CASE WHEN coa.type = 'revenue' THEN COALESCE(SUM(jl.credit - jl.debit), 0)
                   ELSE COALESCE(SUM(jl.debit - jl.credit), 0) END::text AS amount
         FROM chart_of_accounts coa
         JOIN journal_lines jl ON jl.account_id = coa.id
         JOIN journal_entries je ON je.id = jl.entry_id AND je.status = 'posted' AND je.entry_date BETWEEN $1 AND $2 ${locFilter}
        WHERE coa.type IN ('revenue','expense')
        GROUP BY coa.code, coa.name, coa.type
       HAVING COALESCE(SUM(jl.debit), 0) <> 0 OR COALESCE(SUM(jl.credit), 0) <> 0
        ORDER BY coa.code`,
      args,
    );

    const revenue: PLLine[] = [];
    const expenses: PLLine[] = [];
    let totalRevenue = ZERO_MONEY;
    let totalExpense = ZERO_MONEY;
    for (const r of rows.rows) {
      if (r.type === 'revenue') {
        revenue.push({ accountCode: r.code, name: r.name, amount: r.amount });
        totalRevenue = addMoney(totalRevenue, r.amount);
      } else {
        expenses.push({ accountCode: r.code, name: r.name, amount: r.amount });
        totalExpense = addMoney(totalExpense, r.amount);
      }
    }
    return {
      revenue,
      expenses,
      totalRevenue,
      totalExpense,
      netProfit: subMoney(totalRevenue, totalExpense),
    };
  }

  async balanceSheet(
    client: PoolClient,
    asOf: string,
  ): Promise<{ assets: PLLine[]; liabilities: PLLine[]; equity: PLLine[]; balanced: boolean }> {
    const res = await client.query<{ code: string; name: string; type: string; balance: Money }>(
      `SELECT coa.code, coa.name, coa.type,
              CASE WHEN coa.normal_balance = 'debit' THEN COALESCE(SUM(jl.debit - jl.credit), 0)
                   ELSE COALESCE(SUM(jl.credit - jl.debit), 0) END::text AS balance
         FROM chart_of_accounts coa
         LEFT JOIN journal_lines jl ON jl.account_id = coa.id
         LEFT JOIN journal_entries je ON je.id = jl.entry_id AND je.status = 'posted' AND je.entry_date <= $1
        WHERE coa.type IN ('asset','liability','equity') AND coa.is_postable = true
        GROUP BY coa.code, coa.name, coa.type
       HAVING COALESCE(SUM(jl.debit), 0) <> 0 OR COALESCE(SUM(jl.credit), 0) <> 0
        ORDER BY coa.code`,
      [asOf],
    );

    const assets: PLLine[] = [];
    const liabilities: PLLine[] = [];
    const equity: PLLine[] = [];
    let totalAssets = ZERO_MONEY;
    let totalLiabEquity = ZERO_MONEY;
    for (const r of res.rows) {
      const line = { accountCode: r.code, name: r.name, amount: r.balance };
      if (r.type === 'asset') {
        assets.push(line);
        totalAssets = addMoney(totalAssets, r.balance);
      } else if (r.type === 'liability') {
        liabilities.push(line);
        totalLiabEquity = addMoney(totalLiabEquity, r.balance);
      } else {
        equity.push(line);
        totalLiabEquity = addMoney(totalLiabEquity, r.balance);
      }
    }
    return { assets, liabilities, equity, balanced: totalAssets === totalLiabEquity };
  }

  /** JGUD-07: "primarily a report" per Appendix A-8 — current `stock_balances.qty_on_hand × items.avg_cost`, grouped by location + category, not derived from the GL (the GL's 1100/1110 balances are the accounting-value cross-check, this is the operational inventory valuation FR-DASH-01/JGUD-07 actually wants). */
  async stockValue(
    client: PoolClient,
    locationId?: string,
  ): Promise<
    {
      locationId: string;
      locationName: string;
      value: Money;
      byCategory: { categoryName: string; value: Money }[];
    }[]
  > {
    const args: unknown[] = [];
    let where = '';
    if (locationId) {
      args.push(locationId);
      where = 'WHERE sb.location_id = $1';
    }

    const res = await client.query<{
      location_id: string;
      location_name: string;
      category_name: string;
      value: Money;
    }>(
      `SELECT sb.location_id, l.name AS location_name, ic.name AS category_name,
              COALESCE(SUM(sb.qty_on_hand * i.avg_cost), 0)::text AS value
         FROM stock_balances sb
         JOIN locations l ON l.id = sb.location_id
         JOIN items i ON i.id = sb.item_id
         JOIN item_categories ic ON ic.id = i.category_id
         ${where}
        GROUP BY sb.location_id, l.name, ic.name
        ORDER BY l.name, ic.name`,
      args,
    );

    const byLocation = new Map<
      string,
      {
        locationId: string;
        locationName: string;
        value: Money;
        byCategory: { categoryName: string; value: Money }[];
      }
    >();
    for (const r of res.rows) {
      let entry = byLocation.get(r.location_id);
      if (!entry) {
        entry = {
          locationId: r.location_id,
          locationName: r.location_name,
          value: ZERO_MONEY,
          byCategory: [],
        };
        byLocation.set(r.location_id, entry);
      }
      entry.value = addMoney(entry.value, r.value);
      entry.byCategory.push({ categoryName: r.category_name, value: r.value });
    }
    return [...byLocation.values()];
  }
}
