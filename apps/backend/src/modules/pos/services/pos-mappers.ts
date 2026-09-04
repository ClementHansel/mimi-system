import type {
  Money,
  OnlineOrderStatus,
  OnlinePlatform,
  PaymentMethod,
  PaymentStatus,
  Qty,
  SaleChannel,
  SaleStatus,
  ShiftStatus,
  UUID,
} from '@mimi/shared';
import type { CashVarianceProposal, OnlineOrder, Sale, Shift } from '@mimi/shared';
import { formatDateOnly } from '../../../common/date-only.util';

/** Row-to-DTO mappers — one place that knows the `snake_case` DB shape vs the `camelCase` wire shape (CONTRACTS.md §0). */

export interface ShiftRow {
  id: UUID;
  shift_number: string;
  location_id: UUID;
  device_id: UUID | null;
  opened_by_name: string;
  opened_at: Date | string;
  opening_cash: Money;
  status: ShiftStatus;
  closed_at: Date | string | null;
  closing_cash_counted: Money | null;
  expected_cash: Money | null;
  cash_variance: Money | null;
  sales_count: number;
  gross_sales: Money;
}

export function mapShift(r: ShiftRow): Shift {
  return {
    id: r.id,
    shiftNumber: r.shift_number,
    locationId: r.location_id,
    deviceId: r.device_id,
    openedBy: r.opened_by_name,
    openedAt: new Date(r.opened_at).toISOString(),
    openingCash: r.opening_cash,
    status: r.status,
    closedAt: r.closed_at ? new Date(r.closed_at).toISOString() : null,
    closingCashCounted: r.closing_cash_counted,
    expectedCash: r.expected_cash,
    cashVariance: r.cash_variance,
    salesCount: r.sales_count,
    grossSales: r.gross_sales,
  };
}

export interface SaleLineRow {
  product_id: UUID;
  product_name: string;
  qty: Qty;
  unit_price: Money;
  discount: Money;
  line_total: Money;
}

export interface SalePaymentRow {
  method: PaymentMethod;
  amount: Money;
  reference: string | null;
  payment_status: PaymentStatus;
}

export interface SaleRow {
  id: UUID;
  receipt_number: string;
  location_id: UUID;
  shift_id: UUID;
  kasir_name: string;
  status: SaleStatus;
  subtotal: Money;
  discount: Money;
  total: Money;
  paid_amount: Money;
  change_amount: Money;
  offline_created: boolean;
  occurred_at: Date | string;
  channel: SaleChannel;
}

export function mapSale(r: SaleRow, lines: SaleLineRow[], payments: SalePaymentRow[]): Sale {
  return {
    id: r.id,
    receiptNumber: r.receipt_number,
    locationId: r.location_id,
    shiftId: r.shift_id,
    kasirName: r.kasir_name,
    status: r.status,
    channel: r.channel,
    subtotal: r.subtotal,
    discount: r.discount,
    total: r.total,
    paidAmount: r.paid_amount,
    changeAmount: r.change_amount,
    offlineCreated: r.offline_created,
    occurredAt: new Date(r.occurred_at).toISOString(),
    lines: lines.map((l) => ({
      productId: l.product_id,
      productName: l.product_name,
      qty: l.qty,
      unitPrice: l.unit_price,
      discount: l.discount,
      lineTotal: l.line_total,
    })),
    payments: payments.map((p) => ({
      method: p.method,
      amount: p.amount,
      reference: p.reference,
      paymentStatus: p.payment_status,
    })),
  };
}

export interface OnlineOrderRow {
  id: UUID;
  location_id: UUID;
  platform: OnlinePlatform;
  order_ref: string;
  order_date: Date | string;
  gross_amount: Money;
  discount_amount: Money;
  platform_fee: Money;
  other_fee: Money;
  net_received: Money;
  status: OnlineOrderStatus;
}

export function mapOnlineOrder(r: OnlineOrderRow): OnlineOrder {
  // `formatDateOnly`, NOT `.toISOString().slice(0, 10)`. node-pg parses a
  // Postgres DATE with the LOCAL-timezone constructor, so re-reading it as UTC
  // shifts the calendar day by the server's offset — under Asia/Makassar
  // (UTC+8, D-11's mandated timezone) every online order displayed ONE DAY
  // EARLY. Found 2026-09-04 by recording a GoFood order dated the 4th and
  // reading back the 3rd, while the row in the database said the 4th.
  //
  // That is revenue attributed to the wrong day on a platform the outlets
  // reconcile against GoFood's own statements. `common/date-only.util.ts`
  // exists for exactly this and names five modules that hit it before this one.
  const orderDate = formatDateOnly(r.order_date);
  return {
    id: r.id,
    locationId: r.location_id,
    platform: r.platform,
    orderRef: r.order_ref,
    orderDate,
    grossAmount: r.gross_amount,
    discountAmount: r.discount_amount,
    platformFee: r.platform_fee,
    otherFee: r.other_fee,
    netReceived: r.net_received,
    status: r.status,
  };
}

export interface CashVarianceProposalRow {
  id: UUID;
  shift_id: UUID;
  location_id: UUID;
  kasir_name: string;
  amount: Money;
  status: string;
  decided_by_name: string | null;
  decided_at: Date | string | null;
  decision_reason: string | null;
}

export function mapCashVarianceProposal(r: CashVarianceProposalRow): CashVarianceProposal {
  return {
    id: r.id,
    shiftId: r.shift_id,
    locationId: r.location_id,
    kasirName: r.kasir_name,
    amount: r.amount,
    status: r.status,
    decidedBy: r.decided_by_name,
    decidedAt: r.decided_at ? new Date(r.decided_at).toISOString() : null,
    decisionReason: r.decision_reason,
  };
}
