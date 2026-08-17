import { Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ERR_NOT_FOUND, ZERO_MONEY, type ISODateTime, type Money, type UUID } from '@mimi/shared';
import { assertLocationInScope } from '../scope.util';
import { toIsoString, type ReportCallerContext } from '../report.types';

export interface ShiftReportSection {
  byMethod: { method: string; amount: Money; count: number }[];
  voids: number;
  voidAmount: Money;
  onlineOrders: { platform: string; count: number; net: Money }[];
}

export interface ShiftReportSale {
  id: UUID;
  receiptNumber: string;
  status: string;
  subtotal: Money;
  discount: Money;
  total: Money;
  occurredAt: ISODateTime;
}

export interface ShiftReportResult {
  shift: {
    id: UUID;
    shiftNumber: string;
    locationId: UUID;
    openedAt: ISODateTime;
    closedAt: ISODateTime | null;
    status: string;
    openingCash: Money;
    closingCashCounted: Money | null;
    expectedCash: Money | null;
    cashVariance: Money | null;
    grossSales: Money;
    salesCount: number;
  };
  report: ShiftReportSection;
  sales: ShiftReportSale[];
}

/**
 * `/api/reports/shift/:shiftId` — laporan shift (CONTRACTS.md §4.19: "`ShiftReport`
 * (see M13) + sales list"). `pos.PosShiftService.getReport`'s `ShiftReport` shape
 * (`byMethod`/`voids`/`voidAmount`/`onlineOrders`) is NOT importable here —
 * `PosModule` exports nothing (no `exports: []` array), and this module owns
 * only `modules/report/**`, so the identical breakdown is recomputed directly
 * over `pos_shifts`/`sale_payments`/`void_refunds`/`online_orders` — same SQL
 * shape as `pos-shift.service.ts#buildReport`, deliberately kept in lockstep
 * with it rather than inventing a different one.
 */
@Injectable()
export class ShiftReportService {
  async getShiftReport(client: PoolClient, caller: ReportCallerContext, shiftId: UUID): Promise<ShiftReportResult> {
    const shiftRes = await client.query<{
      id: string;
      shift_number: string;
      location_id: string;
      opened_at: string;
      closed_at: string | null;
      status: string;
      opening_cash: Money;
      closing_cash_counted: Money | null;
      expected_cash: Money | null;
      cash_variance: Money | null;
      gross_sales: Money;
      sales_count: number;
    }>(
      `SELECT id, shift_number, location_id, opened_at, closed_at, status, opening_cash,
              closing_cash_counted, expected_cash, cash_variance, gross_sales, sales_count
         FROM pos_shifts WHERE id = $1`,
      [shiftId],
    );
    const shiftRow = shiftRes.rows[0];
    if (!shiftRow) throw new NotFoundException({ code: ERR_NOT_FOUND, message: `Shift ${shiftId} not found` });

    assertLocationInScope(caller.locationScope, shiftRow.location_id);

    const [byMethodRes, voidsRes, onlineRes, salesRes] = await Promise.all([
      client.query<{ method: string; amount: Money; count: string }>(
        `SELECT sp.method, COALESCE(SUM(sp.amount), '0.00') AS amount, COUNT(*)::int AS count
           FROM sale_payments sp
           JOIN sales s ON s.id = sp.sale_id
          WHERE s.shift_id = $1 AND s.status = 'completed'
          GROUP BY sp.method`,
        [shiftId],
      ),
      client.query<{ count: string; amount: Money }>(
        `SELECT COUNT(*)::int AS count, COALESCE(SUM(vr.amount), '0.00') AS amount
           FROM void_refunds vr
           JOIN sales s ON s.id = vr.sale_id
          WHERE s.shift_id = $1 AND vr.status = 'approved'`,
        [shiftId],
      ),
      client.query<{ platform: string; count: string; net: Money }>(
        `SELECT platform, COUNT(*)::int AS count, COALESCE(SUM(net_received), '0.00') AS net
           FROM online_orders WHERE shift_id = $1 AND status = 'completed'
          GROUP BY platform`,
        [shiftId],
      ),
      client.query<{
        id: string;
        receipt_number: string;
        status: string;
        subtotal: Money;
        discount: Money;
        total: Money;
        occurred_at: string;
      }>(
        `SELECT id, receipt_number, status, subtotal, discount, total, occurred_at
           FROM sales WHERE shift_id = $1 ORDER BY occurred_at ASC`,
        [shiftId],
      ),
    ]);

    return {
      shift: {
        id: shiftRow.id,
        shiftNumber: shiftRow.shift_number,
        locationId: shiftRow.location_id,
        openedAt: toIsoString(shiftRow.opened_at),
        closedAt: shiftRow.closed_at ? toIsoString(shiftRow.closed_at) : null,
        status: shiftRow.status,
        openingCash: shiftRow.opening_cash,
        closingCashCounted: shiftRow.closing_cash_counted,
        expectedCash: shiftRow.expected_cash,
        cashVariance: shiftRow.cash_variance,
        grossSales: shiftRow.gross_sales,
        salesCount: Number(shiftRow.sales_count),
      },
      report: {
        byMethod: byMethodRes.rows.map((r) => ({ method: r.method, amount: r.amount, count: Number(r.count) })),
        voids: Number(voidsRes.rows[0]?.count ?? 0),
        voidAmount: voidsRes.rows[0]?.amount ?? ZERO_MONEY,
        onlineOrders: onlineRes.rows.map((r) => ({ platform: r.platform, count: Number(r.count), net: r.net })),
      },
      sales: salesRes.rows.map((r) => ({
        id: r.id,
        receiptNumber: r.receipt_number,
        status: r.status,
        subtotal: r.subtotal,
        discount: r.discount,
        total: r.total,
        occurredAt: toIsoString(r.occurred_at),
      })),
    };
  }
}
