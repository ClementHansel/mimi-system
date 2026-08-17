import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { ISODate } from '@mimi/shared';
import type { LocationScope } from '../../../common/scope/scope.service';
import { assertLocationInScope, scopeClause } from '../scope.util';

export interface TrendPoint {
  t: ISODate;
  value: string;
}

export type TrendMetric = 'revenue' | 'tx' | 'usage';
export type TrendGranularity = 'daily' | 'weekly';

/**
 * FR-DASH-01/03 sales trend — `revenue`/`tx` from `mv_sales_daily`, `usage`
 * from `mv_item_usage_daily` (summed across all items at scope, since the
 * endpoint takes no `itemId` param per CONTRACTS.md §4.18). `weekly`
 * truncates to the WITA ISO week start via Postgres `date_trunc('week', ...)`
 * — the matview's `sales_date`/`usage_date` columns are already WITA
 * calendar dates, so no additional timezone shift is needed at this step.
 */
@Injectable()
export class TrendService {
  async getTrend(
    client: PoolClient,
    locationScope: LocationScope,
    metric: TrendMetric,
    granularity: TrendGranularity,
    from: string,
    to: string,
    locationId: string | undefined,
  ): Promise<TrendPoint[]> {
    assertLocationInScope(locationScope, locationId);

    if (metric === 'usage') {
      return this.usageTrend(client, locationScope, granularity, from, to, locationId);
    }
    return this.salesTrend(client, locationScope, metric, granularity, from, to, locationId);
  }

  private async salesTrend(
    client: PoolClient,
    locationScope: LocationScope,
    metric: 'revenue' | 'tx',
    granularity: TrendGranularity,
    from: string,
    to: string,
    locationId: string | undefined,
  ): Promise<TrendPoint[]> {
    const bucket = granularity === 'weekly' ? `date_trunc('week', sales_date)::date` : 'sales_date';
    const valueExpr = metric === 'revenue' ? 'SUM(gross)' : 'SUM(tx_count)';

    const params: unknown[] = [from, to];
    let where = '';
    const scope = scopeClause(locationScope, 'location_id', params);
    if (locationId) {
      params.push(locationId);
      where = ` AND location_id = $${params.length}`;
    }

    const res = await client.query<{ t: string; value: string }>(
      `SELECT ${bucket} AS t, ${valueExpr}::text AS value
         FROM mv_sales_daily
        WHERE sales_date BETWEEN $1 AND $2 ${scope}${where}
        GROUP BY 1
        ORDER BY 1`,
      params,
    );
    return res.rows.map((r) => ({ t: r.t as ISODate, value: r.value }));
  }

  private async usageTrend(
    client: PoolClient,
    locationScope: LocationScope,
    granularity: TrendGranularity,
    from: string,
    to: string,
    locationId: string | undefined,
  ): Promise<TrendPoint[]> {
    const bucket = granularity === 'weekly' ? `date_trunc('week', usage_date)::date` : 'usage_date';

    const params: unknown[] = [from, to];
    let where = '';
    const scope = scopeClause(locationScope, 'location_id', params);
    if (locationId) {
      params.push(locationId);
      where = ` AND location_id = $${params.length}`;
    }

    const res = await client.query<{ t: string; value: string }>(
      `SELECT ${bucket} AS t, SUM(qty_used)::text AS value
         FROM mv_item_usage_daily
        WHERE usage_date BETWEEN $1 AND $2 ${scope}${where}
        GROUP BY 1
        ORDER BY 1`,
      params,
    );
    return res.rows.map((r) => ({ t: r.t as ISODate, value: r.value }));
  }
}
