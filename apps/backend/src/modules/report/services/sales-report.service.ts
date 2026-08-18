import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  addMoney,
  businessDayBoundaries,
  ZERO_MONEY,
  type ISODate,
  type Money,
} from '@mimi/shared';
import type { SalesReportGroupBy } from '../dto/sales-report.query';
import { assertLocationInScope } from '../scope.util';
import type { ReportCallerContext } from '../report.types';

export interface SalesReportRow {
  groupKey: string;
  groupLabel: string;
  txCount: number;
  gross: Money;
  discount: Money;
  platformFees: Money;
  net: Money;
}

export interface SalesReportResult {
  groupBy: SalesReportGroupBy;
  from: ISODate | null;
  to: ISODate | null;
  rows: SalesReportRow[];
}

export interface OnlineOrderReportRow {
  orderId: string;
  orderRef: string;
  orderDate: ISODate;
  locationId: string;
  locationName: string;
  platform: string;
  grossAmount: Money;
  discountAmount: Money;
  platformFee: Money;
  otherFee: Money;
  netReceived: Money;
  status: string;
  settlementStatus: string;
}

/**
 * FR-POS-07/FR-DASH-03 — `/api/reports/sales` (grouped, incl. online orders)
 * and FR-POS-05/07 — `/api/reports/online-orders` (per-order platform
 * reconciliation, gross→net walk).
 *
 * `groupBy=day|outlet` reads `mv_sales_daily` (CONTRACTS.md's own §1.11
 * grain — already correctly WITA-bucketed at matview build time, per
 * `100_reporting_matviews.sql`'s `AT TIME ZONE 'Asia/Makassar'` cast; no
 * naive `::date` re-derivation needed here). `groupBy=product|method` needs
 * finer grain than the matview carries, so those read `sales`/`sale_lines`/
 * `sale_payments` directly, bucketing the date window through
 * `businessDayBoundaries` (never a naive UTC `::date` cast) per the
 * reporting date rule.
 *
 * Materialized views carry NO row security (confirmed: `100_reporting_matviews.sql`
 * has no `ENABLE ROW LEVEL SECURITY` on any `mv_*` view) — every method here
 * applies `locationScope` explicitly rather than relying on RLS.
 *
 * KNOWN LIMITATION (flagged, not silently glossed over): `groupBy=product`
 * surfaces POS `sale_lines` only. Online-order line items (`online_orders.items`
 * JSONB) are OPTIONAL per Appendix A-7 and carry no per-item price — there is
 * no defensible gross/discount to attribute to a product from them, so they
 * are omitted from the product breakdown rather than guessed at.
 */
@Injectable()
export class SalesReportService {
  async getSalesReport(
    client: PoolClient,
    caller: ReportCallerContext,
    filters: { from?: ISODate; to?: ISODate; locationId?: string; groupBy?: SalesReportGroupBy },
  ): Promise<SalesReportResult> {
    assertLocationInScope(caller.locationScope, filters.locationId);
    const groupBy = filters.groupBy ?? 'day';
    const from = filters.from ?? null;
    const to = filters.to ?? null;

    const scopeIds = this.effectiveLocationIds(caller, filters.locationId);

    let rows: SalesReportRow[];
    if (groupBy === 'day' || groupBy === 'outlet') {
      rows = await this.groupFromMatview(client, groupBy, from, to, scopeIds);
    } else if (groupBy === 'product') {
      rows = await this.groupByProduct(client, from, to, scopeIds);
    } else {
      rows = await this.groupByMethod(client, from, to, scopeIds);
    }

    return { groupBy, from, to, rows };
  }

  private effectiveLocationIds(caller: ReportCallerContext, locationId?: string): string[] | null {
    if (locationId) return [locationId];
    return caller.locationScope === null ? null : [...caller.locationScope];
  }

  private async groupFromMatview(
    client: PoolClient,
    groupBy: 'day' | 'outlet',
    from: ISODate | null,
    to: ISODate | null,
    scopeIds: string[] | null,
  ): Promise<SalesReportRow[]> {
    const params: unknown[] = [];
    let where = '1=1';
    if (from) {
      params.push(from);
      where += ` AND sales_date >= $${params.length}`;
    }
    if (to) {
      params.push(to);
      where += ` AND sales_date <= $${params.length}`;
    }
    if (scopeIds) {
      params.push(scopeIds);
      where += ` AND location_id = ANY($${params.length}::uuid[])`;
    }

    const mvRes = await client.query<{
      sales_date: string;
      location_id: string;
      platform: string | null;
      tx_count: string;
      gross: Money;
      discounts: Money;
    }>(
      // `to_char` avoids the classic `pg`-driver `DATE` pitfall (parsed into a JS `Date` at LOCAL
      // midnight, not a plain string) — same convention `attendance.integration.spec.ts` documents.
      `SELECT to_char(sales_date, 'YYYY-MM-DD') AS sales_date, location_id, platform, tx_count, gross, discounts
         FROM mv_sales_daily WHERE ${where}`,
      params,
    );

    const feesRes = await client.query<{ order_date: string; location_id: string; fees: Money }>(
      `SELECT to_char(order_date, 'YYYY-MM-DD') AS order_date, location_id, COALESCE(SUM(platform_fee), '0.00') AS fees
         FROM online_orders
        WHERE status = 'completed' ${from ? `AND order_date >= $1` : ''} ${to ? `AND order_date <= $${from ? 2 : 1}` : ''}
          ${scopeIds ? `AND location_id = ANY($${(from ? 1 : 0) + (to ? 1 : 0) + 1}::uuid[])` : ''}
        GROUP BY order_date, location_id`,
      [...(from ? [from] : []), ...(to ? [to] : []), ...(scopeIds ? [scopeIds] : [])],
    );

    const keyOf = (r: { sales_date: string; location_id: string }) =>
      groupBy === 'day' ? r.sales_date : r.location_id;

    const feesByKey = new Map<string, Money>();
    for (const r of feesRes.rows) {
      const key = groupBy === 'day' ? r.order_date : r.location_id;
      feesByKey.set(key, addMoney(feesByKey.get(key) ?? ZERO_MONEY, r.fees));
    }

    const buckets = new Map<string, { txCount: number; gross: Money; discount: Money }>();
    let locationNames: Map<string, string> | null = null;
    if (groupBy === 'outlet')
      locationNames = await this.locationNames(
        client,
        mvRes.rows.map((r) => r.location_id),
      );

    for (const r of mvRes.rows) {
      const key = keyOf(r);
      const bucket = buckets.get(key) ?? { txCount: 0, gross: ZERO_MONEY, discount: ZERO_MONEY };
      bucket.txCount += Number.parseInt(r.tx_count, 10);
      bucket.gross = addMoney(bucket.gross, r.gross);
      bucket.discount = addMoney(bucket.discount, r.discounts);
      buckets.set(key, bucket);
    }

    return [...buckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, b]) => {
        const platformFees = feesByKey.get(key) ?? ZERO_MONEY;
        return {
          groupKey: key,
          groupLabel: groupBy === 'outlet' ? (locationNames?.get(key) ?? key) : key,
          txCount: b.txCount,
          gross: b.gross,
          discount: b.discount,
          platformFees,
          // NOTE: the online-order arm of `mv_sales_daily.gross` is `SUM(net_received)` — already
          // fee/discount-netted at the SOURCE (`online_orders.net_received`'s own definition, migration
          // 053). Subtracting `platformFees` again here would double-count; `net` therefore equals
          // `gross` for the parts of this bucket contributed by online orders, and `gross - discount`
          // for the POS-only parts. `platformFees` is surfaced purely as an informational figure.
          net: b.gross,
        };
      });
  }

  private async locationNames(client: PoolClient, ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const res = await client.query<{ id: string; name: string }>(
      `SELECT id, name FROM locations WHERE id = ANY($1::uuid[])`,
      [[...new Set(ids)]],
    );
    return new Map(res.rows.map((r) => [r.id, r.name]));
  }

  private async groupByProduct(
    client: PoolClient,
    from: ISODate | null,
    to: ISODate | null,
    scopeIds: string[] | null,
  ): Promise<SalesReportRow[]> {
    const params: unknown[] = [];
    let where = `s.status = 'completed'`;
    if (from) {
      params.push(businessDayBoundaries(from).startUtc);
      where += ` AND s.occurred_at >= $${params.length}`;
    }
    if (to) {
      params.push(businessDayBoundaries(to).endUtc);
      where += ` AND s.occurred_at < $${params.length}`;
    }
    if (scopeIds) {
      params.push(scopeIds);
      where += ` AND s.location_id = ANY($${params.length}::uuid[])`;
    }

    const res = await client.query<{
      product_id: string;
      product_name: string;
      tx_count: string;
      gross: Money;
      discount: Money;
    }>(
      `SELECT sl.product_id, p.name AS product_name, COUNT(DISTINCT sl.sale_id)::int AS tx_count,
              COALESCE(SUM(sl.line_total), '0.00') AS gross, COALESCE(SUM(sl.discount), '0.00') AS discount
         FROM sale_lines sl
         JOIN sales s ON s.id = sl.sale_id
         JOIN products p ON p.id = sl.product_id
        WHERE ${where}
        GROUP BY sl.product_id, p.name
        ORDER BY p.name ASC`,
      params,
    );

    return res.rows.map((r) => ({
      groupKey: r.product_id,
      groupLabel: r.product_name,
      txCount: Number.parseInt(r.tx_count as unknown as string, 10),
      gross: r.gross,
      discount: r.discount,
      platformFees: ZERO_MONEY,
      net: r.gross,
    }));
  }

  private async groupByMethod(
    client: PoolClient,
    from: ISODate | null,
    to: ISODate | null,
    scopeIds: string[] | null,
  ): Promise<SalesReportRow[]> {
    const params: unknown[] = [];
    let where = `s.status = 'completed'`;
    if (from) {
      params.push(businessDayBoundaries(from).startUtc);
      where += ` AND s.occurred_at >= $${params.length}`;
    }
    if (to) {
      params.push(businessDayBoundaries(to).endUtc);
      where += ` AND s.occurred_at < $${params.length}`;
    }
    if (scopeIds) {
      params.push(scopeIds);
      where += ` AND s.location_id = ANY($${params.length}::uuid[])`;
    }

    const posRes = await client.query<{ method: string; tx_count: string; amount: Money }>(
      `SELECT sp.method, COUNT(*)::int AS tx_count, COALESCE(SUM(sp.amount), '0.00') AS amount
         FROM sale_payments sp
         JOIN sales s ON s.id = sp.sale_id
        WHERE ${where}
        GROUP BY sp.method`,
      params,
    );

    const onlineParams: unknown[] = [];
    let onlineWhere = `status = 'completed'`;
    if (from) {
      onlineParams.push(from);
      onlineWhere += ` AND order_date >= $${onlineParams.length}`;
    }
    if (to) {
      onlineParams.push(to);
      onlineWhere += ` AND order_date <= $${onlineParams.length}`;
    }
    if (scopeIds) {
      onlineParams.push(scopeIds);
      onlineWhere += ` AND location_id = ANY($${onlineParams.length}::uuid[])`;
    }
    const onlineRes = await client.query<{
      platform: string;
      tx_count: string;
      gross: Money;
      discount: Money;
      fees: Money;
      net: Money;
    }>(
      `SELECT platform, COUNT(*)::int AS tx_count, COALESCE(SUM(gross_amount), '0.00') AS gross,
              COALESCE(SUM(discount_amount), '0.00') AS discount,
              COALESCE(SUM(platform_fee + other_fee), '0.00') AS fees,
              COALESCE(SUM(net_received), '0.00') AS net
         FROM online_orders
        WHERE ${onlineWhere}
        GROUP BY platform`,
      onlineParams,
    );

    const rows: SalesReportRow[] = posRes.rows.map((r) => ({
      groupKey: r.method,
      groupLabel: r.method,
      txCount: Number.parseInt(r.tx_count as unknown as string, 10),
      gross: r.amount,
      discount: ZERO_MONEY,
      platformFees: ZERO_MONEY,
      net: r.amount,
    }));

    for (const r of onlineRes.rows) {
      rows.push({
        groupKey: r.platform,
        groupLabel: r.platform,
        txCount: Number.parseInt(r.tx_count as unknown as string, 10),
        gross: r.gross,
        discount: r.discount,
        platformFees: r.fees,
        net: r.net,
      });
    }
    return rows;
  }

  // ── GET /online-orders — full gross->net walk per order ─────────────────
  async getOnlineOrdersReport(
    client: PoolClient,
    caller: ReportCallerContext,
    filters: { from?: ISODate; to?: ISODate; platform?: string; locationId?: string },
  ): Promise<OnlineOrderReportRow[]> {
    assertLocationInScope(caller.locationScope, filters.locationId);
    const scopeIds = this.effectiveLocationIds(caller, filters.locationId);

    const params: unknown[] = [];
    let where = '1=1';
    if (filters.from) {
      params.push(filters.from);
      where += ` AND o.order_date >= $${params.length}`;
    }
    if (filters.to) {
      params.push(filters.to);
      where += ` AND o.order_date <= $${params.length}`;
    }
    if (filters.platform) {
      params.push(filters.platform);
      where += ` AND o.platform = $${params.length}`;
    }
    if (scopeIds) {
      params.push(scopeIds);
      where += ` AND o.location_id = ANY($${params.length}::uuid[])`;
    }

    const res = await client.query<{
      id: string;
      order_ref: string;
      order_date: string;
      location_id: string;
      location_name: string;
      platform: string;
      gross_amount: Money;
      discount_amount: Money;
      platform_fee: Money;
      other_fee: Money;
      net_received: Money;
      status: string;
      settlement_status: string;
    }>(
      `SELECT o.id, o.order_ref, to_char(o.order_date, 'YYYY-MM-DD') AS order_date, o.location_id, l.name AS location_name, o.platform,
              o.gross_amount, o.discount_amount, o.platform_fee, o.other_fee, o.net_received,
              o.status, o.settlement_status
         FROM online_orders o
         JOIN locations l ON l.id = o.location_id
        WHERE ${where}
        ORDER BY o.order_date DESC, o.order_ref ASC`,
      params,
    );

    return res.rows.map((r) => ({
      orderId: r.id,
      orderRef: r.order_ref,
      orderDate: r.order_date,
      locationId: r.location_id,
      locationName: r.location_name,
      platform: r.platform,
      grossAmount: r.gross_amount,
      discountAmount: r.discount_amount,
      platformFee: r.platform_fee,
      otherFee: r.other_fee,
      netReceived: r.net_received,
      status: r.status,
      settlementStatus: r.settlement_status,
    }));
  }
}
