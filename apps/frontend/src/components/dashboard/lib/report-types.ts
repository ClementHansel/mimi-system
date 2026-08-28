/**
 * Wire shapes for the M19 `report` endpoints the dashboard's Sales and
 * Marketing tabs read (CONTRACTS.md §4.19) — transcribed from
 * `apps/backend/src/modules/report/services/sales-report.service.ts`, same
 * convention as `./types.ts` does for §4.18.
 *
 * Money fields are decimal STRINGS on the wire (CONTRACTS §0) — never
 * `number`. Everything below is read at `?format=json`; the CSV/PDF files
 * these tabs produce are generated client-side from these same rows by
 * `lib/export/{csv,pdf}.ts`, NOT by the backend's `?format=csv|xlsx` arm.
 * That is deliberate: the backend has no PDF writer, and `ExportButton` is
 * already the house affordance for "the rows on this screen, in a file".
 */
import type { ISODate, Money, UUID } from '@/lib/shared-types';

/** `?groupBy=` on `GET /api/reports/sales` (CONTRACTS §4.19). */
export type SalesGroupBy = 'day' | 'outlet' | 'product' | 'method' | 'channel';

export interface SalesReportRow {
  /** Date (`groupBy=day`), location/product UUID, or a payment-method / channel name. */
  groupKey: string;
  /** Human label for `groupKey` — outlet or product name; equals `groupKey` otherwise. */
  groupLabel: string;
  txCount: number;
  gross: Money;
  discount: Money;
  /**
   * Platform commission, INFORMATIONAL ONLY — `net` is already fee-netted at
   * the source (`online_orders.net_received`), so subtracting this again
   * double-counts. See the backend service's own note on `net`.
   */
  platformFees: Money;
  net: Money;
}

export interface SalesReportResult {
  groupBy: SalesGroupBy;
  from: ISODate | null;
  to: ISODate | null;
  rows: SalesReportRow[];
}

/** One row of `GET /api/reports/online-orders` — the per-order gross→net walk. */
export interface OnlineOrderReportRow {
  orderId: UUID;
  orderRef: string;
  orderDate: ISODate;
  locationId: UUID;
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

/** `GET /api/locations?active=true` — only the fields the outlet filter needs. */
export interface LocationOption {
  id: UUID;
  code: string;
  name: string;
  type: string;
}
