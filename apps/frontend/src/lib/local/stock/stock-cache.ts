/**
 * Device-side stock projection (D-16/D-16a). NEVER stores a balance or a
 * movement that traveled the wire — every row in the `movements` store here
 * is DERIVED, on this device, from applied facts (its own committed sales,
 * or facts pulled from an upstream) using the exact shared projector from
 * `@mimi/sync-protocol` that the cloud and any branch node also run. This
 * file is a thin, storage-wired shell around that pure code — it must never
 * reimplement folding/exploding logic itself (BUILD-PLAN §6 rule 5, D-16).
 *
 * `factId`-as-primary-key gives idempotent replay for free: writing the same
 * movement twice (a retried commit, a re-delivered pulled page) is just an
 * overwrite-with-identical-data at the same key, not a double count — this
 * is the SAME dedupe axis `foldMovementsToBalances` uses when it reads the
 * rows back.
 */
import {
  explodeSaleToMovements,
  explodeReceiptToMovements,
  explodeWasteToMovements,
  explodeReturnOutToMovements,
  explodeAdjustmentToMovements,
  explodeAreaTransferToMovements,
  foldMovementsToBalances,
  projectBalanceAt,
  applyMovement,
  type MovementFact,
  type ProjectedBalance,
  type StockKey,
  type RecipeLineInput,
  type SaleLineInput,
  type SimpleFactLine,
  type LedgerMode,
  type LedgerPostOutcome,
  computeAreaBalanceChecksums,
  stockKeyOf,
} from '@mimi/sync-protocol';
import type { Qty, UUID } from '@mimi/shared';
import type { TxHandle } from '../store/local-database';
import type { LocalDatabase } from '../store/local-database';
import type { StoredMovement } from '../types';

const MOVEMENTS_STORE = 'movements';

/** Writes a batch of already-exploded movements into the local fact log, inside the caller's transaction. */
export async function recordMovements(
  tx: TxHandle,
  movements: readonly MovementFact[],
): Promise<void> {
  const store = tx.store<StoredMovement>(MOVEMENTS_STORE);
  for (const m of movements) {
    await store.put(m);
  }
}

export interface RecordSaleArgs {
  saleEventId: UUID;
  saleLines: readonly SaleLineInput[];
  recipesByProduct: ReadonlyMap<UUID, readonly RecipeLineInput[]>;
  target: { locationId: UUID; storageAreaId: UUID };
  occurredAt: string;
}

/** `sales.completed` → `usage_out` movements (FR-POS-06), recorded atomically with the sale's outbox commit. */
export async function recordSaleWithinTx(
  tx: TxHandle,
  args: RecordSaleArgs,
): Promise<MovementFact[]> {
  const movements = explodeSaleToMovements(
    args.saleEventId,
    args.saleLines,
    args.recipesByProduct,
    args.target,
    args.occurredAt,
  );
  await recordMovements(tx, movements);
  return movements;
}

export async function recordReceiptWithinTx(
  tx: TxHandle,
  eventId: UUID,
  lines: readonly SimpleFactLine[],
  movementType: Parameters<typeof explodeReceiptToMovements>[2],
  refType: string,
  occurredAt: string,
): Promise<MovementFact[]> {
  const movements = explodeReceiptToMovements(eventId, lines, movementType, refType, occurredAt);
  await recordMovements(tx, movements);
  return movements;
}

export async function recordWasteWithinTx(
  tx: TxHandle,
  eventId: UUID,
  lines: readonly SimpleFactLine[],
  occurredAt: string,
): Promise<MovementFact[]> {
  const movements = explodeWasteToMovements(eventId, lines, occurredAt);
  await recordMovements(tx, movements);
  return movements;
}

export async function recordReturnOutWithinTx(
  tx: TxHandle,
  eventId: UUID,
  lines: readonly SimpleFactLine[],
  occurredAt: string,
): Promise<MovementFact[]> {
  const movements = explodeReturnOutToMovements(eventId, lines, occurredAt);
  await recordMovements(tx, movements);
  return movements;
}

export async function recordAdjustmentWithinTx(
  tx: TxHandle,
  eventId: UUID,
  line: SimpleFactLine & { direction: 'shortage' | 'overage' },
  occurredAt: string,
): Promise<MovementFact[]> {
  const movements = explodeAdjustmentToMovements(eventId, line, occurredAt);
  await recordMovements(tx, movements);
  return movements;
}

export async function recordAreaTransferWithinTx(
  tx: TxHandle,
  eventId: UUID,
  locationId: UUID,
  itemId: UUID,
  fromAreaId: UUID,
  toAreaId: UUID,
  qty: Qty,
  unitCost: string,
  occurredAt: string,
): Promise<MovementFact[]> {
  const movements = explodeAreaTransferToMovements(
    eventId,
    locationId,
    itemId,
    fromAreaId,
    toAreaId,
    qty,
    unitCost,
    occurredAt,
  );
  await recordMovements(tx, movements);
  return movements;
}

// ── Reads (outside any particular commit's transaction — always full-fold
// from the local fact log, per D-16a: "each tier recomputes" rather than
// maintaining an incrementally-mutated running total that could drift from
// the facts) ──────────────────────────────────────────────────────────────

export async function getAllMovements(db: LocalDatabase): Promise<MovementFact[]> {
  return db.store<StoredMovement>(MOVEMENTS_STORE).getAll();
}

export async function getBalance(db: LocalDatabase, key: StockKey): Promise<Qty> {
  const movements = await getAllMovements(db);
  return projectBalanceAt(movements, key);
}

export async function getAllBalances(db: LocalDatabase): Promise<Map<string, ProjectedBalance>> {
  const movements = await getAllMovements(db);
  return foldMovementsToBalances(movements);
}

/** §5.5 R2 — the per-area checksum a device emits once per day-close for the tier-checksum probe. */
export async function computeAreaChecksums(db: LocalDatabase): Promise<Record<string, string>> {
  const balances = [...(await getAllBalances(db)).values()];
  return computeAreaBalanceChecksums(
    balances.map((b) => ({
      storageAreaId: b.storageAreaId,
      itemId: b.itemId,
      qtyOnHand: b.qtyOnHand,
    })),
  );
}

/**
 * D-17a interactive check — used by Wave 4 UI to pre-flight a movement
 * BEFORE committing it (e.g. warehouse manual issue screens), never for
 * facts flowing through `commitFact` (those always apply in `'fact'` mode —
 * an offline sale is never rejected for driving stock negative, C5).
 */
export async function checkMovement(
  db: LocalDatabase,
  movement: MovementFact,
  mode: LedgerMode,
): Promise<LedgerPostOutcome> {
  const current = await getBalance(db, movement);
  return applyMovement(current, movement, mode);
}

export { stockKeyOf };
export type { StockKey, ProjectedBalance };
