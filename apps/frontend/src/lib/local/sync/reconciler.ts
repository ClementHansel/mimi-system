/**
 * Applies PULLED events (upstream → device, §4.5) into local caches:
 *  1. the 14-day dedupe window (`applied_events`) — makes re-delivery across
 *     an upstream switch or a retried page harmless (T-01/T-16), and this is
 *     the ONE gate a pulled event must pass before anything else happens;
 *  2. the generic `master_data` cache — every class-M/F/B pulled event
 *     upserts a read-model row keyed by `(entity, entityId)`, which is all
 *     Wave 4 surfaces need for "what does the catalog/roster/settings/open-
 *     document look like right now" (§8's "D" degraded-view cells);
 *  3. best-effort stock-effect projection for the small set of pulled ops
 *     that move stock (`stock_adjustments.posted`, `sj_drops.received`,
 *     `goods_receipts.recorded`, `waste_records.approved`, `returns.*`),
 *     via the SAME shared projector `stock/stock-cache.ts` wraps.
 *
 * ASSUMPTION flagged in the package report: `@mimi/sync-protocol` types the
 * payload envelope generically (`SyncPayload<TData = unknown>`) and no
 * per-`(entity, op)` payload schema registry exists yet for W2-E to import.
 * The field names read below for cloud-decided facts (`stock_adjustments`,
 * `sj_drops`, `goods_receipts`, `waste_records`, `returns`) are inferred from
 * CONTRACTS.md's resource interfaces (`Balance`, `Drop`, `PettyCash`-sibling
 * shapes) and SYNC-PROTOCOL §3.3's line descriptions — NOT confirmed against
 * W2-D's actual encoder. Every adapter below is defensive (a shape mismatch
 * is caught, logged, and skipped — the master-data upsert and dedupe-window
 * write still happen) so a payload-shape drift degrades the LOCAL STOCK VIEW
 * ONLY (§8 row 20 is already labeled "D — derived, per data lokal"), never
 * the sync pipe itself (§4.4's apply-crash-safety principle, applied at
 * device scale: a projector bug must never make an event un-appliable).
 */
import type { SyncEventEnvelope } from '@mimi/sync-protocol';
import type { LocalDatabase, StoreOps, TxHandle } from '../store/local-database';
import type { AppliedEventRecord, MasterDataRecord, StoredMovement } from '../types';
import {
  recordAdjustmentWithinTx,
  recordReceiptWithinTx,
  recordWasteWithinTx,
  recordReturnOutWithinTx,
  recordSaleWithinTx,
} from '../stock/stock-cache';
import { MovementType } from '@mimi/shared';
import type { RecipeLineInput, SaleLineInput, SimpleFactLine } from '@mimi/sync-protocol';
import { applyCrlRevocationWithinTx } from '../credentials/offline-credentials';

export interface ReconcileOptions {
  /** Called for every entity+op the built-in stock-effect adapters don't recognize, so Wave 4 can extend without forking this file. */
  extraStockAdapters?: Record<string, (tx: TxHandle, e: SyncEventEnvelope) => Promise<void>>;
  onWarning?: (message: string, error: unknown) => void;
}

const RECONCILE_STORES = ['applied_events', 'master_data', 'movements', 'credential_crl'] as const;

export async function reconcilePulledEvents(
  db: LocalDatabase,
  events: readonly SyncEventEnvelope[],
  options: ReconcileOptions = {},
): Promise<{ applied: number; skippedDuplicate: number }> {
  let applied = 0;
  let skippedDuplicate = 0;

  await db.runTransaction(RECONCILE_STORES, 'readwrite', async (tx) => {
    const appliedStore = tx.store<AppliedEventRecord>('applied_events');
    const masterStore = tx.store<MasterDataRecord>('master_data');

    for (const e of events) {
      const already = await appliedStore.get(e.eventId);
      if (already) {
        skippedDuplicate += 1;
        continue;
      }

      await masterStore.put({
        key: `${e.entity}:${e.entityId}`,
        entity: e.entity,
        entityId: e.entityId,
        op: e.op,
        data: e.payload.data,
        locationId: e.locationId,
        updatedAt: e.receivedAt ?? e.occurredAt,
      });

      await appliedStore.put({
        eventId: e.eventId,
        entity: e.entity,
        appliedAt: new Date().toISOString(),
      });
      applied += 1;

      try {
        const extra = options.extraStockAdapters?.[`${e.entity}.${e.op}`];
        if (extra) {
          await extra(tx, e);
        } else {
          await applyBuiltinStockEffect(tx, e, masterStore);
        }
      } catch (err) {
        options.onWarning?.(
          `stock-effect projection failed for ${e.entity}.${e.op} (${e.eventId})`,
          err,
        );
      }
    }
  });

  return { applied, skippedDuplicate };
}

async function applyBuiltinStockEffect(
  tx: TxHandle,
  e: SyncEventEnvelope,
  masterStore: StoreOps<MasterDataRecord>,
): Promise<void> {
  const data = e.payload.data as Record<string, unknown> | undefined;
  if (!data) return;

  switch (`${e.entity}.${e.op}`) {
    case 'stock_adjustments.posted': {
      const line = data as unknown as SimpleFactLine & { direction: 'shortage' | 'overage' };
      await recordAdjustmentWithinTx(tx, e.eventId, line, e.occurredAt);
      return;
    }
    case 'sj_drops.received': {
      const lines = (data.lines as SimpleFactLine[] | undefined) ?? [];
      await recordReceiptWithinTx(
        tx,
        e.eventId,
        lines,
        MovementType.TRANSFER_IN,
        'sj_drop',
        e.occurredAt,
      );
      return;
    }
    case 'goods_receipts.recorded': {
      const lines = (data.lines as SimpleFactLine[] | undefined) ?? [];
      await recordReceiptWithinTx(
        tx,
        e.eventId,
        lines,
        MovementType.PURCHASE_IN,
        'goods_receipt',
        e.occurredAt,
      );
      return;
    }
    case 'waste_records.approved': {
      const lines = (data.lines as SimpleFactLine[] | undefined) ?? [];
      await recordWasteWithinTx(tx, e.eventId, lines, e.occurredAt);
      return;
    }
    case 'returns.shipped_back': {
      const lines = (data.lines as SimpleFactLine[] | undefined) ?? [];
      await recordReturnOutWithinTx(tx, e.eventId, lines, e.occurredAt);
      return;
    }
    case 'offline_authorizations.revoked': {
      const credentialId = data.credentialId as string | undefined;
      if (credentialId) await applyCrlRevocationWithinTx(tx, credentialId, e.occurredAt);
      return;
    }
    case 'sales.completed': {
      // Cross-device visibility (node fan-out) or the device's own sale replayed back on pull.
      // Recipe lookup comes from whatever `products`/`recipes` master-data rows are cached locally;
      // a product with no cached recipe simply contributes no movement (matches
      // `explodeSaleToMovements`'s own "no BOM for this product -> nothing to explode" rule).
      const saleLines = (data.lines as SaleLineInput[] | undefined) ?? [];
      const target = data.target as { locationId: string; storageAreaId: string } | undefined;
      if (!target) return;
      const recipesByProduct = await loadRecipesByProduct(masterStore);
      await recordSaleWithinTx(tx, {
        saleEventId: e.eventId,
        saleLines,
        recipesByProduct,
        target,
        occurredAt: e.occurredAt,
      });
      return;
    }
    default:
      return;
  }
}

async function loadRecipesByProduct(
  masterStore: StoreOps<MasterDataRecord>,
): Promise<Map<string, RecipeLineInput[]>> {
  const all = await masterStore.getAll();
  const map = new Map<string, RecipeLineInput[]>();
  for (const row of all) {
    if (row.entity !== 'recipes') continue;
    const lines = (row.data as { lines?: RecipeLineInput[] } | undefined)?.lines;
    if (lines) map.set(row.entityId, lines);
  }
  return map;
}

export type { StoredMovement };
