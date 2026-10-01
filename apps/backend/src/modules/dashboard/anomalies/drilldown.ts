import { BadRequestException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ERR_VALIDATION } from '@mimi/shared';
import type { LocationScope } from '../../../common/scope/scope.service';
import { witaDateEquals, witaDateRange } from '../../../kernel/time/wita-range.sql';
import { assertLocationInScope, scopeClause } from '../scope.util';
import { PRICE_TOLERANCE, EXPECTED_CHANNEL_PRICE_SQL } from './detectors/price-deviation';
import type { AnomalyDetectorKey, DrillColumn, DrillResult } from './anomaly.types';

/** How many offending rows a drill-down shows; the panel is for recognising the problem, not for reporting on it. */
export const DRILL_LIMIT = 25;

export interface DrillQuery {
  detector: AnomalyDetectorKey;
  from: string;
  to: string;
  locationId?: string;
  date?: string;
  productId?: string;
  itemId?: string;
  opnameId?: string;
  runId?: string;
  employeeId?: string;
  accountId?: string;
}

type Row = Record<string, string | number | null>;

function need<T>(v: T | undefined, name: string): T {
  if (v === undefined || v === '') {
    throw new BadRequestException({
      code: ERR_VALIDATION,
      message: `${name} is required for this drill-down`,
      details: { field: name },
    });
  }
  return v;
}

const col = (key: string, type: DrillColumn['type'] = 'text'): DrillColumn => ({ key, type });

/**
 * The offending rows behind one finding. Every query re-applies the caller's
 * location scope (`scopeClause`) and, when the request names an outlet,
 * `assertLocationInScope` — a finding's `ref` is just query parameters, so
 * nothing here may trust it to have come from the caller's own list.
 */
export async function drillDown(
  client: PoolClient,
  scope: LocationScope,
  q: DrillQuery,
): Promise<DrillResult> {
  assertLocationInScope(scope, q.locationId);
  switch (q.detector) {
    case 'sales_day_outlier':
      return salesOfDay(client, scope, need(q.locationId, 'locationId'), need(q.date, 'date'));
    case 'product_qty_outlier':
      return linesOfProductDay(
        client,
        scope,
        need(q.locationId, 'locationId'),
        need(q.date, 'date'),
        need(q.productId, 'productId'),
      );
    case 'usage_variance':
      return opnameLines(client, scope, need(q.opnameId, 'opnameId'), q.itemId);
    case 'price_deviation':
      return offPriceLines(
        client,
        scope,
        need(q.locationId, 'locationId'),
        need(q.productId, 'productId'),
        q.from,
        q.to,
      );
    case 'payroll_outlier':
      return payrollLines(client, scope, need(q.runId, 'runId'), need(q.employeeId, 'employeeId'));
    case 'gl_sanity':
      return journalLines(
        client,
        scope,
        need(q.accountId, 'accountId'),
        q.locationId,
        q.date ?? q.to,
      );
    case 'settlement_gap':
      return paymentsOfDay(client, scope, need(q.locationId, 'locationId'), need(q.date, 'date'));
  }
}

async function salesOfDay(
  client: PoolClient,
  scope: LocationScope,
  locationId: string,
  date: string,
): Promise<DrillResult> {
  const params: unknown[] = [locationId, date, DRILL_LIMIT];
  const sc = scopeClause(scope, 's.location_id', params);
  const res = await client.query<Row>(
    `SELECT s.receipt_number AS receipt, s.occurred_at AS at, s.channel,
            (SELECT COUNT(*)::int FROM sale_lines sl WHERE sl.sale_id = s.id) AS lines,
            s.total::text AS total
       FROM sales s
      WHERE s.status = 'completed' AND s.location_id = $1
        AND ${witaDateEquals('s.occurred_at', 2)}
        ${sc}
      ORDER BY s.total DESC
      LIMIT $3`,
    params,
  );
  return {
    columns: [
      col('receipt'),
      col('at', 'datetime'),
      col('channel'),
      col('lines', 'qty'),
      col('total', 'money'),
    ],
    rows: res.rows.map(iso),
  };
}

async function linesOfProductDay(
  client: PoolClient,
  scope: LocationScope,
  locationId: string,
  date: string,
  productId: string,
): Promise<DrillResult> {
  const params: unknown[] = [locationId, date, productId, DRILL_LIMIT];
  const sc = scopeClause(scope, 's.location_id', params);
  const res = await client.query<Row>(
    `SELECT s.receipt_number AS receipt, s.occurred_at AS at, s.channel,
            sl.qty::text AS qty, sl.unit_price::text AS unit_price, sl.line_total::text AS line_total
       FROM sale_lines sl
       JOIN sales s ON s.id = sl.sale_id
      WHERE s.status = 'completed' AND s.location_id = $1 AND sl.product_id = $3
        AND ${witaDateEquals('s.occurred_at', 2)}
        ${sc}
      ORDER BY sl.qty DESC
      LIMIT $4`,
    params,
  );
  return {
    columns: [
      col('receipt'),
      col('at', 'datetime'),
      col('channel'),
      col('qty', 'qty'),
      col('unit_price', 'money'),
      col('line_total', 'money'),
    ],
    rows: res.rows.map(iso),
  };
}

async function opnameLines(
  client: PoolClient,
  scope: LocationScope,
  opnameId: string,
  itemId: string | undefined,
): Promise<DrillResult> {
  const params: unknown[] = [opnameId, DRILL_LIMIT];
  let itemFilter = '';
  if (itemId) {
    params.push(itemId);
    itemFilter = ` AND l.item_id = $${params.length}`;
  }
  const sc = scopeClause(scope, 'o.location_id', params);
  const res = await client.query<Row>(
    `SELECT i.name AS item, sa.name AS area,
            l.system_qty::text AS system_qty, l.counted_qty::text AS counted_qty,
            l.diff_qty::text AS diff_qty,
            (l.diff_qty * i.avg_cost)::text AS value,
            l.variance_reason AS reason
       FROM stock_opname_lines l
       JOIN stock_opname o ON o.id = l.opname_id
       JOIN items i ON i.id = l.item_id
       JOIN storage_areas sa ON sa.id = l.storage_area_id
      WHERE l.opname_id = $1 ${itemFilter} ${sc}
      ORDER BY ABS(l.diff_qty * i.avg_cost) DESC
      LIMIT $2`,
    params,
  );
  return {
    columns: [
      col('item'),
      col('area'),
      col('system_qty', 'qty'),
      col('counted_qty', 'qty'),
      col('diff_qty', 'qty'),
      col('value', 'money'),
      col('reason'),
    ],
    rows: res.rows,
  };
}

async function offPriceLines(
  client: PoolClient,
  scope: LocationScope,
  locationId: string,
  productId: string,
  from: string,
  to: string,
): Promise<DrillResult> {
  const params: unknown[] = [from, to, locationId, productId, PRICE_TOLERANCE, DRILL_LIMIT];
  const sc = scopeClause(scope, 's.location_id', params);
  const res = await client.query<Row>(
    `SELECT s.receipt_number AS receipt, s.occurred_at AS at, s.channel,
            sl.unit_price::text AS unit_price,
            (${EXPECTED_CHANNEL_PRICE_SQL})::text AS expected,
            (sl.unit_price - ${EXPECTED_CHANNEL_PRICE_SQL})::text AS diff
       FROM sale_lines sl
       JOIN sales s ON s.id = sl.sale_id
       JOIN products p ON p.id = sl.product_id
      WHERE s.status = 'completed' AND s.location_id = $3 AND sl.product_id = $4
        AND ${witaDateRange('s.occurred_at', 1, 2)}
        AND ABS(sl.unit_price - ${EXPECTED_CHANNEL_PRICE_SQL}) > $5::numeric
        ${sc}
      ORDER BY s.occurred_at DESC
      LIMIT $6`,
    params,
  );
  return {
    columns: [
      col('receipt'),
      col('at', 'datetime'),
      col('channel'),
      col('unit_price', 'money'),
      col('expected', 'money'),
      col('diff', 'money'),
    ],
    rows: res.rows.map(iso),
  };
}

async function payrollLines(
  client: PoolClient,
  scope: LocationScope,
  runId: string,
  employeeId: string,
): Promise<DrillResult> {
  const params: unknown[] = [runId, employeeId, DRILL_LIMIT];
  const sc = scopeClause(scope, 'e.location_id', params);
  const res = await client.query<Row>(
    `SELECT sc.name AS component, sc.type AS kind, pl.amount::text AS amount,
            pl.source_ref_type AS source
       FROM payroll_lines pl
       JOIN salary_components sc ON sc.id = pl.component_id
       JOIN employees e ON e.id = pl.employee_id
      WHERE pl.run_id = $1 AND pl.employee_id = $2 ${sc}
      ORDER BY sc.sort_order
      LIMIT $3`,
    params,
  );
  return {
    columns: [col('component'), col('kind'), col('amount', 'money'), col('source')],
    rows: res.rows,
  };
}

async function journalLines(
  client: PoolClient,
  scope: LocationScope,
  accountId: string,
  locationId: string | undefined,
  upTo: string,
): Promise<DrillResult> {
  const params: unknown[] = [accountId, upTo, DRILL_LIMIT];
  let loc = scopeClause(scope, 'COALESCE(jl.location_id, je.location_id)', params);
  if (locationId) {
    params.push(locationId);
    loc += ` AND COALESCE(jl.location_id, je.location_id) = $${params.length}`;
  }
  const res = await client.query<Row>(
    `SELECT je.entry_number AS entry, je.entry_date::text AS date, je.description,
            jl.debit::text AS debit, jl.credit::text AS credit
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
      WHERE jl.account_id = $1 AND je.status = 'posted' AND je.entry_date <= $2::date
        ${loc}
      ORDER BY je.entry_date DESC, je.entry_number DESC
      LIMIT $3`,
    params,
  );
  return {
    columns: [
      col('entry'),
      col('date', 'date'),
      col('description'),
      col('debit', 'money'),
      col('credit', 'money'),
    ],
    rows: res.rows,
  };
}

async function paymentsOfDay(
  client: PoolClient,
  scope: LocationScope,
  locationId: string,
  date: string,
): Promise<DrillResult> {
  const params: unknown[] = [locationId, date, DRILL_LIMIT];
  const sc = scopeClause(scope, 's.location_id', params);
  const res = await client.query<Row>(
    `SELECT s.receipt_number AS receipt, sp.method, sp.amount::text AS amount,
            sp.payment_status AS status, pv.status AS settlement
       FROM sale_payments sp
       JOIN sales s ON s.id = sp.sale_id
       LEFT JOIN payment_verifications pv ON pv.ref_type = 'sale_payment' AND pv.ref_id = sp.id
      WHERE s.status = 'completed' AND s.location_id = $1
        AND sp.method IN ('qris', 'bank_transfer')
        AND ${witaDateEquals('s.occurred_at', 2)}
        ${sc}
      ORDER BY (pv.status IS NULL) DESC, sp.amount DESC
      LIMIT $3`,
    params,
  );
  return {
    columns: [
      col('receipt'),
      col('method'),
      col('amount', 'money'),
      col('status'),
      col('settlement'),
    ],
    rows: res.rows,
  };
}

/** `pg` hands timestamptz back as a `Date`; the wire format is an ISO string. */
function iso(r: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(r)) {
    out[k] = (v as unknown) instanceof Date ? (v as unknown as Date).toISOString() : v;
  }
  return out;
}
