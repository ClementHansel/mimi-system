/**
 * Wire shapes for F-PO / M11 `purchasing` (CONTRACTS.md §4.11: FR-PO-01..04,
 * F-PUR-01..05) plus the M06 `supplier` slices this surface needs (§4.6,
 * FR-SUP-01..06). Kept local to `components/purchasing` rather than
 * `lib/shared-types` (W1-E's frozen seam) — same choice `components/
 * warehouse/lib/types.ts` and `components/finance/types.ts` made, since these
 * interfaces are specific to this module's screens and several of them
 * (`Supplier`, `SupplierItem`, `PriceHistoryEntry`, `PurchaseOrderDetail`,
 * `PurchaseRequestDetail`) are declared ad hoc in the backend service files,
 * not exported from `@mimi/shared`.
 *
 * `approval`/`paymentStatus` (CLEANUP-DATE): `PurchaseOrderService.toListRow`/
 * `toDetail` and `PurchaseRequestService.toDetail` now populate both fields
 * for real (verified against `apps/backend/src/modules/purchasing/
 * purchase-order.service.ts` and `purchase-request.service.ts`) —
 * `approval` is `null` unconditionally on PO/PR list rows (avoids an N+1 —
 * `paymentStatus` is a plain LEFT JOIN column, so it IS populated on PO list
 * rows too). `paymentStatus` currently reads back `null` for `kepala_gudang`
 * specifically because of an RLS policy gap being fixed in parallel — treat
 * that `null` as "no payment record visible", never as an implicit "unpaid".
 */
import type { Money, Qty, UUID, ISODate, ApprovalDetail, PaymentStatus } from '@/lib/shared-types';

// ── shared lookups (kept local; see file-level doc for why not cross-module) ─

export interface Item {
  id: UUID;
  sku: string;
  name: string;
  baseUnit: { id: UUID; code: string };
  isActive: boolean;
}

export interface StorageArea {
  id: UUID;
  locationId: UUID;
  code: string;
  name: string;
  type: string;
  isActive: boolean;
}

export interface LocationOption {
  id: UUID;
  name: string;
  /**
   * `GET /locations` returns these too (`LocationService`'s row shape); they
   * were simply not declared here. Needed now that a purchase's destination
   * must be a GUDANG — the filter is `type === 'warehouse'` — and that long
   * location lists are searchable by city.
   */
  type?: 'warehouse' | 'outlet' | string;
  city?: string | null;
  code?: string;
}

// ── §4.6 supplier (role-locked pricing — D-20 / Amendment 3) ────────────────

export interface Supplier {
  id: UUID;
  code: string;
  name: string;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  paymentTermsDays: number;
  bankName: string | null;
  bankAccount: string | null;
  bankAccountName: string | null;
  outletVisible: boolean;
  isActive: boolean;
}

/**
 * The writable half of a supplier. `id`/`isActive` are server-owned:
 * deactivation goes through `DELETE`, never a field on an update.
 */
export type SupplierWriteBody = Omit<Supplier, 'id' | 'isActive'> & { notes?: string | null };

/** FR-SUP-02/05 — one purchase order in a supplier's history. Transcribed from `TransactionEntry` in `supplier.service.ts`, not guessed. */
export interface SupplierTransaction {
  poId: UUID;
  poNumber: string;
  orderDate: string;
  status: string;
  total: Money;
  paymentStatus: string | null;
}

/** Outlet-visible projection — name/contact only, no pricing/termin/bank (FR-SUP-06). */
export interface SupplierDirectoryEntry {
  id: UUID;
  code: string;
  name: string;
  contactName: string | null;
  phone: string | null;
  address: string | null;
}

export interface SupplierItem {
  id: UUID;
  itemId: UUID;
  itemName: string;
  supplierSku: string | null;
  currentPrice: Money;
  leadTimeDays: number;
  isPreferred: boolean;
}

/** FR-SUP-04 — append-only, never edited/deleted from the UI. */
export interface PriceHistoryEntry {
  itemId: UUID;
  itemName: string;
  price: Money;
  effectiveDate: ISODate;
  source: 'manual' | 'po';
  recordedBy: string | null;
}

// ── §4.11 purchase requests (F-PUR-01) ──────────────────────────────────────

export interface PurchaseRequestListRow {
  id: UUID;
  prNumber: string;
  locationName: string;
  status: string;
  requestedBy: string;
  neededBy: ISODate | null;
  lineCount: number;
}

export interface PurchaseRequestLine {
  id: UUID;
  itemId: UUID;
  itemName: string;
  unitId: UUID;
  unitCode: string;
  qty: Qty;
  estPrice: Money;
  suggestedSupplierId: UUID | null;
}

/** DETAIL only — `PurchaseRequestListRow` has no `approval` field (CONTRACTS §4.11's documented list-row shape omits it). */
export interface PurchaseRequestDetail {
  id: UUID;
  prNumber: string;
  locationId: UUID;
  locationName: string;
  status: string;
  requestedBy: string;
  neededBy: ISODate | null;
  rejectionReason: string | null;
  notes: string | null;
  approval: ApprovalDetail | null;
  lines: PurchaseRequestLine[];
}

// ── §4.11 purchase orders + receiving (FR-PO-01..04) ────────────────────────

export interface PurchaseOrderListRow {
  id: UUID;
  poNumber: string;
  supplierId: UUID;
  supplierName: string;
  locationId: UUID;
  status: string;
  orderDate: ISODate;
  expectedDate: ISODate | null;
  total: Money;
  /** `null` unconditionally on list rows — the real chain requires a per-document round trip; see `toDetail` below. */
  approval: ApprovalDetail | null;
  /**
   * A plain LEFT JOIN column, so (unlike `approval`) it IS populated on list
   * rows too. `'rejected'` is a real linked-payment-verification status
   * that isn't a `PaymentStatus` enum member. `null` means no linked payment
   * record is visible — currently ALSO what `kepala_gudang` reads back due to
   * an RLS gap (file-level doc) — render it as "unavailable", never "unpaid".
   */
  paymentStatus: PaymentStatus | 'rejected' | null;
}

export interface PurchaseOrderLine {
  id: UUID;
  itemId: UUID;
  itemName: string;
  unitCode: string;
  qtyOrdered: Qty;
  unitPrice: Money;
  lineTotal: Money;
  qtyReceived: Qty;
  /** `qtyOrdered - qtyReceived`, floored at 0 — not in CONTRACTS but present on the live line. */
  qtyDifference: Qty;
}

export interface PurchaseOrderDetail extends PurchaseOrderListRow {
  paymentTermsDays: number;
  subtotal: Money;
  tax: Money;
  prId: UUID | null;
  cancelReason: string | null;
  notes: string | null;
  lines: PurchaseOrderLine[];
}
