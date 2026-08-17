/**
 * Public types for `StockLedgerService` (D-07, D-15, D-16, D-16a, D-17a).
 * See `stock-ledger.service.ts` for the class itself; this file is the
 * shape every caller (M07 inventory, M08 opname, M09 replenishment, M10
 * delivery, M12 waste-return, M13 pos, kernel/sync, …) codes against.
 */
import type { StockKey } from '@mimi/sync-protocol';
import type { ISODateTime, Money, MovementType, Qty, ReconciliationTier, UUID } from '@mimi/shared';

/**
 * One postable movement — the caller's-eye view of a `stock_movements` row
 * (CONTRACTS.md §1.3 block 021). Mirrors `@mimi/sync-protocol`'s
 * `MovementFact` (same `factId`/`movementType`/`qty`/`unitCost` shape) plus
 * the DB-only columns the shared projector doesn't need: `counterparty_*`,
 * `actorId`, `reason`, `syncEventId`.
 *
 * IDEMPOTENCY: dedup is keyed on `(refType, refId, itemId, storageAreaId,
 * movementType)` when `refId` is non-null — this is the same granularity as
 * `factId` (`${eventId}:${discriminator}:${itemId}`) but expressed in terms
 * of columns that actually exist on `stock_movements` (there is no `fact_id`
 * column — see the report's note on `sync_event_id`). Replaying the exact
 * same movement (e.g. a sync batch redelivered) is therefore a no-op, not a
 * duplicate row. When `refId` is null (rare — a movement with no backing
 * business record) every call inserts; the caller owns dedup in that case.
 */
export interface PostMovementInput extends StockKey {
  /** Caller-facing idempotency label, purely for logging/debugging — NOT a DB column. Prefer `${refId}:${discriminator}:${itemId}` to match `@mimi/sync-protocol`'s `MovementFact.factId` convention. */
  factId?: string;
  movementType: MovementType;
  /** Always positive; sign is derived from the type suffix (`_in`/`_out`) — matches the `stock_movements.qty > 0` CHECK. */
  qty: Qty;
  unitCost: Money;
  refType: string;
  refId: UUID | null;
  /** Transfers: the other side of a cross-location move. */
  counterpartyLocationId?: UUID | null;
  /** Transfers/area moves: the other side of a same-location cross-area move. */
  counterpartyStorageAreaId?: UUID | null;
  actorId: UUID | null;
  reason?: string | null;
  /**
   * Populated on the row ONLY when it is safe under the DB's `UNIQUE`
   * constraint — i.e. this value does not repeat elsewhere in the same
   * `post()` call (see the service's `assignSyncEventIds` and the report's
   * note on why a fact that explodes into N movements cannot give all N the
   * same `sync_event_id`).
   */
  syncEventId?: UUID | null;
  occurredAt?: ISODateTime;
}

export interface PostedMovement {
  /** `stock_movements.id` — either the newly inserted row, or the pre-existing row when this call was an idempotent no-op replay. */
  id: UUID;
  key: StockKey;
  movementType: MovementType;
  qty: Qty;
  balanceAfter: Qty;
  /** `true` only in `fact` mode when this movement drove the key's balance negative (C5). */
  wentNegative: boolean;
  /** `true` when an identical movement (same natural key) already existed and this call inserted nothing new. */
  skippedAsDuplicate: boolean;
}

export interface StockLedgerPostResult {
  movements: PostedMovement[];
  /** Final balance per stock key touched by this call, keyed by `stockKeyOf` (`@mimi/sync-protocol`). */
  balances: Map<string, Qty>;
  /** `stock_reconciliations.id`s opened by this call (fact-mode negative balances, C5). Empty in `strict` mode by construction. */
  reconciliationsOpened: UUID[];
}

/** Thrown by `post()` in `strict` mode when a movement would drive its balance negative (C5's online-strict-mode branch). Maps to HTTP 422 via `UnprocessableEntityException` — see the exception filter, CONTRACTS.md §0. */
export class StockInsufficientError extends Error {
  readonly code = 'ERR_STOCK_INSUFFICIENT' as const;
  constructor(
    message: string,
    readonly key: StockKey,
    readonly movement: PostMovementInput,
  ) {
    super(message);
    this.name = 'StockInsufficientError';
  }
}

/** Thrown for a malformed request the DB CHECK constraints would otherwise reject less legibly (e.g. `qty <= 0`). Maps to HTTP 422 `ERR_VALIDATION`. */
export class StockMovementValidationError extends Error {
  readonly code = 'ERR_VALIDATION' as const;
  constructor(message: string) {
    super(message);
    this.name = 'StockMovementValidationError';
  }
}

// ── Transfers (paired movements with counterparty_* set) ─────────────────────

/** `(location, storage area)` — half of a transfer, without the item (that's shared between both sides). */
export interface AreaRef {
  locationId: UUID;
  storageAreaId: UUID;
}

export interface TransferInput {
  itemId: UUID;
  from: AreaRef;
  to: AreaRef;
  qty: Qty;
  unitCost: Money;
  refType: string;
  refId: UUID | null;
  actorId: UUID | null;
  reason?: string | null;
  occurredAt?: ISODateTime;
}

// ── Reconciliation (R1/R2, C5, physical-count checks feeding stock_reconciliations) ──

export interface ReconciliationResult {
  key: StockKey;
  expectedQty: Qty;
  storedQty: Qty;
  divergence: Qty;
  matches: boolean;
  /** Set only when `matches` is false and a `stock_reconciliations` row was opened. */
  reconciliationId?: UUID;
}

export interface ReconcileOptions {
  tier?: ReconciliationTier;
  /** Free-form context merged into `stock_reconciliations.detail` (e.g. `{ source: 'physical_count', opnameId }` or `{ source: 'tier_checksum', reportedTier: 'device' }`). */
  detail?: Record<string, unknown>;
}
