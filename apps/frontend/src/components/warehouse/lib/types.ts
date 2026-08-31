/**
 * Wire shapes for F05 `warehouse` — transcribed verbatim from CONTRACTS.md
 * §4.7 (inventory), §4.9 (replenishment), §4.10 (delivery / Surat Jalan),
 * §4.11 (purchasing — PO receiving), §4.12 (waste-return). Kept local to
 * `components/warehouse` (not `lib/shared-types`, W1-E's frozen seam) — same
 * choice `components/outlet/lib/types.ts` made, since these interfaces are
 * specific to this surface's screens. Where a shape overlaps with outlet's
 * (Balance, StorageArea, Item, ApprovalStep/Detail, Drop/DropLine), it is
 * redefined here rather than imported cross-surface, matching the ownership
 * split (W4-07 owns `components/outlet`, W4-08 owns `components/warehouse`).
 */
import type { Money, Qty, Temp, UUID, ISODate, ISODateTime } from '@/lib/shared-types';

// `Opname`/`OpnameLine` are imported straight from `@/lib/shared-types` (see
// that file's M08 section) rather than redeclared here — verified against
// the live backend response, unlike `PurchaseOrder` below.
export type { Opname, OpnameLine } from '@/lib/shared-types';

// ── §4.7 inventory ───────────────────────────────────────────────────────────

export interface Balance {
  locationId: UUID;
  storageAreaId: UUID;
  storageAreaName: string;
  storageAreaType: string;
  itemId: UUID;
  sku: string;
  itemName: string;
  unitCode: string;
  qtyOnHand: Qty;
  minQty: Qty | null;
  belowMin: boolean;
  value?: Money;
}

export interface Movement {
  id: UUID;
  movementType: string;
  qty: Qty;
  unitCost?: Money;
  refType: string;
  refId: UUID | null;
  storageAreaName: string;
  counterpartyLocationName: string | null;
  actorName: string | null;
  reason: string | null;
  occurredAt: ISODateTime;
}

// ── §4.3 location / storage area ────────────────────────────────────────────

export interface StorageArea {
  id: UUID;
  locationId: UUID;
  code: string;
  name: string;
  type: string;
  tempMin: Temp | null;
  tempMax: Temp | null;
  sortOrder: number;
  isActive: boolean;
}

// ── §4.4 item ────────────────────────────────────────────────────────────────

export interface Item {
  id: UUID;
  sku: string;
  name: string;
  categoryId: UUID | null;
  categoryName: string | null;
  baseUnit: { id: UUID; code: string };
  storageType: 'frozen' | 'chilled' | 'dry';
  isSellable: boolean;
  shelfLifeDays: number | null;
  tempMin: Temp | null;
  tempMax: Temp | null;
  barcode: string | null;
  isActive: boolean;
}

// ── §4.0 approvals ───────────────────────────────────────────────────────────

/**
 * D-30 (fixed 2026-08-23) — these two shapes are now IMPORTED, not restated.
 *
 * This module used to declare its own `ApprovalDetail`/`ApprovalStep`, and the
 * copy drifted exactly as duplicated contracts do: `currentStep` — the
 * documented "chain complete" signal, added to `@mimi/shared` precisely so
 * consumers would stop inferring completion by scanning `steps` for the first
 * `pending` entry — was added to the shared type and never reached here. The
 * fix landed in the contract and changed nothing, which is the whole lesson:
 * adding to a shared type achieves nothing if nobody imports from it.
 *
 * `ApprovalStep` is kept as a local ALIAS of the canonical
 * `ApprovalStepDetail` so the existing call sites in this module read
 * unchanged; the alias is a name, not a second definition.
 */
import type { ApprovalDetail, ApprovalStepDetail as ApprovalStep } from '@/lib/shared-types';

// Re-exported as well as imported: other files in this module import these two
// names from here, and the local bindings above are what the shapes further
// down this file refer to.
export type { ApprovalDetail, ApprovalStep };

// ── §4.9 replenishment ───────────────────────────────────────────────────────

export interface ReplenishmentLine {
  id: UUID;
  itemId: UUID;
  itemName: string;
  unitCode: string;
  storageType?: 'frozen' | 'chilled' | 'dry';
  qtyRequested: Qty;
  qtyApproved: Qty | null;
  qtyShipped: Qty | null;
  qtyReceived: Qty | null;
  amendReason: string | null;
}

export interface Replenishment {
  id: UUID;
  requestNumber: string;
  locationId: UUID;
  locationName: string;
  status: string;
  source: 'manual' | 'auto_suggestion';
  requestedBy: string;
  submittedAt: ISODateTime | null;
  neededBy: ISODate | null;
  sjId: UUID | null;
  sjNumber: string | null;
  approval: ApprovalDetail | null;
  lines: ReplenishmentLine[];
}

// ── §4.10 delivery ───────────────────────────────────────────────────────────
//
// `Drop`/`DropLine`/`Seal`/`TempLog`/`SuratJalan` used to be hand-rolled
// copies here (same shape as `@mimi/shared`'s, transcribed independently per
// this file's header comment about the outlet/warehouse ownership split).
// That copy had silently drifted: `TempLog.breachedClasses`/`ranges`
// (cold-chain breach detail — which class(es) a reading actually breached,
// and the range it was checked against, D-14/owner ruling 2026-08-17) were
// missing, so any warehouse code reading a `TempLog` off this local type
// could never see a breach's class detail even though the backend sends it.
// Flagged during F-DELIVERY's build (that surface always imported the
// canonical type via `@/lib/shared-types` and never hit this gap). Fixed the
// same way here now — import + re-export the verified canonical shapes
// instead of a second hand-rolled copy, per this file's own "redeclare only
// when genuinely outlet/warehouse-specific" rule; these five are not.
export type { SuratJalan, Drop, DropLine, Seal, TempLog } from '@/lib/shared-types';

export interface Driver {
  id: UUID;
  name: string;
  phone: string | null;
  licenseNumber: string | null;
  userId: UUID | null;
  isActive: boolean;
}

export interface Vehicle {
  id: UUID;
  plateNumber: string;
  type: string;
  hasFreezer: boolean;
  isActive: boolean;
}

export interface DailyRecapItem {
  itemId: UUID;
  itemName: string;
  qty: Qty;
}

/**
 * One drop destination. `sjCount` here is the DISTINCT Surat Jalan touching this
 * outlet, so the per-outlet counts do not sum to the city's — a multi-drop SJ
 * counts once for every outlet it visits.
 */
export interface DailyRecapOutlet {
  locationId: UUID;
  locationName: string;
  sjCount: number;
  dropCount: number;
  frozenSjCount: number;
  drySjCount: number;
  items: DailyRecapItem[];
}

export interface DailyRecapCity {
  city: string;
  outlets: number;
  sjCount: number;
  dropCount: number;
  frozenSjCount: number;
  drySjCount: number;
  items: DailyRecapItem[];
  byOutlet: DailyRecapOutlet[];
}

export interface DailyRecap {
  date: ISODate;
  sjCount: number;
  dropCount: number;
  byCity: DailyRecapCity[];
  frozenSjCount: number;
  drySjCount: number;
}

// ── §4.11 purchasing (PO receiving) ─────────────────────────────────────────

/**
 * `PurchaseOrder`/`PurchaseOrderLine` below are typed against
 * `apps/backend/src/modules/purchasing/purchase-order.service.ts`'s actual
 * `toListRow`/`toDetail` mappers (`PurchaseOrderListRow`/`PurchaseOrderDetail`
 * there), not blindly against CONTRACTS.md §4.11's `interface` block.
 *
 * HISTORY (F-WAREHOUSE): at the start of this pass, `toListRow`/`toDetail`
 * did NOT populate `approval`/`paymentStatus` at all — CONTRACTS (and
 * `@mimi/shared`'s `PurchaseOrder`, transcribed from the same block) had
 * drifted from the live response, and this file's `PurchaseOrder` had copied
 * that drift verbatim, so reading either field anywhere would have silently
 * been `undefined`. That was flagged as a latent bug rather than patched
 * from the frontend. Mid-pass, the backend concurrently landed both fields
 * for real (`purchase-order.service.ts`'s `loadApprovalDetail` +
 * `PurchaseOrderRepository`'s `payment_status` LEFT JOIN) — re-verified
 * against that live diff before typing the two fields below, per the
 * ticket's "confirm, don't assume" instruction. Current, verified shape:
 * - `approval`: `null` unconditionally on LIST rows (a per-document
 *   `kernel/approvals` round trip isn't paid for N list rows — same
 *   precedent `Replenishment`'s own list endpoint sets); populated for real
 *   only via `getDetail`/`receive` (the single-document path).
 * - `paymentStatus`: a plain LEFT JOIN column, so it IS populated on both
 *   list rows and detail (no N+1 concern for a single scalar).
 *
 * The list endpoint (`GET /purchasing/orders`, `listPurchaseOrders` below)
 * still returns a narrower row than the detail — no `lines`/`subtotal`/
 * `tax`/`paymentTermsDays`/`prId`/`cancelReason`/`notes`. Only
 * `getPurchaseOrder` (`GET /purchasing/orders/:id`) and `receivePurchaseOrder`
 * return the full `PurchaseOrder` detail shape. Kept as two interfaces
 * (mirroring the backend's own `PurchaseOrderListRow`/`PurchaseOrderDetail`
 * split) so a caller can't accidentally reach for `.lines` on a bare list
 * row, or assume `approval` is populated outside the detail view.
 */
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
  /** `null` on every list row — see this block's header comment. Real value only via `PurchaseOrder` (the detail shape). */
  approval: ApprovalDetail | null;
  /** Populated on list rows too (plain LEFT JOIN column) — `'rejected'` is a real linked-payment-verification status, not in the narrower `PaymentStatus` enum (same widening `PaymentVerification.status` already uses). */
  paymentStatus: string | null;
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
  /** `qtyOrdered - qtyReceived`, floored at 0 server-side (never negative on the wire). */
  qtyDifference: Qty;
}

export interface PurchaseOrder extends PurchaseOrderListRow {
  paymentTermsDays: number;
  subtotal: Money;
  tax: Money;
  prId: UUID | null;
  cancelReason: string | null;
  notes: string | null;
  lines: PurchaseOrderLine[];
}

// ── §4.6 supplier directory (name-only, role-locked prices) ────────────────

export interface SupplierDirectoryEntry {
  id: UUID;
  code: string;
  name: string;
  contactName: string | null;
  phone?: string | null;
}

// ── §4.12 waste-return (retur to supplier + retur from outlet) ─────────────

export interface ReturnLine {
  lineId: UUID;
  itemId: UUID;
  itemName: string;
  qty: Qty;
  condition: string;
  reason: string;
  qtyReceived: Qty | null;
}

export interface ReturnDoc {
  id: UUID;
  returnNumber: string;
  direction: string;
  fromLocationName: string;
  toLocationName: string | null;
  status: string;
  requestedBy: string;
  approvedBy: string | null;
  shippedAt: ISODateTime | null;
  receivedAt: ISODateTime | null;
  lines: ReturnLine[];
}

export interface ReturnDetail extends ReturnDoc {
  approval: ApprovalDetail | null;
  proofUrls: { shipped: string[]; received: string[] };
}

// ── §4.12 waste (verified against `waste.service.ts`'s `WasteListRow` — no
// `WasteRecord` export exists in `@mimi/shared` for this resource, unlike
// `Opname`/`OpnameLine` above, so it's declared locally same as outlet's) ──

export interface WasteRecord {
  id: UUID;
  wasteNumber: string;
  batchId: UUID;
  locationName: string;
  storageAreaName: string;
  itemName: string;
  qty: Qty;
  unitCost: Money;
  reason: string;
  status: string;
  reportedBy: string;
  photoUrls: string[];
  occurredAt: ISODateTime;
}
