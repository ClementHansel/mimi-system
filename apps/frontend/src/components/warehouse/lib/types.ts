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

export interface ApprovalStep {
  stepNo: number;
  approverRole: string;
  state: 'pending' | 'approved' | 'rejected' | 'skipped';
  actedBy: string | null;
  actedAt: ISODateTime | null;
  reason: string | null;
  offlineAuthorized: boolean;
  reverificationStatus: 'verified' | 'failed' | 'unprovable' | null;
}

export interface ApprovalDetail {
  approvalId: UUID;
  state: string;
  amount: Money | null;
  steps: ApprovalStep[];
}

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

export interface DropLine {
  id: UUID;
  itemId: UUID;
  itemName: string;
  unitCode: string;
  storageType: 'frozen' | 'chilled' | 'dry';
  qty: Qty;
  qtyReceived: Qty | null;
  receivedStorageAreaId: UUID | null;
  discrepancyReason: string | null;
}

export interface Drop {
  id: UUID;
  dropSeq: number;
  locationId: UUID;
  locationName: string;
  city: string;
  replenishmentRequestId: UUID | null;
  status: string;
  departedAt: ISODateTime | null;
  arrivedAt: ISODateTime | null;
  receivedBy: string | null;
  receivedAt: ISODateTime | null;
  signatureUrl: string | null;
  photoUrls: string[];
  discrepancyNotes: string | null;
  lines: DropLine[];
}

export interface Seal {
  id: UUID;
  dropId: UUID | null;
  sealNumber: string;
  status: string;
  checkedBy: string | null;
  checkedAt: ISODateTime | null;
}

export interface TempLog {
  id: UUID;
  dropId: UUID | null;
  stage: 'load' | 'depart' | 'arrive';
  tempC: Temp;
  isBreach: boolean;
  loggedBy: string;
  loggedAt: ISODateTime;
}

export interface SuratJalan {
  id: UUID;
  sjNumber: string;
  originLocationId: UUID;
  shipmentType: 'frozen' | 'dry';
  driver: { id: UUID; name: string; phone: string | null };
  vehicle: { id: UUID; plateNumber: string; hasFreezer: boolean };
  status: string;
  plannedDate: ISODate;
  dispatchedAt: ISODateTime | null;
  completedAt: ISODateTime | null;
  drops: Drop[];
  seals: Seal[];
  tempLogs: TempLog[];
  createdBy: string;
}

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

export interface DailyRecap {
  date: ISODate;
  sjCount: number;
  dropCount: number;
  byCity: { city: string; outlets: number; items: { itemId: UUID; itemName: string; qty: Qty }[] }[];
  frozenSjCount: number;
  drySjCount: number;
}

// ── §4.11 purchasing (PO receiving) ─────────────────────────────────────────

export interface PurchaseOrderLine {
  id: UUID;
  itemId: UUID;
  itemName: string;
  unitCode: string;
  qtyOrdered: Qty;
  unitPrice: Money;
  lineTotal: Money;
  qtyReceived: Qty;
}

export interface PurchaseOrder {
  id: UUID;
  poNumber: string;
  supplierId: UUID;
  supplierName: string;
  locationId: UUID;
  status: string;
  orderDate: ISODate;
  expectedDate: ISODate | null;
  paymentTermsDays: number;
  subtotal: Money;
  tax: Money;
  total: Money;
  approval: ApprovalDetail | null;
  paymentStatus: string | null;
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
