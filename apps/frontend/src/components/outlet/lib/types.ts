/**
 * Wire shapes for F04 `outlet` — transcribed verbatim from CONTRACTS.md
 * §4.7–4.12 (inventory / stock-opname / replenishment / delivery / purchasing
 * petty-cash / waste-return). Kept local to `components/outlet` (not
 * `lib/shared-types`, which is W1-E's frozen seam) since these interfaces are
 * specific to this surface's screens.
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

// ── §4.8 stock-opname ────────────────────────────────────────────────────────

export interface Opname {
  id: UUID;
  opnameNumber: string;
  locationId: UUID;
  locationName: string;
  storageAreaId: UUID | null;
  status: string;
  countedBy: string;
  startedAt: ISODateTime;
  submittedAt: ISODateTime | null;
  approvedBy: string | null;
  approvedAt: ISODateTime | null;
  totalVarianceValue?: Money;
  lineCount: number;
  disputedCount: number;
}

export interface OpnameLine {
  id: UUID;
  storageAreaId: UUID;
  storageAreaName: string;
  itemId: UUID;
  itemName: string;
  unitCode: string;
  systemQty: Qty;
  countedQty: Qty;
  diffQty: Qty;
  varianceReason: string | null;
  disputed: boolean;
}

export interface OpnameDetail extends Opname {
  lines: OpnameLine[];
}

// ── §4.9 replenishment ───────────────────────────────────────────────────────

export interface ReplenishmentLine {
  id: UUID;
  itemId: UUID;
  itemName: string;
  unitCode: string;
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
  createdBy: string;
}

// ── §4.11 purchasing / petty cash ───────────────────────────────────────────

export interface PettyCashLine {
  description: string;
  itemId: UUID | null;
  storageAreaId?: UUID | null;
  qty: Qty | null;
  amount: Money;
  expenseCategory: string;
}

export interface PettyCash {
  id: UUID;
  pcNumber: string;
  locationId: UUID;
  purchasedBy: string;
  purchaseDate: ISODate;
  storeName: string;
  totalAmount: Money;
  status: string;
  verifiedBy: string | null;
  photoUrls: string[];
  lines: PettyCashLine[];
}

export interface SupplierDirectoryEntry {
  id: UUID;
  code: string;
  name: string;
  contactName: string | null;
  phone?: string | null;
}

// ── §4.12 waste-return ───────────────────────────────────────────────────────

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

export interface ReturnLine {
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
