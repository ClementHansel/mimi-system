/**
 * The payload schema registry — one entry per `(entity, op)` that actually
 * crosses the wire (SYNC-PROTOCOL §2.3, §3.3). Scoped to exactly the entities
 * `../authority-matrix.ts` classifies M/F/B (`wireEligibleEntities()`) —
 * class D/X/T entities need no payload schema because they are never a
 * sync event at all.
 *
 * Shapes are derived from CONTRACTS.md §1 (DDL) and §4 (API interfaces),
 * translated to the wire's camelCase/decimal-string convention (§0). Every
 * genuinely uncertain reading is marked `// AMBIGUOUS:` inline and listed in
 * the W1-B report for the architect to settle — see that report rather than
 * assuming a marked field is definitely wrong; it means CONTRACTS.md didn't
 * pin it down, not that this guess is known-bad.
 *
 * Fields already carried by the sync envelope itself (`event_id`, `entity`,
 * `entity_id`, `location_id`, `actor_user_id`, `occurred_at` — see `../types`)
 * are NOT repeated inside a payload unless CONTRACTS.md's REST body for the
 * same action independently includes them (e.g. a client-minted `clientId`
 * used for idempotency, which is a business field, not an envelope field).
 */
import {
  AssetCategory,
  AssetCondition,
  DeviceCategory,
  DiscoverySource,
  ItemStorageType,
  LeaveType,
  LocationType,
  MaintenanceJobType,
  OnlineOrderStatus,
  OnlinePlatform,
  PaymentMethod,
  ReplenishmentSource,
  ReturnCondition,
  ReturnDirection,
  ShipmentType,
  StorageAreaType,
  SuratJalanStatus,
  TempLogStage,
  VoidRefundType,
  WasteReason,
} from '@mimi/shared';
import {
  array,
  boolean,
  enumOf,
  isoDate,
  isoDateTime,
  money,
  nullable,
  number,
  object,
  optional,
  qty,
  string,
  temp,
  unknownField,
  uuid,
  type ObjectField,
} from './dsl';

// ── Reusable field fragments ───────────────────────────────────────────────────

const id = () => uuid();
/** Every device-born fact carries the client-minted idempotency id in its payload body (SYNC-PROTOCOL §2.2) in addition to the envelope's own `event_id`. */
const clientId = () => uuid();

/** `{ id }` — the near-universal shape of a `deactivated`/`retired`/`removed`/`cancelled` op on a master-data or simple document entity. */
const idOnly = () => object({ id: id() });
const reasonOnly = () => object({ reason: string() });
const noteOptional = () => object({ note: optional(string()) });

// ── Group 1 — Identity, org, config (block 001-009) ──────────────────────────

const locationFields = {
  id: id(),
  code: string(),
  name: string(),
  type: enumOf(Object.values(LocationType)),
  city: string(),
  address: nullable(string()),
  phone: nullable(string()),
  latitude: nullable(string()),
  longitude: nullable(string()),
  geofenceRadiusM: number(),
  timezone: string(),
  isActive: boolean(),
};

const storageAreaFields = {
  id: id(),
  locationId: uuid(),
  code: string(),
  name: string(),
  type: enumOf(Object.values(StorageAreaType)),
  tempMin: nullable(temp()),
  tempMax: nullable(temp()),
  sortOrder: number(),
  isActive: boolean(),
};

/**
 * `users` is class M but field-projected (SYNC-PROTOCOL §3.2): a device
 * receives id/name/role/active/location-ids/PIN-verifier-hash — never
 * password hash, email, phone, or session data. This schema enforces that
 * projection boundary structurally: a payload carrying `email`/`passwordHash`
 * still validates (additive-only — extra fields aren't rejected), but the
 * required shape below is what a compliant projector actually sends.
 */
const userProjectedFields = {
  id: id(),
  name: string(),
  roleKey: string(),
  locationIds: array(uuid()),
  isActive: boolean(),
  pinVerifierHash: nullable(string()),
};

export const GROUP_1_SCHEMAS = {
  'locations.created': object(locationFields),
  'locations.updated': object(locationFields),
  'locations.deactivated': idOnly(),

  'storage_areas.created': object(storageAreaFields),
  'storage_areas.updated': object(storageAreaFields),
  'storage_areas.deactivated': idOnly(),

  'users.created': object(userProjectedFields),
  'users.updated': object(userProjectedFields),
  'users.deactivated': idOnly(),
  'users.pin_rotated': object({ id: id(), pinVerifierHash: string() }),

  'roles.updated': object({ id: id(), key: string(), name: string() }),
  'permissions.updated': object({ id: id(), key: string(), description: nullable(string()) }),
  // AMBIGUOUS: CONTRACTS.md doesn't specify whether role_permissions.updated ships an
  // incremental grant/revoke or a full per-role snapshot; modeled as a full snapshot
  // (matches SYNC-PROTOCOL §2.3's "complete documents, not row diffs" default).
  'role_permissions.updated': object({ roleKey: string(), permissionKeys: array(string()) }),

  'user_locations.assigned': object({ userId: uuid(), locationId: uuid() }),
  'user_locations.revoked': object({ userId: uuid(), locationId: uuid() }),

  'notifications.issued': object({
    id: id(),
    userId: uuid(),
    type: string(),
    title: string(),
    body: nullable(string()),
    payload: unknownField(),
    locationId: nullable(uuid()),
  }),
  'notifications.read': object({ id: id() }),
  'notifications.read_marked': object({ id: id(), readAt: isoDateTime() }),

  'settings.updated': object({ key: string(), value: unknownField() }),
} as const;

// ── Group 2 — Catalog (block 010-019) ────────────────────────────────────────

const itemCategoryFields = {
  id: id(),
  name: string(),
  parentId: nullable(uuid()),
  sortOrder: number(),
  isActive: boolean(),
};
const unitFields = { id: id(), code: string(), name: string(), isActive: boolean() };
// AMBIGUOUS: `unit_conversions.factor` is NUMERIC(14,6) — a scale our Money(2)/Qty(3)/
// Temp(1) field kinds don't cover. Validated only as a generic decimal-looking string
// here (no scale check) until/unless a dedicated 6-scale field kind is added.
const unitConversionFields = {
  id: id(),
  itemId: nullable(uuid()),
  fromUnitId: uuid(),
  toUnitId: uuid(),
  factor: string(),
};
const itemFields = {
  id: id(),
  sku: string(),
  name: string(),
  categoryId: nullable(uuid()),
  baseUnitId: uuid(),
  storageType: enumOf(Object.values(ItemStorageType)),
  isSellable: boolean(),
  shelfLifeDays: nullable(number()),
  tempMin: nullable(temp()),
  tempMax: nullable(temp()),
  avgCost: money(),
  lastPurchaseCost: money(),
  barcode: nullable(string()),
  isActive: boolean(),
};
const productCategoryFields = {
  id: id(),
  name: string(),
  sortOrder: number(),
  isActive: boolean(),
};
const packageLineField = object({ memberProductId: uuid(), qty: qty() });
const productFields = {
  id: id(),
  code: string(),
  name: string(),
  // The category NAME, joined from `product_categories` since migration 247 —
  // still a string on the wire so a device's cached catalog keeps its shape, but
  // `categoryId` is the key a write sends back.
  category: string(),
  categoryId: uuid(),
  price: money(),
  photoAttachmentId: nullable(uuid()),
  sortOrder: number(),
  kind: string(),
  isActive: boolean(),
  // `product_package_lines` rides EMBEDDED on the parent product (authority
  // matrix), the same way `recipe_lines` rides on RECIPES: a package's
  // membership is meaningless apart from the package, and a till that applied
  // one without the other would briefly hold a bundle it cannot explode into
  // stock usage. Optional because a plain product has none.
  packageLines: optional(array(packageLineField)),
};
const recipeLineField = object({ itemId: uuid(), qty: qty(), unitId: uuid() });

export const GROUP_2_SCHEMAS = {
  'item_categories.created': object(itemCategoryFields),
  'item_categories.updated': object(itemCategoryFields),
  'item_categories.deactivated': idOnly(),

  'units.created': object(unitFields),
  'units.updated': object(unitFields),
  'units.deactivated': idOnly(),

  'unit_conversions.created': object(unitConversionFields),
  'unit_conversions.updated': object(unitConversionFields),
  'unit_conversions.deactivated': idOnly(),

  'items.created': object(itemFields),
  'items.updated': object(itemFields),
  'items.deactivated': idOnly(),

  'product_categories.created': object(productCategoryFields),
  'product_categories.updated': object(productCategoryFields),
  'product_categories.deactivated': idOnly(),

  'products.created': object(productFields),
  'products.updated': object(productFields),
  'products.deactivated': idOnly(),
  'products.price_changed': object({ id: id(), price: money(), previousPrice: money() }),

  'recipes.updated': object({
    productId: uuid(),
    yieldQty: qty(),
    notes: nullable(string()),
    isActive: boolean(),
    lines: array(recipeLineField),
  }),
} as const;

// ── Group 3 — Stock (block 020-029; D-16 territory — balances/movements are class D, no schema) ──

const opnameLineField = object({
  itemId: uuid(),
  systemQty: qty(),
  countedQty: qty(),
  varianceReason: optional(string()),
});

export const GROUP_3_SCHEMAS = {
  'min_stock_rules.updated': object({
    id: id(),
    locationId: uuid(),
    itemId: uuid(),
    minQty: qty(),
    reorderQty: nullable(qty()),
    isActive: boolean(),
  }),

  'stock_opname.opened': object({
    id: id(),
    opnameNumber: string(),
    locationId: uuid(),
    storageAreaId: nullable(uuid()),
    countedBy: uuid(),
    startedAt: isoDateTime(),
  }),
  'stock_opname.area_counted': object({
    opnameId: uuid(),
    storageAreaId: uuid(),
    lines: array(opnameLineField),
  }),
  'stock_opname.submitted': object({ opnameId: uuid(), submittedAt: isoDateTime() }),
  'stock_opname.cancelled': object({ opnameId: uuid() }),
  'stock_opname.approved': object({
    opnameId: uuid(),
    approvedBy: uuid(),
    approvedAt: isoDateTime(),
  }),
  'stock_opname.rejected': object({ opnameId: uuid(), reason: string() }),

  /**
   * The entity the coordinator named directly: `stock_adjustments.posted`.
   * Cloud-born only (§3.3 group 3) — created after an opname/manual approval,
   * consumed identically by the shared projector (`../stock-projector.ts`'s
   * `explodeAdjustmentToMovements` takes exactly this `direction` field).
   */
  'stock_adjustments.posted': object({
    id: id(),
    locationId: uuid(),
    storageAreaId: uuid(),
    itemId: uuid(),
    qtyDelta: qty(),
    unitCost: money(),
    reason: string(),
    source: enumOf(['opname', 'manual', 'reconciliation'] as const),
    direction: enumOf(['shortage', 'overage'] as const),
    opnameId: nullable(uuid()),
  }),
} as const;

// ── Group 4 — Replenishment & logistics (block 030-039) ──────────────────────

const replenishmentLineField = object({ itemId: uuid(), qtyRequested: qty(), unitId: uuid() });
const amendmentField = object({ lineId: uuid(), qtyApproved: qty(), reason: string() });

const sjDropLineField = object({
  itemId: uuid(),
  qty: qty(),
  unitId: uuid(),
  requestLineId: optional(uuid()),
});
const sjDropField = object({
  id: uuid(),
  dropSeq: number(),
  locationId: uuid(),
  replenishmentRequestId: nullable(uuid()),
  lines: array(sjDropLineField),
});

const receivedLineField = object({
  lineId: uuid(),
  qtyReceived: qty(),
  receivedStorageAreaId: uuid(),
  discrepancyReason: optional(string()),
});

export const GROUP_4_SCHEMAS = {
  'replenishment_requests.submitted': object({
    id: id(),
    requestNumber: string(),
    locationId: uuid(),
    neededBy: nullable(isoDate()),
    source: enumOf(Object.values(ReplenishmentSource)),
    lines: array(replenishmentLineField),
  }),
  'replenishment_requests.cancelled': idOnly(),
  'replenishment_requests.supervisor_approved': object({
    id: id(),
    note: optional(string()),
    amendments: optional(array(amendmentField)),
  }),
  'replenishment_requests.supervisor_approved_offline': object({
    id: id(),
    amendments: optional(array(amendmentField)),
  }),
  'replenishment_requests.supervisor_rejected': object({ id: id(), reason: string() }),
  'replenishment_requests.warehouse_approved': object({
    id: id(),
    note: optional(string()),
    amendments: optional(array(amendmentField)),
  }),
  'replenishment_requests.warehouse_rejected': object({ id: id(), reason: string() }),
  'replenishment_requests.amended': object({ id: id(), lines: array(amendmentField) }),
  'replenishment_requests.fulfillment_started': idOnly(),
  'replenishment_requests.shipped': object({ id: id(), sjId: uuid() }),
  'replenishment_requests.completed': idOnly(),

  'surat_jalan.issued': object({
    id: id(),
    sjNumber: string(),
    originLocationId: uuid(),
    shipmentType: enumOf(Object.values(ShipmentType)),
    driverId: uuid(),
    vehicleId: uuid(),
    plannedDate: isoDate(),
    drops: array(sjDropField),
  }),
  // RESOLVED (was AMBIGUOUS — confirmed by W3-07, the surat_jalan owner): `updated` is a FULL
  // snapshot, mirroring `issued`'s shape exactly (id/sjNumber/originLocationId/shipmentType/
  // driverId/vehicleId/plannedDate/drops) plus the three fields that only exist post-issue
  // (status/dispatchedAt/completedAt). Three reasons this reading wins over the earlier
  // partial-patch guess:
  //  (1) every OTHER `*.updated` op in this entire registry (locations, storage_areas, users,
  //      items, products, vehicles, drivers, ...) is a full snapshot — SYNC-PROTOCOL §2.3's
  //      stated default ("complete documents, not row diffs... one event = one atomically-
  //      appliable business fact"). A partial patch for exactly this one entity would be the
  //      only exception in the file, with no stated reason to deviate.
  //  (2) `surat_jalan` is class B / pull-only (cloud-authoritative, driver+outlet devices only
  //      ever RECEIVE this event, never author one) — a receiving device has no prior local
  //      copy to "patch" the first time it sees a given SJ during a `ready`/`load`/`dispatch`
  //      transition if its cache was ever cold-started or dropped a delivery; a full snapshot
  //      is self-sufficient exactly like `issued` is, and never orphans a partial edit.
  //  (3) M10's own server-side implementation (`surat-jalan.service.ts` / `drop.service.ts`)
  //      emits every `updated` this way: SJ `ready`/`load`/`dispatch`/completion and a drop
  //      `fail` (which has no wire op of its own — see `drop.service.ts`'s `emitSjUpdated`) all
  //      publish the CURRENT FULL document, never a sparse diff of only the touched columns.
  'surat_jalan.updated': object({
    id: id(),
    sjNumber: string(),
    originLocationId: uuid(),
    shipmentType: enumOf(Object.values(ShipmentType)),
    driverId: uuid(),
    vehicleId: uuid(),
    status: enumOf(Object.values(SuratJalanStatus)),
    plannedDate: isoDate(),
    dispatchedAt: nullable(isoDateTime()),
    completedAt: nullable(isoDateTime()),
    drops: array(sjDropField),
  }),
  'surat_jalan.cancelled': object({ id: id(), reason: string() }),

  'sj_drops.departed': object({ dropId: uuid(), at: isoDateTime(), tempC: optional(temp()) }),
  'sj_drops.arrived': object({
    dropId: uuid(),
    at: isoDateTime(),
    tempC: temp(),
    sealCheck: optional(
      object({
        sealId: uuid(),
        status: enumOf(['verified_intact', 'broken'] as const),
        notes: optional(string()),
      }),
    ),
  }),
  'sj_drops.received': object({
    dropId: uuid(),
    lines: array(receivedLineField),
    photoAttachmentIds: array(uuid()),
    signatureAttachmentId: uuid(),
    tempC: optional(temp()),
    discrepancyNotes: optional(string()),
    // Additive (SYNC-PROTOCOL §2.3 — optional, no version bump): `sj_drops.client_id UUID UNIQUE`
    // (migration 034, "driver/outlet offline idempotency") already exists for exactly this purpose but had
    // no payload field to carry it. A receipt is the one `sj_drops` fact with a stock/business effect
    // consequential enough to dedupe on a client-supplied id INDEPENDENT of the sync envelope's own
    // `eventId` guarantee (a client retry that, due to a bug, mints a fresh `eventId` for a resend would
    // otherwise double-post stock) — see `DeliverySyncProjector`'s `applyReceive` core, which checks this
    // before `event.eventId` as a fallback.
    clientId: optional(uuid()),
  }),

  'sj_temperature_logs.logged': object({
    sjId: uuid(),
    dropId: optional(uuid()),
    stage: enumOf(Object.values(TempLogStage)),
    tempC: temp(),
  }),

  'sj_seals.applied': object({
    id: id(),
    sjId: uuid(),
    dropId: nullable(uuid()),
    sealNumber: string(),
  }),

  'drivers.created': object({
    id: id(),
    name: string(),
    phone: nullable(string()),
    licenseNumber: nullable(string()),
    userId: nullable(uuid()),
    isActive: boolean(),
  }),
  'drivers.updated': object({
    id: id(),
    name: string(),
    phone: nullable(string()),
    licenseNumber: nullable(string()),
    userId: nullable(uuid()),
    isActive: boolean(),
  }),
  'drivers.deactivated': idOnly(),

  'vehicles.created': object({
    id: id(),
    plateNumber: string(),
    type: string(),
    brand: nullable(string()),
    model: nullable(string()),
    hasFreezer: boolean(),
    isActive: boolean(),
  }),
  'vehicles.updated': object({
    id: id(),
    plateNumber: string(),
    type: string(),
    brand: nullable(string()),
    model: nullable(string()),
    hasFreezer: boolean(),
    isActive: boolean(),
  }),
  'vehicles.deactivated': idOnly(),

  'goods_receipts.recorded': object({
    id: id(),
    locationId: uuid(),
    lines: array(object({ itemId: uuid(), qty: qty(), storageAreaId: uuid(), unitCost: money() })),
    photoAttachmentIds: array(uuid()),
    notes: optional(string()),
  }),

  'shipment_types.updated': object({
    id: id(),
    key: enumOf(Object.values(ShipmentType)),
    name: string(),
    requiresTemperatureLog: boolean(),
    requiresSeal: boolean(),
    tempMin: nullable(temp()),
    tempMax: nullable(temp()),
  }),
} as const;

// ── Group 5 — Purchasing & petty cash (block 040-049; PR/PO/receipts are class X, no schema) ──

export const GROUP_5_SCHEMAS = {
  'petty_cash.recorded': object({
    id: id(),
    locationId: uuid(),
    purchasedBy: uuid(),
    purchaseDate: isoDate(),
    storeName: string(),
    lines: array(
      object({
        description: string(),
        itemId: nullable(uuid()),
        storageAreaId: optional(uuid()),
        qty: nullable(qty()),
        amount: money(),
        expenseCategory: string(),
      }),
    ),
    paymentProofAttachmentId: uuid(),
    goodsPhotoAttachmentId: uuid(),
  }),
  'petty_cash.verified': noteOptional(),
  'petty_cash.rejected': reasonOnly(),
} as const;

// ── Group 6 — POS (block 050-059) ─────────────────────────────────────────────

export const GROUP_6_SCHEMAS = {
  // CORRECTED by W3-08 (pos): both `opened` and `sales.completed` gained an optional
  // `shiftNumber`/`receiptNumber` field. Original shapes had neither, which is a real gap, not a
  // stylistic omission: SYNC-PROTOCOL §1.5 is explicit that device-born document numbers are
  // "assigned locally and final — a printed nota is never renumbered on sync." A device prints the
  // shift/sales report and receipt using ITS OWN locally-assigned number the moment the action
  // commits (§2.2's atomic outbox rule) — long before the event ever reaches the cloud. If the wire
  // never carried that number, the cloud projector's only option would be to allocate its OWN
  // number at projection time, which would silently diverge from what is already printed on paper.
  // `optional()` (additive, no `v` bump per §2.3) rather than required: a hand-built test event or a
  // future non-printing origin (e.g. a kiosk with no printer) may legitimately omit it, in which
  // case the projector allocates its own as a documented fallback — never the primary path for a
  // real device.
  'pos_shifts.opened': object({
    clientId: clientId(),
    locationId: uuid(),
    deviceId: optional(uuid()),
    openingCash: money(),
    openedAt: isoDateTime(),
    shiftNumber: optional(string()),
  }),
  'pos_shifts.closed': object({
    closingCashCounted: money(),
    notes: optional(string()),
    closedAt: optional(isoDateTime()),
  }),

  'sales.completed': object({
    clientId: clientId(),
    locationId: uuid(),
    shiftId: uuid(),
    occurredAt: isoDateTime(),
    lines: array(
      object({ productId: uuid(), qty: qty(), unitPrice: money(), discount: optional(money()) }),
    ),
    payments: array(
      object({
        method: enumOf(Object.values(PaymentMethod)),
        amount: money(),
        reference: optional(string()),
        proofAttachmentId: optional(uuid()),
      }),
    ),
    /**
     * The sale-level manual discount, EXCLUDING any voucher.
     *
     * That exclusion is a contract, not a description, and it is the reason
     * `voucher` below carries its own `discount`. The server recomputes the
     * voucher's worth from its own copy of the batch rules and ADDS it to this
     * number (`PosSaleService.applySaleFact`), so a device that folded the
     * coupon into `discount` as well would have it counted twice. See
     * `CreateSaleDto.discount`'s doc for the same statement on the REST side.
     */
    discount: optional(money()),
    receiptNumber: optional(string()),
    /**
     * `VoucherRedemptionDraft` — the coupon this sale was rung with, if any.
     * Additive, so no `v` bump (§2.3): a build that predates vouchers simply
     * omits it.
     *
     * `discount` here is what the DEVICE calculated. It is recorded and
     * compared, never trusted — the server prices the coupon itself and raises
     * a reconciliation exception when the two disagree. `offlineAccepted` says
     * the till took it while it could not reach the cloud, which is the flag
     * `pos.voucher_offline` is consulted about.
     */
    voucher: optional(
      object({
        code: string(),
        discount: money(),
        offlineAccepted: boolean(),
      }),
    ),
  }),

  'void_refunds.requested': object({
    clientId: clientId(),
    type: enumOf(Object.values(VoidRefundType)),
    reason: string(),
    amount: optional(money()),
  }),
  // CONFIRMED by W3-08 (pos, CONTRACTS.md §4.13): this three-op split is correct as modeled, not
  // merely plausible. Reasoning, so a future editor doesn't second-guess it without re-deriving:
  //  - `approved_offline`'s and `approved`'s own `payload.data` are legitimately `{}`. The
  //    offline-provisional evidence (credential id, binding HMAC, PIN telemetry, selfie ref,
  //    `amountIdr`) rides in the envelope's `meta.authorization` (SYNC-PROTOCOL §2.3/§7.3) —
  //    duplicating it into `payload.data` would be redundant, not "more complete". Unlike sibling
  //    chains (`waste_records.approved(_offline)`, `replenishment_requests.supervisor_approved`),
  //    void/refund's own `POST /api/pos/void-refunds/:id/approve` request body carries no optional
  //    `note` field in CONTRACTS.md §4.13 (only `{pin}`, which is a local PIN-verification input —
  //    never itself synced) — so there is no sibling business field to add here either. Actor +
  //    timestamp already travel as envelope fields (`actorUserId`, `occurredAt`); nothing else about
  //    a bare decision is a "fact" of its own.
  //  - `executed{cashReturned}` is a genuinely SEPARATE fact from the decision, always device-
  //    pushed (`AUTHORITY.void_refunds.pushOps` includes it, `approved`/`rejected` don't): the
  //    decision can be made on a different device/session than the one holding the physical cash
  //    drawer (a supervisor approving from a laptop after reconnecting, while the original kasir
  //    tablet was offline), and R7 (shift-close cash reconciliation) needs the actual cash handed
  //    back, not the approved amount, which can differ in a partial-refund edge case. Collapsing
  //    it into `approved`'s payload would force the approving actor to also be the one reporting
  //    the physical handover, which is not always true.
  'void_refunds.approved_offline': object({}),
  'void_refunds.approved': object({}),
  'void_refunds.rejected': reasonOnly(),
  'void_refunds.executed': object({ cashReturned: money() }),

  'online_orders.recorded': object({
    clientId: clientId(),
    locationId: uuid(),
    platform: enumOf(Object.values(OnlinePlatform)),
    orderRef: string(),
    orderDate: isoDate(),
    grossAmount: money(),
    discountAmount: money(),
    platformFee: money(),
    otherFee: money(),
    netReceived: money(),
    status: enumOf(Object.values(OnlineOrderStatus)),
    items: optional(array(object({ productId: uuid(), qty: qty() }))),
    shiftId: optional(uuid()),
  }),
  'online_orders.status_updated': object({ status: enumOf(Object.values(OnlineOrderStatus)) }),
} as const;

// ── Group 7 — HR & payroll (block 060-069; employments/salary/loans/payroll_* are class X) ──

/** `employees` is class M, field-projected (§3.2): id/name/position/location/active only — never salary, bank/KTP, or loan state. */
const employeeProjectedFields = {
  id: id(),
  name: string(),
  position: string(),
  locationId: uuid(),
  isActive: boolean(),
};

export const GROUP_7_SCHEMAS = {
  'employees.created': object(employeeProjectedFields),
  'employees.updated': object(employeeProjectedFields),
  'employees.deactivated': idOnly(),

  'work_shifts.updated': object({
    id: id(),
    locationId: nullable(uuid()),
    name: string(),
    startTime: string(),
    endTime: string(),
    breakMinutes: number(),
    isActive: boolean(),
  }),

  'shift_assignments.assigned': object({
    id: id(),
    employeeId: uuid(),
    workShiftId: nullable(uuid()),
    locationId: uuid(),
    date: isoDate(),
  }),
  'shift_assignments.changed': object({
    id: id(),
    employeeId: uuid(),
    workShiftId: nullable(uuid()),
    locationId: uuid(),
    date: isoDate(),
  }),
  'shift_assignments.removed': idOnly(),

  'attendance.checked_in': object({
    clientId: clientId(),
    locationId: uuid(),
    lat: string(),
    lng: string(),
    accuracyM: number(),
    selfieAttachmentId: uuid(),
    deviceId: optional(uuid()),
    at: optional(isoDateTime()),
  }),
  'attendance.checked_out': object({
    clientId: clientId(),
    locationId: uuid(),
    lat: string(),
    lng: string(),
    accuracyM: number(),
    selfieAttachmentId: uuid(),
    deviceId: optional(uuid()),
    at: optional(isoDateTime()),
  }),

  'leave_requests.submitted': object({
    clientId: clientId(),
    type: enumOf(Object.values(LeaveType)),
    startDate: isoDate(),
    endDate: isoDate(),
    reason: optional(string()),
    attachmentId: optional(uuid()),
  }),
  'leave_requests.cancelled': idOnly(),
  'leave_requests.approved': noteOptional(),
  'leave_requests.rejected': reasonOnly(),
} as const;

// ── Group 8 — Assets (block 070-079; service_history is class D, no schema) ──

export const GROUP_8_SCHEMAS = {
  'assets.created': object({
    id: id(),
    assetNumber: string(),
    name: string(),
    category: enumOf(Object.values(AssetCategory)),
    locationId: uuid(),
    serialNumber: optional(string()),
    brand: optional(string()),
    model: optional(string()),
    purchaseDate: optional(isoDate()),
    condition: enumOf(Object.values(AssetCondition)),
  }),
  'assets.updated': object({
    id: id(),
    assetNumber: string(),
    name: string(),
    category: enumOf(Object.values(AssetCategory)),
    locationId: uuid(),
    serialNumber: optional(string()),
    brand: optional(string()),
    model: optional(string()),
    purchaseDate: optional(isoDate()),
    condition: enumOf(Object.values(AssetCondition)),
  }),
  'assets.retired': object({ id: id(), reason: optional(string()) }),

  'maintenance_schedules.updated': object({
    id: id(),
    assetId: uuid(),
    name: string(),
    intervalType: enumOf(['days', 'months'] as const),
    intervalValue: number(),
    nextDueAt: isoDate(),
    reminderDaysBefore: number(),
    isActive: boolean(),
  }),

  'maintenance_jobs.created': object({
    id: id(),
    assetId: uuid(),
    scheduleId: nullable(uuid()),
    type: enumOf(Object.values(MaintenanceJobType)),
    dueDate: nullable(isoDate()),
  }),
  'maintenance_jobs.completed': object({
    proofAttachmentIds: array(uuid()),
    cost: optional(money()),
    vendor: optional(string()),
    conditionAfter: enumOf(Object.values(AssetCondition)),
    odometerKm: optional(number()),
    notes: optional(string()),
  }),
} as const;

// ── Group 9 — Waste & returns (block 080-089) ─────────────────────────────────

const wasteLineField = object({
  storageAreaId: uuid(),
  itemId: uuid(),
  qty: qty(),
  reason: enumOf(Object.values(WasteReason)),
  reasonDetail: optional(string()),
});
const returnLineField = object({
  itemId: uuid(),
  storageAreaId: uuid(),
  qty: qty(),
  condition: enumOf(Object.values(ReturnCondition)),
  reason: string(),
});
const returnReceivedLineField = object({
  lineId: uuid(),
  qtyReceived: qty(),
  storageAreaId: uuid(),
});

export const GROUP_9_SCHEMAS = {
  'waste_records.reported': object({
    batchId: uuid(),
    locationId: uuid(),
    items: array(wasteLineField),
    photoAttachmentIds: array(uuid()),
  }),
  'waste_records.approved_offline': noteOptional(),
  'waste_records.approved': noteOptional(),
  'waste_records.rejected': reasonOnly(),

  'returns.submitted': object({
    id: id(),
    direction: enumOf(Object.values(ReturnDirection)),
    fromLocationId: uuid(),
    toLocationId: optional(uuid()),
    supplierId: optional(uuid()),
    lines: array(returnLineField),
    photoAttachmentIds: array(uuid()),
  }),
  'returns.shipped_back': object({ proofAttachmentIds: array(uuid()) }),
  'returns.approved': noteOptional(),
  'returns.rejected': reasonOnly(),
  'returns.received_at_warehouse': object({
    lines: array(returnReceivedLineField),
    proofAttachmentIds: array(uuid()),
  }),
} as const;

// ── Group 10 — Accounting (block 090-099; GL/COA/PR/PO are class D/X, no schema) ──

export const GROUP_10_SCHEMAS = {
  'payment_verifications.verified': object({ verifiedBy: uuid(), verifiedAt: isoDateTime() }),
  'payment_verifications.paid': object({
    paidBy: uuid(),
    paidAt: isoDateTime(),
    paidVia: string(),
  }),
  'payment_verifications.rejected': reasonOnly(),
} as const;

// ── Group 12 — Devices & topology (block 110-119; device_heartbeats is class T, no schema) ──

/**
 * RESOLVED by W3-10 (`device-registry`/`node-gateway`, the owning modules for this group —
 * BUILD-PLAN §1 carried item 2). Settled against the REAL endpoint bodies/response shapes M21/M22
 * implement (CONTRACTS.md §4.21/§4.22), not the earlier speculative guesses:
 *
 * - The registration HANDSHAKE itself (pairing token + fingerprint -> deviceId/nodeId + long-lived
 *   token) is an authenticated REST exchange (`POST /api/devices/register`, `POST /api/nodes/register`)
 *   and never a sync event — a device/node has no durable credential to push with until AFTER it
 *   completes. `devices.registered`/`branch_nodes.registered` below are emitted CLOUD-ORIGIN
 *   (`SyncEmitService`, SYNC-PROTOCOL §1.5's "cloud is just another privileged origin") by the
 *   registration handler itself, once the row exists — bookkeeping/audit facts for anything
 *   subscribed to that location's master-data stream, not a device-authored push.
 * - `devices.profile_updated`/`.renamed`/`.retired`/`.revoked` mirror `PATCH /api/devices/:id`,
 *   `POST /api/devices/:id/retire`, and `POST /api/devices/:id/unpair` field-for-field (M21 treats
 *   "unpair" as the kill-switch semantics SYNC-PROTOCOL §3.3 group 12 documents for `revoked` —
 *   "must stop pushing and wipe credentials" — since the AUTHORITY op vocabulary has no separate
 *   `unpaired` op; `retired` is the distinct, permanent, non-kill-switch terminal state).
 * - `branch_nodes.cert_rotated` intentionally carries ONLY `dnsName`/`expiresAt` — never `pem`/
 *   `keyPem`. Private key material rides exclusively over the node's own `/bridge` socket
 *   (`CertRotated` in `apps/branch-node/src/bridge-types.ts`), a side-channel exactly like §4.7's
 *   attachment binaries, never the durable-forever `sync_events` log a compromised subscriber could
 *   later read. `branch_nodes`' `pullScope: 'none'` (AUTHORITY) means this entry is cloud-side
 *   audit/forensics only (`GET /api/sync/events`) and is never delivered as a sync fact to anyone.
 * - `device_events`/`discovered_devices`: M21/M22 write these tables directly (CONTRACTS.md's own
 *   `GET /api/nodes/:id/discovered-devices` etc. are plain queryable rows, not event-sourced state,
 *   and no projector exists anywhere to turn an applied sync event back into a table row for
 *   either entity) — these schemas stay defined for wire completeness/a future projector, but the
 *   CURRENT implementation does not route heartbeat-derived or discovery telemetry through the
 *   generic sync-ingest pipeline. Field shapes below are corrected to match the real
 *   `DiscoveryReportItem` (`apps/branch-node/src/bridge-types.ts`) and the CONTRACTS §7.2 heartbeat
 *   threshold fields (`usedMb`/`quotaMb`, matching the coordinator's settled heartbeat-field
 *   ruling) rather than the earlier generic guesses.
 */
export const GROUP_12_SCHEMAS = {
  'devices.registered': object({
    fingerprint: string(),
    category: enumOf(Object.values(DeviceCategory)),
    locationId: uuid(),
    replacesDeviceId: optional(uuid()),
  }),
  'devices.profile_updated': object({
    name: optional(string()),
    category: optional(enumOf(Object.values(DeviceCategory))),
    locationId: optional(uuid()),
  }),
  'devices.paired': object({ locationId: uuid(), nodeLanUrl: nullable(string()) }),
  'devices.renamed': object({ name: string() }),
  'devices.retired': object({ replacedByDeviceId: optional(uuid()) }),
  'devices.revoked': object({ reason: optional(string()) }),

  'branch_nodes.registered': object({ locationId: uuid(), hostname: string(), version: string() }),
  'branch_nodes.paired': object({ lanUrl: nullable(string()) }),
  'branch_nodes.config_updated': object({ config: unknownField() }),
  'branch_nodes.cert_rotated': object({ dnsName: string(), expiresAt: isoDateTime() }),
  'branch_nodes.revoked': object({ reason: optional(string()) }),

  'device_events.storage_warning': object({ usedMb: number(), quotaMb: number() }),
  'device_events.storage_full': object({}),
  'device_events.quarantine_added': object({ quarantinedEventId: uuid(), code: string() }),
  'device_events.clock_suspect': object({ offsetMs: number() }),
  'device_events.credential_denied': object({ credentialId: optional(uuid()), reason: string() }),
  'device_events.went_online': object({}),
  'device_events.went_offline': object({}),
  'device_events.stale': object({}),
  // OUTLET-level edges (not device-level), raised by
  // `staleness-sweep.service.ts`'s `sweepOutlets()` when every active device
  // AND the node at a location have been dark past OUTLET_OFFLINE_AFTER_MS.
  //
  // These were MISSING while the sweep emitted them anyway, so every firing
  // hit `'device_events.outlet_offline' is not a known op` and was swallowed
  // by the emit's own `.catch(logger.warn)`. The user-visible half still
  // worked — the `device_events` row, the Owner/Manager notification and the
  // `topology:update` broadcast all fire on a different path — so the only
  // casualty was the sync pipeline: a branch node or any other `sync_events`
  // consumer never learned that an outlet had gone dark. Deterministic, not
  // intermittent, and silent by construction. Found by the W6-06 soak spec.
  //
  // Payload is `object({})` to match the sibling edges above; the sweep sends
  // `data: {}` and the interesting context (`darkForMs`) is already on the
  // `device_events` row it writes alongside.
  'device_events.outlet_offline': object({}),
  'device_events.outlet_online': object({}),

  'discovered_devices.discovered': object({
    ipAddress: string(),
    macAddress: nullable(string()),
    source: enumOf(Object.values(DiscoverySource)),
    vendor: nullable(string()),
    model: nullable(string()),
    suggestedCategory: nullable(string()),
    suggestedName: nullable(string()),
  }),
  'discovered_devices.updated': object({
    ipAddress: string(),
    macAddress: nullable(string()),
    vendor: nullable(string()),
    model: nullable(string()),
    suggestedCategory: nullable(string()),
    suggestedName: nullable(string()),
  }),
  'discovered_devices.disappeared': object({ ipAddress: string(), macAddress: nullable(string()) }),
} as const;

// ── Group 13 — Sync infrastructure (block 120-129) ────────────────────────────

export const GROUP_13_SCHEMAS = {
  'offline_authorizations.used': object({
    credentialId: uuid(),
    documentType: string(),
    documentId: uuid(),
    action: string(),
    amount: optional(money()),
  }),
  'offline_authorizations.revoked': object({ credentialId: uuid(), reason: string() }),
} as const;

/** The full registry, keyed `"<entity>.<op>"`, scoped to exactly the wire-eligible entities. */
export const PAYLOAD_SCHEMAS = {
  ...GROUP_1_SCHEMAS,
  ...GROUP_2_SCHEMAS,
  ...GROUP_3_SCHEMAS,
  ...GROUP_4_SCHEMAS,
  ...GROUP_5_SCHEMAS,
  ...GROUP_6_SCHEMAS,
  ...GROUP_7_SCHEMAS,
  ...GROUP_8_SCHEMAS,
  ...GROUP_9_SCHEMAS,
  ...GROUP_10_SCHEMAS,
  ...GROUP_12_SCHEMAS,
  ...GROUP_13_SCHEMAS,
} satisfies Record<string, ObjectField>;
