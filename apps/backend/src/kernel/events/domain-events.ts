/**
 * Domain event catalogue for the in-process `EventBus` (kernel/events).
 *
 * A domain event is something that already happened, expressed past-tense,
 * carrying enough data for a subscriber to react without re-querying the
 * originating module. Modules PUBLISH; they never import each other to call
 * a sibling's service directly — that is the whole point of this kernel
 * (BUILD-PLAN §5 Wave 2 W2-C, referenced by W2-A `StockLedgerService` and by
 * W4-03's accounting posting-rule engine).
 *
 * Adding a new event type: append its literal to `DomainEventType` and its
 * payload shape to `DomainEventPayloadMap`, then publish via
 * `EventBus.publish('your.event.type', payload)` — the payload argument is
 * type-checked against the map entry.
 */

/** `StockLedgerService.post()` emits one of these per movement it commits (D-07). */
export interface StockMovedPayload {
  movementId: string;
  locationId: string;
  storageAreaId: string;
  itemId: string;
  movementType: string;
  /** Signed delta actually applied to `stock_balances.qty_on_hand` (positive for `_in`, negative for `_out`). */
  qtyDelta: string;
  unitCost: string;
  refType: string;
  refId: string | null;
  mode: 'strict' | 'fact';
  actorId: string | null;
  occurredAt: string;
}

/** Emitted by M04/M06 price-maintenance flows; consumed by low-stock/reporting surfaces. */
export interface ProductPriceChangedPayload {
  productId: string;
  oldPrice: string;
  newPrice: string;
  changedBy: string | null;
  occurredAt: string;
}

/** Emitted by the approvals kernel (W2-B) on every state transition. */
export interface ApprovalDecidedPayload {
  approvalId: string;
  documentType: string;
  documentId: string;
  state: 'approved' | 'rejected' | 'cancelled';
  stepNo: number;
  actedBy: string | null;
  reason: string | null;
  occurredAt: string;
}

/**
 * Fired by any module completing a domain action the GL posting-rule engine
 * (W4-03, M17) is declared to react to (CONTRACTS.md §6.2's 16 event types).
 * Deliberately generic (`eventType` + `amount` + free-form `context`) because
 * the posting-rule table itself is data-driven — see `packages/shared/src/gl/posting-rules.ts`.
 * W4-03 subscribes to this ONE event type rather than to 16 module-specific
 * ones so a new posting rule never requires touching every emitting module.
 */
export interface JournalableActionPayload {
  /** Matches a `JournalEventType` / `JournalSystemEventType` value from `@mimi/shared`. */
  eventType: string;
  documentType: string;
  documentId: string;
  locationId: string | null;
  amount: string;
  context: Record<string, unknown>;
  occurredAt: string;
}

/** Emitted by M21 device-registry's staleness sweep — feeds `outlet_offline` notifications and F12 topology. */
export interface DeviceStatusChangedPayload {
  deviceId: string;
  locationId: string | null;
  previousStatus: string;
  status: string;
  occurredAt: string;
}

export interface DomainEventPayloadMap {
  'stock.moved': StockMovedPayload;
  'product.price_changed': ProductPriceChangedPayload;
  'approval.decided': ApprovalDecidedPayload;
  'journal.action': JournalableActionPayload;
  'device.status_changed': DeviceStatusChangedPayload;
}

export type DomainEventType = keyof DomainEventPayloadMap;

/** The envelope every subscriber receives — never just the bare payload, so `type`/`occurredAt` travel with it. */
export interface DomainEvent<T extends DomainEventType = DomainEventType> {
  type: T;
  occurredAt: string;
  payload: DomainEventPayloadMap[T];
}
