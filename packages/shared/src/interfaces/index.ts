/**
 * API resource shapes — CONTRACTS.md §4, transcribed from the `interface`
 * blocks given per module. This is the CORE RESOURCE surface every module's
 * endpoints return (`Me`, `Location`, `Item`, `Balance`, `Replenishment`,
 * `SuratJalan`, `PurchaseOrder`, `Sale`, `PayrollRun`, `Account`, …) — it is
 * NOT a byte-for-byte transcription of all ~317 endpoints' request bodies
 * (query strings, PATCH partials, and one-off action payloads stay in
 * CONTRACTS.md §4 as the source of truth for exact request shapes). BFF
 * controllers and frontend API clients import these types; a shape here
 * drifting from CONTRACTS.md §4 is a contract bug the same way an enum value
 * drifting from §2 is.
 *
 * `ApprovalDetail` and `AuditRow` are the two kernel shapes (§4.0) most
 * modules embed.
 */
import type {
  DeliveryCadence,
  ApprovalState,
  ApprovalStepState,
  AssetCategory,
  AssetCondition,
  AssetStatus,
  DropStatus,
  LoanStatus,
  MaintenanceJobStatus,
  OnlineOrderStatus,
  OnlinePlatform,
  OpnameStatus,
  PaymentStatus,
  PayrollComponentCode,
  PayrollRunStatus,
  PettyCashStatus,
  PurchaseOrderStatus,
  ReplenishmentStatus,
  ReverificationStatus,
  SaleStatus,
  SealStatus,
  ShiftStatus,
  StorageAreaType,
  SuratJalanStatus,
} from '../enums';
import type { ISODate, ISODateTime, Money, Qty, Temp, UUID } from '../types';

// ── Kernel (§4.0) ──────────────────────────────────────────────────────────────

export interface ApprovalStepDetail {
  stepNo: number;
  approverRole: string;
  state: ApprovalStepState;
  actedBy: string | null;
  actedAt: ISODateTime | null;
  reason: string | null;
  offlineAuthorized: boolean;
  reverificationStatus: ReverificationStatus | null;
}

export interface ApprovalDetail {
  approvalId: UUID;
  state: ApprovalState;
  amount: Money | null;
  /**
   * The step number currently awaiting action, or `null` once the chain is
   * finalized (approved/rejected/cancelled) — the documented signal all
   * eight approvable modules key their finalization display on
   * (`kernel/approvals`'s `approvals.current_step`, now nullable, `NULL`ed on
   * finalise). Surfaced here so a consumer never has to reconstruct it by
   * scanning `steps` for the first `pending` entry — that reconstruction is
   * exactly the fragmentation this field exists to prevent before Wave 4/5's
   * frontend surfaces are written against this resource.
   */
  currentStep: number | null;
  steps: ApprovalStepDetail[];
}

export interface AuditRow {
  id: UUID;
  userId: UUID;
  userName: string;
  roleKey: string;
  module: string;
  action: string;
  entityType: string;
  entityId: UUID;
  beforeValue: object | null;
  afterValue: object | null;
  reason: string | null;
  offlineAuthorized: boolean;
  occurredAt: ISODateTime;
}

// ── M01 auth ───────────────────────────────────────────────────────────────────

export interface Me {
  id: UUID;
  username: string;
  name: string;
  roleKey: string;
  permissions: string[];
  locations: { id: UUID; code: string; name: string; type: 'warehouse' | 'outlet'; city: string }[];
  employeeId: UUID | null;
  mustSetPin: boolean;
}

export interface OfflineCredentialRes {
  credentialId: UUID;
  token: string;
  scopes: Record<string, { maxIdr?: Money }>;
  expiresAt: ISODateTime;
}

export interface LoginRes {
  accessToken: string;
  refreshToken: string;
  user: Me;
  offlineCredentials?: OfflineCredentialRes[];
}

// ── M02 users ──────────────────────────────────────────────────────────────────

export interface UserRow {
  id: UUID;
  username: string;
  name: string;
  email: string | null;
  phone: string | null;
  roleKey: string;
  roleName: string;
  locations: { id: UUID; name: string }[];
  isActive: boolean;
  lastLoginAt: ISODateTime | null;
  createdAt: ISODateTime;
}

// ── M03 location (incl. storage areas, D-15) ──────────────────────────────────

export interface Location {
  id: UUID;
  code: string;
  name: string;
  type: 'warehouse' | 'outlet';
  city: string;
  address: string | null;
  phone: string | null;
  latitude: string | null;
  longitude: string | null;
  /**
   * EFFECTIVE attendance geofence radius in metres — resolved server-side from
   * this location's own value, or `settings('hr.geofence_radius_m')` when it has
   * none (migration 229). Never null, so a client measuring an employee's
   * distance always has the same number the check-in endpoint will enforce.
   */
  geofenceRadiusM: number;
  /** True when this location overrides the default rather than inheriting it. */
  geofenceRadiusIsOverride: boolean;
  /**
   * FR-LOG-03 — the agreed replenishment frequency for this outlet, or `null`
   * when none has been agreed. `null` is a real state, not a missing value:
   * an outlet nobody has decided about must not read as the rarest schedule.
   * Always `null` on a warehouse, which ships rather than receives.
   */
  deliveryCadence: DeliveryCadence | null;
  isActive: boolean;
  storageAreaCount: number;
}

export interface StorageArea {
  id: UUID;
  locationId: UUID;
  code: string;
  name: string;
  type: StorageAreaType;
  tempMin: Temp | null;
  tempMax: Temp | null;
  sortOrder: number;
  isActive: boolean;
}

// ── M04 item ───────────────────────────────────────────────────────────────────

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
  /** Present only when the caller holds `supplier.price.read` (FR-SUP-06 role lock). */
  avgCost?: Money;
  lastPurchaseCost?: Money;
  barcode: string | null;
  isActive: boolean;
}

// ── M05 product (menu + recipes/BOM) ──────────────────────────────────────────

/**
 * A POS menu category (`product_categories`, migration 247). Was free text on
 * `products.category` until it needed renaming, reordering (it drives the till's
 * category chip row) and retiring without deleting the products under it.
 */
export interface ProductCategory {
  id: UUID;
  name: string;
  sortOrder: number;
  isActive: boolean;
  /** Products currently pointing at this category, active and inactive alike — what makes a delete unsafe. */
  productCount: number;
}

/** What a product IS, for the till and the back office (migration 248). */
export type ProductKind = 'product' | 'package';

/** One member of a package, in `Product.packageLines`. */
export interface ProductPackageLine {
  memberProductId: UUID;
  memberName: string;
  memberCode: string;
  qty: Qty;
  sortOrder: number;
}

export interface Product {
  id: UUID;
  code: string;
  name: string;
  /** Display name of the product's `product_categories` row — see `categoryId`. */
  category: string;
  categoryId: UUID;
  price: Money;
  /**
   * GoFood price, IDR. `null` when the product has no channel override set —
   * the till and the receipt then fall back to `price` for a GoFood sale.
   * Set higher than `price` to absorb the platform's commission (owner
   * decision, 2026-08-27) — there is deliberately no separate fee line.
   */
  priceGofood: Money | null;
  /** ShopeeFood price, IDR — same fallback-to-`price` rule as `priceGofood`. */
  priceShopeefood: Money | null;
  /**
   * A PRESIGNED, EXPIRING url (10 min, `StorageService.getUrl`) — fine for a
   * back-office form the user is looking at right now, useless for the till.
   * `null` when the product has no photo, and always `null` on the POS catalog
   * payload (see `photoPath`).
   */
  photoUrl: string | null;
  /**
   * A STABLE, api-relative path to a small cached thumbnail
   * (`/products/:id/photo`), or `null` when there is no photo.
   *
   * WHY BOTH: the POS catalog is precached and served offline for as long as
   * the device stays offline, so a presigned `photoUrl` would expire exactly
   * when the outlet needs it. This path never expires, so the till can fetch
   * each one once and keep the blob in IndexedDB. It is a PATH, not a url —
   * the api base differs between deployments (`NEXT_PUBLIC_API_URL`), so the
   * client joins it the same way it joins every other endpoint.
   */
  photoPath: string | null;
  sortOrder: number;
  isActive: boolean;
  /**
   * `'package'` means this sellable is composed of OTHER products
   * (`packageLines`) rather than carrying a recipe of its own. It still sells as
   * ONE sale line at its own `price` — see migration 248 for why a package is a
   * `products` row and what that costs in reporting.
   */
  kind: ProductKind;
  hasRecipe: boolean;
  /** Present (non-empty) only when `kind === 'package'`. Mutually exclusive with `recipeLines` — a package must not carry a recipe or its ingredients would be counted twice per sale (enforced by trigger, migration 248). */
  packageLines?: ProductPackageLine[];
  /**
   * Present (non-empty) only when `hasRecipe` — omitted/`undefined` otherwise.
   * Lets an offline POS device fold a completed sale into a local raw-material
   * usage estimate (FR-POS-06) WITHOUT a round trip: for each line, consumed
   * qty = `line.qty × (qtySold / recipeYieldQty)`, the exact ratio-then-
   * multiply `RecipeService.explodeForSale` uses server-side — never a flat
   * `line.qty × qtySold` (wrong whenever a batch recipe's yield isn't 1).
   * Deliberately a minimal projection of `recipe_lines` (id + qty + unit only,
   * no item name/unit code) to keep the precached catalog payload small.
   */
  recipeYieldQty?: Qty;
  recipeLines?: CatalogRecipeLine[];
}

/** Minimal per-line shape for `Product.recipeLines` — see that field's doc. */
export interface CatalogRecipeLine {
  itemId: UUID;
  qty: Qty;
  unitId: UUID;
}

export interface RecipeLine {
  itemId: UUID;
  itemName: string;
  qty: Qty;
  unitId: UUID;
  unitCode: string;
}

// ── M06 supplier (FR-SUP-01..06; D-20 directory split) ────────────────────────

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
  isActive: boolean;
}

/** D-20 — the column-limited projection `supplier.directory.read` returns to outlet roles (name/contact only, never price/termin). */
export interface SupplierDirectoryEntry {
  id: UUID;
  code: string;
  name: string;
  contactName: string | null;
  phone: string | null;
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

// ── M07 inventory ──────────────────────────────────────────────────────────────

export interface Balance {
  locationId: UUID;
  storageAreaId: UUID;
  storageAreaName: string;
  storageAreaType: StorageAreaType;
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

// ── M08 stock-opname (FR-SO-01..04) ───────────────────────────────────────────

export interface Opname {
  id: UUID;
  opnameNumber: string;
  locationId: UUID;
  locationName: string;
  storageAreaId: UUID | null;
  status: OpnameStatus;
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

// ── M09 replenishment (FR-LOG-06..13) ─────────────────────────────────────────

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
  status: ReplenishmentStatus;
  source: 'manual' | 'auto_suggestion';
  requestedBy: string;
  submittedAt: ISODateTime | null;
  neededBy: ISODate | null;
  sjId: UUID | null;
  sjNumber: string | null;
  approval: ApprovalDetail | null;
  lines: ReplenishmentLine[];
}

// ── M10 delivery — Surat Jalan, drops, cold chain (D-14) ──────────────────────

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

export interface TempLog {
  id: UUID;
  dropId: UUID | null;
  stage: 'load' | 'depart' | 'arrive';
  tempC: Temp;
  isBreach: boolean;
  /**
   * Present only when `isBreach` — which cold-chain goods class(es) this
   * single reading breached. Per the owner's ruling (2026-08-17): one
   * `frozen`-shipment-type truck is "the cold-chain vehicle" and routinely
   * carries BOTH frozen (-25..-15°C) and chilled (0..5°C) cargo at once, so
   * the backend evaluates the one physical reading against every class
   * still onboard (`cold-chain.service.ts`'s `resolveOnboardClassRanges`)
   * rather than a single static range — a mixed load can breach one class,
   * both, or neither on the same reading. Lets the driver's screen say
   * "barang beku" vs "barang chiller" instead of a bare "breach", which is
   * the difference between checking one pallet and checking the whole
   * load 200 km from Balikpapan.
   *
   * Field names mirror `sj_temperature_logs.notes`'s JSON shape exactly
   * (`cold-chain.service.ts`, the authoritative persisted shape) —
   * deliberately not renamed/reshaped in transit, the same reason every
   * other wire shape in this campaign stayed field-for-field with its
   * shipped counterpart rather than being redescribed at each boundary.
   */
  breachedClasses?: ('frozen' | 'chilled')[];
  /** The range each breached class was checked against, at `storage_areas` (D-15) — origin-warehouse ranges, not a single static shipment-type range (that assumption is stale; see `../constants`'s `DEFAULT_COLD_CHAIN_FROZEN_RANGE`). Keyed by the same classes as `breachedClasses`. */
  ranges?: Partial<Record<'frozen' | 'chilled', { min: Temp | null; max: Temp | null }>>;
  loggedBy: string;
  loggedAt: ISODateTime;
}

export interface Seal {
  id: UUID;
  dropId: UUID | null;
  sealNumber: string;
  status: SealStatus;
  checkedBy: string | null;
  checkedAt: ISODateTime | null;
}

export interface Drop {
  id: UUID;
  dropSeq: number;
  locationId: UUID;
  locationName: string;
  city: string;
  /** Street address of the destination, for the driver's stop card and as the
   * text fallback when a location has no coordinates to navigate to. */
  address: string | null;
  /** Destination coordinates, used to launch the driver's map app and to plot
   * the stop on the dispatcher's route map. Null when a location predates the
   * geocoding of the site list — the UI must degrade to `address` text. */
  latitude: number | null;
  longitude: number | null;
  /** The destination's own phone number, so the driver can call ahead from the
   * stop card instead of hunting for it. Sourced from `locations.phone`, which
   * every outlet already had — it simply was never selected. */
  phone: string | null;
  /** Per-stop delivery brief written by gudang before dispatch (access notes,
   * who to call, unloading bay). Written by the WAREHOUSE, unlike
   * `discrepancyNotes`, which the driver writes after the fact. */
  deliveryInstructions: string | null;
  replenishmentRequestId: UUID | null;
  status: DropStatus;
  departedAt: ISODateTime | null;
  arrivedAt: ISODateTime | null;
  receivedBy: string | null;
  receivedAt: ISODateTime | null;
  signatureUrl: string | null;
  photoUrls: string[];
  discrepancyNotes: string | null;
  lines: DropLine[];
}

/** One GPS breadcrumb from a truck on a dispatched Surat Jalan (migration 221). */
export interface SjPosition {
  latitude: number;
  longitude: number;
  accuracyM: number | null;
  speedKph: number | null;
  headingDeg: number | null;
  /** When the DEVICE took the fix. Offline-queued pings flush late, so this is
   * the field to trust for ordering and for "how stale is this truck". */
  recordedAt: ISODateTime;
  /** When the cloud accepted it. Differs from `recordedAt` across an offline
   * stretch — the gap is what distinguishes lost signal from a stopped truck. */
  receivedAt: ISODateTime;
}

/** A truck currently on the road, for the dispatcher's live board. */
export interface LiveDelivery {
  sjId: UUID;
  sjNumber: string;
  driverId: UUID | null;
  driverName: string | null;
  vehiclePlate: string | null;
  status: string;
  dispatchedAt: ISODateTime | null;
  totalDrops: number;
  completedDrops: number;
  /** Null until the driver's phone reports its first fix — a dispatched truck
   * with no position is normal for the first minute, and permanent if the
   * driver denied the browser's location permission. */
  lastPosition: SjPosition | null;
}

export interface SuratJalan {
  id: UUID;
  sjNumber: string;
  originLocationId: UUID;
  shipmentType: 'frozen' | 'dry';
  driver: { id: UUID; name: string; phone: string | null };
  vehicle: { id: UUID; plateNumber: string; hasFreezer: boolean };
  status: SuratJalanStatus;
  plannedDate: ISODate;
  dispatchedAt: ISODateTime | null;
  completedAt: ISODateTime | null;
  drops: Drop[];
  seals: Seal[];
  tempLogs: TempLog[];
  createdBy: string;
}

// ── M11 purchasing (petty cash 8.6.1) ─────────────────────────────────────────

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
  status: PurchaseOrderStatus;
  orderDate: ISODate;
  expectedDate: ISODate | null;
  paymentTermsDays: number;
  subtotal: Money;
  tax: Money;
  total: Money;
  approval: ApprovalDetail | null;
  paymentStatus: PaymentStatus | null;
  lines: PurchaseOrderLine[];
}

export interface PettyCash {
  id: UUID;
  pcNumber: string;
  locationId: UUID;
  purchasedBy: string;
  purchaseDate: ISODate;
  storeName: string;
  totalAmount: Money;
  status: PettyCashStatus;
  verifiedBy: string | null;
  photoUrls: string[];
  lines: {
    description: string;
    itemId: UUID | null;
    qty: Qty | null;
    amount: Money;
    expenseCategory: string;
  }[];
}

// ── M12 waste-return ───────────────────────────────────────────────────────────

export interface Return {
  id: UUID;
  returnNumber: string;
  direction: 'outlet_to_warehouse' | 'warehouse_to_supplier';
  fromLocationName: string;
  toLocationName: string | null;
  supplierName: string | null;
  status: string;
  requestedBy: string;
  approvedBy: string | null;
  shippedAt: ISODateTime | null;
  receivedAt: ISODateTime | null;
  lines: {
    itemId: UUID;
    itemName: string;
    qty: Qty;
    condition: string;
    reason: string;
    qtyReceived: Qty | null;
  }[];
}

// ── M13 pos (FR-POS-01..07) ────────────────────────────────────────────────────

export interface Shift {
  id: UUID;
  shiftNumber: string;
  locationId: UUID;
  deviceId: UUID | null;
  openedBy: string;
  openedAt: ISODateTime;
  openingCash: Money;
  status: ShiftStatus;
  closedAt: ISODateTime | null;
  closingCashCounted: Money | null;
  expectedCash: Money | null;
  cashVariance: Money | null;
  salesCount: number;
  grossSales: Money;
}

/**
 * Which counter a sale was rung up under (migration 249, owner decision
 * 2026-08-27). `'walk_in'` is the till default; a cashier ringing up a
 * phoned-in/app-relayed GoFood or ShopeeFood order picks the other two —
 * there is no separate online-order flow any more (see `Sale.channel`'s
 * doc). String values match `sales`'s CHECK constraint character-for-character.
 */
export type SaleChannel = 'walk_in' | 'gofood' | 'shopeefood';

export interface Sale {
  id: UUID;
  receiptNumber: string;
  locationId: UUID;
  shiftId: UUID;
  kasirName: string;
  status: SaleStatus;
  /**
   * Which channel this sale was rung up under — drives which of a product's
   * three prices `lines[].unitPrice` was taken from at the time of sale
   * (never re-derived from `Product.price` after the fact). Replaces the
   * separate GoFood/ShopeeFood online-order flow: retired 2026-08-27, see
   * `OnlineOrder`'s doc.
   */
  channel: SaleChannel;
  subtotal: Money;
  discount: Money;
  total: Money;
  paidAmount: Money;
  changeAmount: Money;
  offlineCreated: boolean;
  occurredAt: ISODateTime;
  lines: {
    productId: UUID;
    productName: string;
    qty: Qty;
    unitPrice: Money;
    discount: Money;
    lineTotal: Money;
  }[];
  payments: {
    method: string;
    amount: Money;
    reference: string | null;
    paymentStatus: PaymentStatus;
  }[];
}

/**
 * FR-POS-05/07's manual GoFood/ShopeeFood entry — RETIRED as the primary
 * revenue path, 2026-08-27 owner decision. GoFood/ShopeeFood orders are now
 * rung up as an ordinary POS `Sale` with `channel` set (three-tier channel
 * pricing, migration 249), which — unlike this shape — actually explodes a
 * recipe and consumes stock. This interface, the `online_orders` table and
 * `GET /pos/online-orders` are left DORMANT, not dropped: 152+ historical
 * rows are real reporting history, and the create path still exists for a
 * pre-cutover offline device's queued sync backlog. No NEW GL journal entry
 * is posted from this flow any more (see `pos-online-order.service.ts`'s
 * header) — the channel `Sale` is the only revenue record going forward.
 */
export interface OnlineOrder {
  id: UUID;
  locationId: UUID;
  platform: OnlinePlatform;
  orderRef: string;
  orderDate: ISODate;
  grossAmount: Money;
  discountAmount: Money;
  platformFee: Money;
  otherFee: Money;
  netReceived: Money;
  status: OnlineOrderStatus;
}

/** D-19 / Amendment 2 — the outlet-visible read shape (`pos.cash_variance.read`). */
export interface CashVarianceProposal {
  id: UUID;
  shiftId: UUID;
  locationId: UUID;
  kasirName: string;
  amount: Money;
  status: string;
  decidedBy: string | null;
  decidedAt: ISODateTime | null;
  decisionReason: string | null;
}

// ── M14 hr ─────────────────────────────────────────────────────────────────────

export interface Employee {
  id: UUID;
  employeeNumber: string;
  userId: UUID | null;
  name: string;
  position: string;
  locationId: UUID;
  locationName: string;
  employmentStatus: string;
  joinDate: ISODate;
  phone: string | null;
}

export interface AttendanceRow {
  id: UUID;
  employeeId: UUID;
  employeeName: string;
  locationName: string;
  date: ISODate;
  status: string;
  checkInAt: ISODateTime | null;
  checkOutAt: ISODateTime | null;
  lateMinutes: number;
  overtimeMinutes: number;
  geofenceOk: boolean;
  selfieUrls: { in: string | null; out: string | null };
  timeSuspect: boolean;
}

// ── M15 payroll (D-18 statutory additions) ────────────────────────────────────

export interface PayslipLineRes {
  componentCode: PayrollComponentCode;
  componentName: string;
  type: 'earning' | 'deduction' | 'employer_cost';
  isStatutory: boolean;
  qty: Qty | null;
  rate: Money | null;
  amount: Money;
  sourceRefType: string | null;
  manualOverride: boolean;
}

export interface Payslip {
  runId: UUID;
  periodCode: string;
  employee: { id: UUID; name: string; position: string; locationName: string };
  lines: PayslipLineRes[];
  gross: Money;
  deductions: Money;
  net: Money;
  employerCost: Money;
  slipPdfUrl: string | null;
}

export interface PayrollRun {
  id: UUID;
  runNumber: string;
  periodCode: string;
  status: PayrollRunStatus;
  statutoryMode: boolean;
  employeeCount: number;
  totalGross: Money;
  totalDeductions: Money;
  totalNet: Money;
  totalEmployerCost: Money;
  calculatedAt: ISODateTime | null;
  approval: ApprovalDetail | null;
  paidAt: ISODateTime | null;
}

export interface EmployeeLoan {
  id: UUID;
  loanNumber: string;
  employeeName: string;
  principal: Money;
  monthlyInstallment: Money;
  outstanding: Money;
  status: LoanStatus;
}

/** Amendment 1 — the wizard's readiness check (`GET /api/payroll/statutory/status`). */
export interface StatutoryStatus {
  enabled: boolean;
  ready: boolean;
  enabledAt: ISODateTime | null;
  enabledBy: string | null;
  missing: ('bpjs_configs' | 'pph21_ter_rates' | 'pph21_ptkp' | 'employee_tax_profiles')[];
  profileCoverage: { withProfile: number; total: number };
}

// ── M16 asset (FR-PMS-01..04) ──────────────────────────────────────────────────

export interface Asset {
  id: UUID;
  assetNumber: string;
  name: string;
  category: AssetCategory;
  locationName: string;
  serialNumber: string | null;
  brand: string | null;
  model: string | null;
  purchaseDate: ISODate | null;
  purchasePrice?: Money;
  condition: AssetCondition;
  status: AssetStatus;
  assignedToName: string | null;
  photoUrl: string | null;
}

export interface MaintenanceJob {
  id: UUID;
  jobNumber: string;
  assetName: string;
  type: string;
  status: MaintenanceJobStatus;
  dueDate: ISODate | null;
  assignedToName: string | null;
  completedAt: ISODateTime | null;
  cost: Money | null;
  proofUrls: string[];
}

// ── M17 accounting (D-04 GL) ───────────────────────────────────────────────────

export interface Account {
  id: UUID;
  code: string;
  name: string;
  type: string;
  normalBalance: 'debit' | 'credit';
  parentId: UUID | null;
  isPostable: boolean;
  isSystem: boolean;
  isActive: boolean;
}

export interface JournalEntry {
  id: UUID;
  entryNumber: string;
  entryDate: ISODate;
  eventType: string | null;
  source: 'system' | 'manual';
  refType: string | null;
  refId: UUID | null;
  locationName: string | null;
  description: string;
  status: 'posted' | 'reversed';
  lines: {
    lineNo: number;
    accountCode: string;
    accountName: string;
    debit: Money;
    credit: Money;
    memo: string | null;
  }[];
}

export interface PaymentVerification {
  id: UUID;
  pvNumber: string;
  refType: string;
  refId: UUID | null;
  refNumber: string | null;
  payeeType: string;
  payeeName: string | null;
  amount: Money;
  status: PaymentStatus | 'rejected';
  proofUrl: string | null;
  referenceNumber: string | null;
  submittedBy: string;
  verifiedBy: string | null;
  verifiedAt: ISODateTime | null;
  paidBy: string | null;
  paidAt: ISODateTime | null;
  paidVia: string | null;
  locationName: string | null;
}

/** D-17 / SYNC-PROTOCOL §7.5 — the finance exception queue (`GET /api/accounting/exceptions`). */
export interface OfflineAuthCase {
  id: UUID;
  class: 'offline_auth_failed' | 'offline_auth_unprovable';
  documentType: string;
  documentId: UUID;
  amount: Money | null;
  approverName: string;
  deviceName: string;
  outletName: string;
  occurredAt: ISODateTime;
  relayReceivedAt: ISODateTime;
  evidence: { selfieUrl: string | null; pinAttempts: number | null };
  physicalEffectSuspected: boolean;
  outcome: string;
  verdict: 'upheld' | 'rejected' | null;
}
