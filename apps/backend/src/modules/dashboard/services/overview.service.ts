import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { divMoney, subMoney, ZERO_MONEY, type Money } from '@mimi/shared';
import type { LocationScope } from '../../../common/scope/scope.service';
import { scopeClause } from '../scope.util';

export interface OverviewResponse {
  revenue: Money;
  revenueOnline: Money;
  profitEstimate: Money;
  txCount: number;
  avgTicket: Money;
  activeOutlets: number;
  vs: { revenuePct: string; txPct: string };
}

interface PeriodAgg {
  revenue: Money;
  revenueOnline: Money;
  txCount: number;
  activeOutlets: number;
}

/**
 * FR-DASH-01 — the top-line owner/manager tiles. Reads `mv_sales_daily`
 * (grain: location x date x platform, `platform IS NULL` for POS rows —
 * migration 100). `sales_date`/`from`/`to` are already WITA calendar dates
 * (the matview computed `sales_date` via `AT TIME ZONE 'Asia/Makassar'` at
 * refresh time), so a plain `BETWEEN` on the date column is correct — no
 * further wita conversion needed here.
 *
 * `profitEstimate`: revenue minus an ESTIMATED COGS, walked from POS
 * `sale_lines` through each product's active `recipes`/`recipe_lines` at
 * `items.avg_cost` (the same ingredient-cost snapshot `recipe-usage.util.ts`
 * uses for real usage postings). Online-order lines are NOT included in the
 * COGS estimate (`online_orders.items` is an optional, unvalidated JSONB
 * blob with no FK to `products`/`recipes` — CONTRACTS.md never asks for
 * recipe explosion over it) and a product with no unit-conversion path from
 * its recipe line's unit to the ingredient's base unit is skipped, exactly
 * like `recipe-usage.util.ts`'s own honest "estimate" framing. This is a
 * deliberate simplification flagged in the ticket report, not a guess at an
 * undocumented formula — CONTRACTS.md §4.18 specifies the field name and
 * type only.
 */
@Injectable()
export class OverviewService {
  async getOverview(
    client: PoolClient,
    locationScope: LocationScope,
    from: string,
    to: string,
  ): Promise<OverviewResponse> {
    const current = await this.periodAgg(client, locationScope, from, to);
    const cogs = await this.estimateCogs(client, locationScope, from, to);
    const profitEstimate = subMoney(current.revenue, cogs);

    const lengthDays = daysBetweenInclusive(from, to);
    const prevTo = addDays(from, -1);
    const prevFrom = addDays(prevTo, -(lengthDays - 1));
    const previous = await this.periodAgg(client, locationScope, prevFrom, prevTo);

    const avgTicket = current.txCount > 0 ? divMoney(current.revenue, `${current.txCount}.00`) : ZERO_MONEY;

    return {
      revenue: current.revenue,
      revenueOnline: current.revenueOnline,
      profitEstimate,
      txCount: current.txCount,
      avgTicket,
      activeOutlets: current.activeOutlets,
      vs: {
        revenuePct: pctChange(current.revenue, previous.revenue),
        txPct: pctChangeNumber(current.txCount, previous.txCount),
      },
    };
  }

  private async periodAgg(
    client: PoolClient,
    locationScope: LocationScope,
    from: string,
    to: string,
  ): Promise<PeriodAgg> {
    const params: unknown[] = [from, to];
    const scope = scopeClause(locationScope, 'location_id', params);

    const res = await client.query<{
      revenue: string;
      revenue_online: string;
      tx_count: string;
      active_outlets: string;
    }>(
      `SELECT
          COALESCE(SUM(gross), 0)::text AS revenue,
          COALESCE(SUM(gross) FILTER (WHERE platform IS NOT NULL), 0)::text AS revenue_online,
          COALESCE(SUM(tx_count), 0)::text AS tx_count,
          COUNT(DISTINCT location_id) FILTER (WHERE tx_count > 0)::text AS active_outlets
        FROM mv_sales_daily
       WHERE sales_date BETWEEN $1 AND $2 ${scope}`,
      params,
    );
    const row = res.rows[0]!;
    return {
      revenue: row.revenue as Money,
      revenueOnline: row.revenue_online as Money,
      txCount: parseInt(row.tx_count, 10),
      activeOutlets: parseInt(row.active_outlets, 10),
    };
  }

  private async estimateCogs(
    client: PoolClient,
    locationScope: LocationScope,
    from: string,
    to: string,
  ): Promise<Money> {
    const params: unknown[] = [from, to];
    const scope = scopeClause(locationScope, 's.location_id', params);

    // Only recipe lines whose unit already matches the ingredient's base unit are
    // costed here (see class header) — a per-conversion-path join is out of scope
    // for a report-level aggregate query; `recipe-usage.util.ts` does the full,
    // per-sale conversion for the REAL ledger posting.
    const res = await client.query<{ cogs: string }>(
      `SELECT ROUND(COALESCE(SUM(sl.qty * rl.qty * i.avg_cost), 0), 2)::text AS cogs
         FROM sales s
         JOIN sale_lines sl ON sl.sale_id = s.id
         JOIN recipes r ON r.product_id = sl.product_id AND r.is_active
         JOIN recipe_lines rl ON rl.recipe_id = r.id
         JOIN items i ON i.id = rl.item_id AND rl.unit_id = i.base_unit_id
        WHERE s.status = 'completed'
          AND (s.occurred_at AT TIME ZONE 'Asia/Makassar')::date BETWEEN $1 AND $2
          ${scope}`,
      params,
    );
    return (res.rows[0]?.cogs ?? ZERO_MONEY) as Money;
  }
}

function daysBetweenInclusive(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00.000Z`);
  const b = Date.parse(`${to}T00:00:00.000Z`);
  return Math.round((b - a) / 86_400_000) + 1;
}

function addDays(date: string, days: number): string {
  const d = new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/** Percentage change formatted to 2dp, using `Money`'s decimal-string values only for input — the OUTPUT here is a display percentage, not a ledger amount, so plain float math is acceptable (mirrors CONTRACTS.md §4.18 typing `vs.revenuePct` as a bare `string`, not `Money`). */
function pctChange(current: Money, previous: Money): string {
  return pctChangeNumber(Number(current), Number(previous));
}

function pctChangeNumber(current: number, previous: number): string {
  if (previous === 0) return current === 0 ? '0.00' : '100.00';
  return (((current - previous) / previous) * 100).toFixed(2);
}
