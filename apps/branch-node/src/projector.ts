/**
 * The whitelist-apply projector — SYNC-PROTOCOL §1.4 ("What the node applies
 * vs. relays opaquely"). The node stores and forwards EVERY event verbatim
 * (that happens unconditionally in `relay.ts`, regardless of this module);
 * this file is only the read-model the node builds ON TOP of that log for
 * two purposes: (a) serving LAN devices a catalog/status view when the cloud
 * is unreachable, (b) the node-local per-storage-area stock view, using the
 * SAME shared pure projector every tier uses (D-16a, `@mimi/sync-protocol`).
 *
 * Never throws on an unexpected payload shape — "the node never rejects an
 * event for payload reasons, only for envelope reasons" (§1.4). A business
 * module shipping a payload shape different from what's assumed below just
 * means no local projection updates for that event; the event itself is
 * still stored and relayed correctly. This is deliberate: it keeps a
 * payload-shape mismatch from ever blocking the relay pipeline.
 *
 * CONTRACT GAP (flagged in the W2-F report): the exact `payload.data` shape
 * per `(entity, op)` is owned by its business module (M07 inventory, M08
 * stock-opname, M10 delivery, M12 waste-return — all Wave 3, built AFTER
 * this skeleton). The shapes assumed here (`ReceiptLikePayload`,
 * `WasteApprovedPayload`, ...) are reasonable placeholders inferred from
 * CONTRACTS.md's DDL column names; they must be reconciled against the real
 * payloads once those modules land. Nothing here breaks if they differ —
 * see the paragraph above.
 */
import {
  AUTHORITY,
  explodeAdjustmentToMovements,
  explodeReceiptToMovements,
  explodeReturnOutToMovements,
  explodeWasteToMovements,
  type MovementFact,
} from '@mimi/sync-protocol';
import { MovementType, type ISODateTime, type Money, type Qty, type UUID } from '@mimi/shared';
import type { SyncEventEnvelope } from '@mimi/sync-protocol';
import type { Store } from './store/types';

/**
 * Whitelisted F/B entities for LAN fan-out visibility (§1.4 table, minus
 * class-M which is handled generically for every entity in the authority
 * matrix). `stock_opname` is included for cross-tablet visibility of count
 * progress (not for stock movements — opname facts never move stock; only a
 * cloud-decided `stock_adjustments.posted` does, per SYNC-PROTOCOL §3.3).
 */
const WHITELISTED_FAN_OUT_ENTITIES = new Set([
  'sales',
  'pos_shifts',
  'void_refunds',
  'online_orders',
  'sj_drops',
  'goods_receipts',
  'waste_records',
  'stock_opname',
  'stock_adjustments',
  'replenishment_requests',
  'attendance',
  'returns',
]);

interface StockLineInput {
  storageAreaId?: string;
  storage_area_id?: string;
  itemId?: string;
  item_id?: string;
  qty?: string | number;
  qtyReceived?: string | number;
  qty_received?: string | number;
  unitCost?: string | number;
  unit_cost?: string | number;
}

function asQty(v: unknown): Qty | undefined {
  if (typeof v === 'string') return v as Qty;
  if (typeof v === 'number') return v.toFixed(3) as Qty;
  return undefined;
}

function asMoney(v: unknown): Money | undefined {
  if (typeof v === 'string') return v as Money;
  if (typeof v === 'number') return v.toFixed(2) as Money;
  return undefined;
}

/** Best-effort extraction of a `{locationId, storageAreaId, itemId, qty, unitCost}` line from an assumed-shape payload line; returns `undefined` (never throws) when the shape doesn't match. */
function normalizeLine(
  locationId: UUID,
  raw: StockLineInput,
): { locationId: UUID; storageAreaId: UUID; itemId: UUID; qty: Qty; unitCost: Money } | undefined {
  const storageAreaId = (raw.storageAreaId ?? raw.storage_area_id) as UUID | undefined;
  const itemId = (raw.itemId ?? raw.item_id) as UUID | undefined;
  const qty = asQty(raw.qty ?? raw.qtyReceived ?? raw.qty_received);
  const unitCost = asMoney(raw.unitCost ?? raw.unit_cost);
  if (!storageAreaId || !itemId || !qty || !unitCost) return undefined;
  return { locationId, storageAreaId, itemId, qty, unitCost };
}

function extractLines(data: unknown, locationId: UUID): ReturnType<typeof normalizeLine>[] {
  const rawLines = (data as { lines?: unknown[] } | undefined)?.lines;
  if (!Array.isArray(rawLines)) return [];
  return rawLines.map((l) => normalizeLine(locationId, l as StockLineInput)).filter((l) => l !== undefined);
}

/** Derives `MovementFact[]` for the whitelisted stock-affecting ops (best-effort; `[]` on any shape mismatch — never throws). */
export function deriveMovements(event: Pick<SyncEventEnvelope, 'entity' | 'entityId' | 'op' | 'payload' | 'locationId' | 'occurredAt'>): MovementFact[] {
  if (!event.locationId) return [];
  const locationId = event.locationId;
  const occurredAt = event.occurredAt as ISODateTime;
  const data = event.payload?.data;

  if (event.entity === 'sj_drops' && event.op === 'received') {
    const lines = extractLines(data, locationId).filter((l): l is NonNullable<typeof l> => l !== undefined);
    return explodeReceiptToMovements(event.entityId, lines, MovementType.TRANSFER_IN, 'sj_drop', occurredAt);
  }
  if (event.entity === 'goods_receipts' && event.op === 'recorded') {
    const lines = extractLines(data, locationId).filter((l): l is NonNullable<typeof l> => l !== undefined);
    return explodeReceiptToMovements(event.entityId, lines, MovementType.PURCHASE_IN, 'goods_receipt', occurredAt);
  }
  if (event.entity === 'waste_records' && event.op === 'approved') {
    const lines = extractLines(data, locationId).filter((l): l is NonNullable<typeof l> => l !== undefined);
    return explodeWasteToMovements(event.entityId, lines, occurredAt);
  }
  if (event.entity === 'returns' && event.op === 'shipped_back') {
    const direction = (data as { direction?: string } | undefined)?.direction;
    if (direction && direction !== 'outlet_to_warehouse') return []; // supplier leg is cloud-only (class X); nothing for the node to project
    const lines = extractLines(data, locationId).filter((l): l is NonNullable<typeof l> => l !== undefined);
    return explodeReturnOutToMovements(event.entityId, lines, occurredAt);
  }
  if (event.entity === 'stock_adjustments' && event.op === 'posted') {
    const d = data as { storageAreaId?: string; storage_area_id?: string; itemId?: string; item_id?: string; qty?: string | number; unitCost?: string | number; unit_cost?: string | number; direction?: 'shortage' | 'overage' } | undefined;
    const line = d && normalizeLine(locationId, d as StockLineInput);
    if (!line || (d?.direction !== 'shortage' && d?.direction !== 'overage')) return [];
    return explodeAdjustmentToMovements(event.entityId, { ...line, direction: d.direction }, occurredAt);
  }
  return [];
}

/**
 * Applies one event to the node's local read models per the §1.4 whitelist.
 * Safe to call for EVERY event the node stores (including ones outside the
 * whitelist) — it is a no-op for anything not listed there. Idempotent:
 * upserts and `appendMovements`'s `factId` dedupe make replay harmless
 * (T-01/T-02), so this may be re-run freely during a bootstrap/catch-up.
 */
export async function applyWhitelistedEvent(store: Store, event: SyncEventEnvelope): Promise<void> {
  const authority = AUTHORITY[event.entity as string];
  if (!authority) return; // entity unknown to this matrix — opaque relay only

  if (authority.class === 'M') {
    await store.upsertMasterData(event.entity as string, event.entityId, event.payload?.data);
    return;
  }

  if (!WHITELISTED_FAN_OUT_ENTITIES.has(event.entity as string)) return; // opaque store-and-forward only, per §1.4

  await store.upsertProjection(event.entity as string, event.entityId, event.locationId, event.payload?.data);

  const movements = deriveMovements(event);
  if (movements.length > 0) await store.appendMovements(movements);
}
