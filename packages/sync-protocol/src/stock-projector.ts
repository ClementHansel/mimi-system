/**
 * The shared stock projector — D-16a, the three-tier-critical deliverable
 * (BUILD-PLAN §5 row W1-B; property T-02, SYNC-PROTOCOL §9.1).
 *
 * D-16/D-16a in one sentence: `stock_balances` AND `stock_movements` are
 * never synced — every tier (device, node, cloud) independently derives BOTH
 * from the same applied FACT stream (a sale, a receipt, a count, a transfer)
 * using this exact code. `StockLedgerService` (`apps/backend/src/kernel/
 * stock-ledger`, D-07) calls into this module rather than reimplementing it —
 * that is what makes "cloud-derived === node-derived === device-derived at
 * the same cursor horizon" true by construction instead of by discipline.
 *
 * Two layers:
 *  1. `explode*ToMovements` — pure translators from one applied business FACT
 *     (a sale, a drop receipt, a waste approval, ...) into the `MovementFact`
 *     rows it produces. `StockLedgerService.post(tx, movements, mode)`
 *     (CONTRACTS.md §0) takes exactly this shape as its `movements` argument
 *     — the projector's natural unit is the movement, matching that contract.
 *  2. `foldMovementsToBalances` — the actual projector: movements → balances.
 *     Deduped by `factId` (so replaying the same fact twice, or delivering it
 *     out of order relative to others, changes nothing — T-01/T-02), and
 *     using plain signed-integer summation (`@mimi/shared`'s Qty arithmetic),
 *     which is commutative and associative — replay in ANY order or ANY
 *     subset-then-remainder split converges to the same total. That
 *     commutativity, proven generically in `@mimi/shared`'s fixed-point
 *     property tests, IS why T-02 holds; this module does not need its own
 *     reimplementation of "addition doesn't care about order."
 */
import {
  addFixed,
  formatFixed,
  isNegativeFixed,
  MovementType,
  parseFixed,
  rescale,
  QTY_SCALE,
  type ISODateTime,
  type Money,
  type Qty,
  type UUID,
} from '@mimi/shared';

export interface StockKey {
  locationId: UUID;
  storageAreaId: UUID;
  itemId: UUID;
}

export function stockKeyOf(k: StockKey): string {
  return `${k.locationId}::${k.storageAreaId}::${k.itemId}`;
}

/** One postable movement — the exact shape `stock_movements` rows take (CONTRACTS.md §1.3 block 021). */
export interface MovementFact extends StockKey {
  /** Idempotency key for THIS movement row. For a fact exploding into several movements (e.g. one sale, several recipe lines), append a stable suffix (`${eventId}:${lineIndex}:${itemId}`) so each still dedupes independently. */
  factId: string;
  movementType: MovementType;
  /** Always positive; sign comes from the type suffix (`_in`/`_out`) — see `movementSign`. */
  qty: Qty;
  unitCost: Money;
  refType: string;
  refId: UUID | null;
  occurredAt: ISODateTime;
}

/** `+1` for an `_in` type, `-1` for an `_out` type. */
export function movementSign(type: MovementType): 1 | -1 {
  return type.endsWith('_out') ? -1 : 1;
}

// ── Layer 1: business fact → movement(s) ──────────────────────────────────────

export interface RecipeLineInput {
  itemId: UUID;
  /** Qty of this ingredient per one unit of the product (CONTRACTS.md `recipe_lines.qty`). */
  qtyPerUnit: Qty;
  unitCost: Money;
}

export interface SaleLineInput {
  productId: UUID;
  qty: Qty;
}

/**
 * `sales.completed` → `usage_out` movements, one per ingredient, aggregated
 * across every sale line that uses it (FR-POS-06). This is the one
 * "explosion" translator every tier must run identically — it is the reason
 * the projector exists as shared code rather than three independent
 * implementations that could quietly drift on a recipe edge case.
 */
export function explodeSaleToMovements(
  saleEventId: UUID,
  saleLines: readonly SaleLineInput[],
  recipesByProduct: ReadonlyMap<UUID, readonly RecipeLineInput[]>,
  target: { locationId: UUID; storageAreaId: UUID },
  occurredAt: ISODateTime,
): MovementFact[] {
  const usageByItem = new Map<UUID, { qtyScaled: bigint; unitCost: Money }>();

  for (const line of saleLines) {
    const recipeLines = recipesByProduct.get(line.productId);
    if (!recipeLines) continue; // no BOM for this product (e.g. a bottled drink) — nothing to explode
    for (const ingredient of recipeLines) {
      const rawProduct = parseFixed(line.qty, QTY_SCALE) * parseFixed(ingredient.qtyPerUnit, QTY_SCALE);
      // rawProduct carries scale = 2*QTY_SCALE; round half-up back down to QTY_SCALE for accumulation.
      const rescaled = rescale(rawProduct, QTY_SCALE * 2, QTY_SCALE, 'half_up');
      const existing = usageByItem.get(ingredient.itemId);
      usageByItem.set(ingredient.itemId, {
        qtyScaled: (existing?.qtyScaled ?? 0n) + rescaled,
        unitCost: ingredient.unitCost,
      });
    }
  }

  return [...usageByItem.entries()].map(([itemId, { qtyScaled, unitCost }]) => ({
    locationId: target.locationId,
    storageAreaId: target.storageAreaId,
    itemId,
    factId: `${saleEventId}:usage:${itemId}`,
    movementType: MovementType.USAGE_OUT,
    qty: formatFixed(qtyScaled, QTY_SCALE),
    unitCost,
    refType: 'sale',
    refId: saleEventId,
    occurredAt,
  }));
}

export interface SimpleFactLine extends StockKey {
  qty: Qty;
  unitCost: Money;
}

/** A straightforward 1:1 translator for facts that already carry their movement shape directly (no explosion needed). */
function toMovements(
  lines: readonly SimpleFactLine[],
  factEventId: UUID,
  movementType: MovementType,
  refType: string,
  occurredAt: ISODateTime,
): MovementFact[] {
  return lines.map((line, i) => ({
    ...line,
    factId: `${factEventId}:${refType}:${i}`,
    movementType,
    refType,
    refId: factEventId,
    occurredAt,
  }));
}

/** `sj_drops.received` / `goods_receipts.recorded` / `po_receipts` → `purchase_in` or `transfer_in`. */
export function explodeReceiptToMovements(
  eventId: UUID,
  lines: readonly SimpleFactLine[],
  movementType: MovementType.PURCHASE_IN | MovementType.TRANSFER_IN | MovementType.RETURN_IN,
  refType: string,
  occurredAt: ISODateTime,
): MovementFact[] {
  return toMovements(lines, eventId, movementType, refType, occurredAt);
}

/** `waste_records` approved → `waste_out`. Stock effect derives ONLY after approval (strict: an unapproved report moves nothing). */
export function explodeWasteToMovements(eventId: UUID, lines: readonly SimpleFactLine[], occurredAt: ISODateTime): MovementFact[] {
  return toMovements(lines, eventId, MovementType.WASTE_OUT, 'waste_record', occurredAt);
}

/** `returns.shipped_back` (either leg) → `return_out`. */
export function explodeReturnOutToMovements(eventId: UUID, lines: readonly SimpleFactLine[], occurredAt: ISODateTime): MovementFact[] {
  return toMovements(lines, eventId, MovementType.RETURN_OUT, 'return', occurredAt);
}

/** `stock_adjustments.posted` (cloud-decided, from an approved opname) → `adjustment_in`/`adjustment_out`. */
export function explodeAdjustmentToMovements(
  eventId: UUID,
  line: SimpleFactLine & { direction: 'shortage' | 'overage' },
  occurredAt: ISODateTime,
): MovementFact[] {
  const movementType = line.direction === 'shortage' ? MovementType.ADJUSTMENT_OUT : MovementType.ADJUSTMENT_IN;
  return toMovements([line], eventId, movementType, 'stock_adjustment', occurredAt);
}

/** `inventory.area_transfer.create` → a paired `transfer_out` at the source area and `transfer_in` at the destination, same location. */
export function explodeAreaTransferToMovements(
  eventId: UUID,
  locationId: UUID,
  itemId: UUID,
  fromAreaId: UUID,
  toAreaId: UUID,
  qty: Qty,
  unitCost: Money,
  occurredAt: ISODateTime,
): MovementFact[] {
  return [
    { locationId, storageAreaId: fromAreaId, itemId, factId: `${eventId}:transfer_out`, movementType: MovementType.TRANSFER_OUT, qty, unitCost, refType: 'area_transfer', refId: eventId, occurredAt },
    { locationId, storageAreaId: toAreaId, itemId, factId: `${eventId}:transfer_in`, movementType: MovementType.TRANSFER_IN, qty, unitCost, refType: 'area_transfer', refId: eventId, occurredAt },
  ];
}

// ── Layer 2: movements → balances (the actual projector) ─────────────────────

export interface ProjectedBalance extends StockKey {
  qtyOnHand: Qty;
}

/**
 * Folds movements into balances. Deduplicates by `factId` first — replaying
 * the same movement any number of times, in any interleaving with others,
 * changes nothing (T-01/T-02's idempotent-convergence property). The result
 * is independent of input order because signed-integer addition is
 * commutative/associative (proved generically for `@mimi/shared`'s Qty
 * arithmetic).
 */
export function foldMovementsToBalances(movements: readonly MovementFact[]): Map<string, ProjectedBalance> {
  const seen = new Set<string>();
  const totals = new Map<string, bigint>();
  const keys = new Map<string, StockKey>();

  for (const m of movements) {
    if (seen.has(m.factId)) continue;
    seen.add(m.factId);

    const key = stockKeyOf(m);
    const signed = parseFixed(m.qty, QTY_SCALE) * BigInt(movementSign(m.movementType));
    totals.set(key, addFixed(totals.get(key) ?? 0n, signed));
    if (!keys.has(key)) keys.set(key, { locationId: m.locationId, storageAreaId: m.storageAreaId, itemId: m.itemId });
  }

  const result = new Map<string, ProjectedBalance>();
  for (const [key, scaled] of totals) {
    result.set(key, { ...keys.get(key)!, qtyOnHand: formatFixed(scaled, QTY_SCALE) });
  }
  return result;
}

/** The balance at one specific key — convenience wrapper around `foldMovementsToBalances`. */
export function projectBalanceAt(movements: readonly MovementFact[], key: StockKey): Qty {
  return foldMovementsToBalances(movements).get(stockKeyOf(key))?.qtyOnHand ?? formatFixed(0n, QTY_SCALE);
}

// ── D-17a: the ledger's two posting modes ─────────────────────────────────────

export type LedgerMode = 'strict' | 'fact';

export interface LedgerPostResult {
  nextBalance: Qty;
  /** `true` only in `fact` mode, when the posted movement drove the balance negative (C5 — opens a reconciliation exception, never rejected). */
  wentNegative: boolean;
}

export type LedgerPostOutcome =
  | ({ ok: true } & LedgerPostResult)
  | { ok: false; code: 'ERR_STOCK_INSUFFICIENT'; message: string };

/**
 * Applies one movement to a current balance under D-17a's dual mode:
 *  - `'strict'` (interactive writes): rejects if the result would go negative
 *    — `ERR_STOCK_INSUFFICIENT` (warehouse can't issue what it doesn't have).
 *  - `'fact'` (sync apply / replayed offline fact): always applies. The
 *    business fact happened; rejecting it would invent data. A negative
 *    result is flagged for the caller to open a `stock_reconciliations`
 *    exception (C5) — it is not this function's job to open that exception,
 *    only to report that one is warranted.
 */
export function applyMovement(currentBalance: Qty, movement: MovementFact, mode: LedgerMode): LedgerPostOutcome {
  const signed = parseFixed(movement.qty, QTY_SCALE) * BigInt(movementSign(movement.movementType));
  const next = addFixed(parseFixed(currentBalance, QTY_SCALE), signed);
  const negative = isNegativeFixed(next);

  if (negative && mode === 'strict') {
    return {
      ok: false,
      code: 'ERR_STOCK_INSUFFICIENT',
      message: `Posting ${movement.movementType} ${movement.qty} at ${stockKeyOf(movement)} would drive the balance negative under strict mode`,
    };
  }

  return { ok: true, nextBalance: formatFixed(next, QTY_SCALE), wentNegative: negative };
}

// ── R1/R2 reconciliation support ──────────────────────────────────────────────

export interface ReconciliationCheck {
  key: StockKey;
  expectedQty: Qty;
  storedQty: Qty;
  divergence: Qty;
  matches: boolean;
}

/**
 * R1 (nightly balance recompute) / R2 (tier checksum probe): compares a
 * stored balance against a from-scratch fold of the same fact horizon. A
 * mismatch here is the D-16 canary — see `./checksum` for the cheaper
 * per-device probe this backs.
 */
export function reconcileBalance(key: StockKey, storedQty: Qty, movements: readonly MovementFact[]): ReconciliationCheck {
  const expectedQty = projectBalanceAt(movements, key);
  const divergenceScaled = parseFixed(expectedQty, QTY_SCALE) - parseFixed(storedQty, QTY_SCALE);
  return {
    key,
    expectedQty,
    storedQty,
    divergence: formatFixed(divergenceScaled, QTY_SCALE),
    matches: divergenceScaled === 0n,
  };
}
