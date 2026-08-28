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
 *
 * `groupBy=channel` (added post-249/251): `sales.channel` (walk_in/gofood/
 * shopeefood) and PAYMENT METHOD (`sale_payments.method` — cash/qris/
 * bank_transfer) are genuinely different dimensions — a GoFood order still
 * has a payment method. `groupBy=method`'s existing online arm predates
 * `channel` and conflates the two by presenting `online_orders.platform` as
 * if it were another "method" value; that conflation is NOT extended here
 * (it would double-count: `sale_payments` already includes every channel
 * sale's payment, so also adding a channel-keyed row to the SAME array would
 * count that revenue twice if a caller sums the array). `groupBy=channel` is
 * therefore its own grouping, reading `sales.channel` (continuous, all
 * channels) UNIONed with the now-dormant `online_orders.platform` (pre-249
 * history) — see `groupByChannel`'s own comment. `groupBy=method` is left
 * exactly as it was: correct for payment-method totals (which were never
 * wrong), and its online-platform rows now simply stop growing after the
 * 249 cutover — an intentional consequence of `online_orders` being
 * write-retired, not a bug this class re-introduces. Whether `method`
 * should ALSO be taught about `channel` (and if so, in what shape) is an
 * owner/API-contract decision flagged in this ticket's report, not made
 * here.
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
    } else if (groupBy === 'channel') {
      rows = await this.groupByChannel(client, from, to, scopeIds);
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

  /**
   * `groupBy=method` — HOW the money arrived: cash, qris, bank_transfer, keyed
   * by `sale_payments.method`.
   *
   * NARROWED 2026-08-27, and this was a deliberate contract change. It used to
   * append one row per `online_orders.platform` to the payment-method rows, so
   * a single flat array mixed two different dimensions under the same
   * `groupKey`: "how it was paid" and "where the order came from". A consumer
   * could not sum it and know what the number meant, and could not tell a
   * payment method from a platform without a hardcoded list of both.
   *
   * Migration 249 made that untenable rather than merely untidy. GoFood and
   * ShopeeFood are now ordinary `sales` rows carrying `sales.channel`, and they
   * have real `sale_payments` rows like any other sale — so a channel sale
   * already appears in the payment-method rows. Keeping the old online arm as
   * well would have double-counted it; reading `sales.channel` into that arm
   * would have double-counted it twice over. Leaving the arm on `online_orders`
   * alone (the state this replaced) meant it silently FLATLINED after the
   * cutover, which is the worst of the three because nothing errors.
   *
   * So the dimensions are now separate and each is clean:
   *   `groupBy=method`  — cash / qris / bank_transfer, for EVERY sale
   *                       including channel sales.
   *   `groupBy=channel` — walk_in / gofood / shopeefood, continuous across the
   *                       cutover (`sales.channel` UNION `online_orders`).
   *
   * WHAT THIS COSTS, stated plainly: pre-cutover `online_orders` rows have no
   * `sale_payments` and therefore no payment method, so they no longer appear
   * under `method` at all. That revenue has not gone anywhere — it is fully
   * reachable via `groupBy=channel`, `groupBy=day`, and
   * `/reports/online-orders` — but `method` must no longer be summed to get
   * total revenue for a range that predates the cutover. `day`/`outlet`/
   * `channel` are the dimensions that total correctly. Documented in
   * CONTRACTS §4.19.
   */
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

    // PAYMENT METHODS ONLY — see this method's doc comment for why the
    // `online_orders.platform` rows that used to be appended here are gone.
    return posRes.rows.map((r) => ({
      groupKey: r.method,
      groupLabel: r.method,
      txCount: Number.parseInt(r.tx_count as unknown as string, 10),
      gross: r.amount,
      // A payment row records an amount, not a gross/discount/fee walk: the
      // discount was applied to the SALE, and a platform fee belongs to a
      // channel, not to "cash". Reporting them as zero here is honest — this
      // dimension genuinely does not know them. `groupBy=channel` does.
      discount: ZERO_MONEY,
      platformFees: ZERO_MONEY,
      net: r.amount,
    }));
  }

  /**
   * `groupBy=channel` — walk_in/gofood/shopeefood, continuous across the 249
   * cutover: `sales.channel` (every sale, all three values, NOT just
   * post-cutover ones — walk_in sales have always lived here) UNIONed with
   * `online_orders.platform` (only ever gofood/shopeefood, pre-cutover
   * history that will never exist as a `sales` row). No double count: an
   * order lives in exactly one of the two source tables — 249 retired
   * `online_orders`'s write path, it did not leave both live at once. Fees
   * are only ever known for the `online_orders` contribution (platform
   * commission is absorbed into `products.price_gofood`/`price_shopeefood`
   * from 249 forward, per that migration's own header — there is no
   * separate fee to report for a channel sale), so `platformFees` on a
   * merged row is whatever `online_orders` contributed and nothing more.
   */
  private async groupByChannel(
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

    const salesRes = await client.query<{
      channel: string;
      tx_count: string;
      gross: Money;
      discount: Money;
    }>(
      `SELECT s.channel, COUNT(*)::int AS tx_count,
              COALESCE(SUM(s.total), '0.00') AS gross, COALESCE(SUM(s.discount), '0.00') AS discount
         FROM sales s
        WHERE ${where}
        GROUP BY s.channel`,
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
    }>(
      `SELECT platform, COUNT(*)::int AS tx_count, COALESCE(SUM(gross_amount), '0.00') AS gross,
              COALESCE(SUM(discount_amount), '0.00') AS discount,
              COALESCE(SUM(platform_fee + other_fee), '0.00') AS fees
         FROM online_orders
        WHERE ${onlineWhere}
        GROUP BY platform`,
      onlineParams,
    );

    const buckets = new Map<
      string,
      { txCount: number; gross: Money; discount: Money; platformFees: Money }
    >();
    const bucket = (key: string) => {
      let b = buckets.get(key);
      if (!b) {
        b = { txCount: 0, gross: ZERO_MONEY, discount: ZERO_MONEY, platformFees: ZERO_MONEY };
        buckets.set(key, b);
      }
      return b;
    };

    for (const r of salesRes.rows) {
      const b = bucket(r.channel);
      b.txCount += Number.parseInt(r.tx_count as unknown as string, 10);
      b.gross = addMoney(b.gross, r.gross);
      b.discount = addMoney(b.discount, r.discount);
    }
    for (const r of onlineRes.rows) {
      const b = bucket(r.platform);
      b.txCount += Number.parseInt(r.tx_count as unknown as string, 10);
      b.gross = addMoney(b.gross, r.gross);
      b.discount = addMoney(b.discount, r.discount);
      b.platformFees = addMoney(b.platformFees, r.fees);
    }

    return [...buckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, b]) => ({
        groupKey: key,
        groupLabel: key,
        txCount: b.txCount,
        gross: b.gross,
        discount: b.discount,
        platformFees: b.platformFees,
        // Same convention as `groupFromMatview`/`groupByMethod`: `sales.total`
        // is already net of its own discount, and `online_orders.net_received`
        // is already fee/discount-netted at the source — net therefore equals
        // gross for this merged bucket, `discount`/`platformFees` stay
        // informational fields only.
        net: b.gross,
      }));
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
