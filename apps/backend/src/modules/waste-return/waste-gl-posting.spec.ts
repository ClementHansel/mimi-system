/**
 * W6-04 (financial correctness) — "cold-chain breach → waste → journal path"
 * exercised end to end against the LIVE database, real `WasteService`, no
 * mocks (same wiring as `waste-return.integration.spec.ts`, which this file
 * is deliberately kept separate from per this ticket's "new *.spec.ts only"
 * constraint).
 *
 * The path IS reachable up through stock: `WasteReason.COLD_CHAIN_BREACH` is
 * a first-class reason code (`@mimi/shared`'s `enums.ts`), so a Kepala
 * Gudang/Leader Outlet can file a waste report citing a cold-chain breach,
 * a Supervisor/Manager approves it, and `WasteService.approve()` posts a
 * real `waste_out` stock movement (`stock-ledger`, D-07) for it — proven
 * below, positively.
 *
 * The GL leg of that same path is NOT reachable, and this file's second
 * test proves that NEGATIVELY, by executing the real approval and then
 * querying `journal_entries` for what `packages/shared/src/gl/posting-rules
 * .ts` documents as the JGUD-05/JOUT-04 posting rule for exactly this event
 * (`gudang_waste` / `outlet_waste`, "Kerugian Barang Rusak" — Dr 5100 / Cr
 * 1100 or 1110). `WasteService.approve()` (`waste.service.ts`) never
 * imports `EventBus` and never calls `eventBus.publish('journal.action',
 * ...)` — confirmed by reading the file: it depends only on
 * `WasteRepository`, `ApprovalService`, `StockLedgerService`, and
 * `SyncEmitService`. `accounting.integration.spec.ts`'s "every event type
 * balances" suite (ACCEPTANCE.md E2's evidence) drives `gudang_waste` /
 * `outlet_waste` through `PostingEngineService.postForEvent` directly with
 * a HAND-CONSTRUCTED event — it never runs through `WasteService`, so it
 * never noticed that nothing in production actually emits that event. This
 * is a genuine correctness DEFECT (see the module report), not a gap this
 * test file is inventing: a cold-chain write-off physically leaves the
 * warehouse/outlet's stock (test #1 proves that) but NEVER reaches the
 * general ledger (test #2 proves that) — `5100 Kerugian Barang Rusak` is
 * permanently understated by the full value of every approved waste batch,
 * and 1100/1110 (inventory) is never credited for it either, so the balance
 * sheet silently overstates on-hand inventory value forever after.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { RoleKey, WasteReason } from '@mimi/shared';
import { Pool } from 'pg';

vi.setConfig({ testTimeout: 20_000 });

import { ApprovalService } from '../../kernel/approvals/approvals.service';
import { ApprovalsRepository } from '../../kernel/approvals/approvals.repository';
import { StockLedgerService } from '../../kernel/stock-ledger/stock-ledger.service';
import { StockMovedEventEmitter } from '../../kernel/stock-ledger/stock-ledger-events';
import { EventBus } from '../../kernel/events/event-bus.service';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';
import { SyncEventsRepository } from '../../kernel/sync/sync-events.repository';
import { SyncConflictsRepository } from '../../kernel/sync/sync-conflicts.repository';
import { ConflictDetectorService } from '../../kernel/sync/conflict-detector.service';

import { WasteRepository } from './waste.repository';
import { WasteService, type ActorContext } from './waste.service';
import {
  appPoolForDi,
  closePool,
  createAttachment,
  deleteAttachment,
  ensureStock,
  loadFixtures,
  reconcileStockBalance,
  withRollbackAs,
  type Fixtures,
} from './test-support/live-db';

function buildKit() {
  const events = new SyncEventsRepository(appPoolForDi());
  const conflicts = new SyncConflictsRepository();
  const conflictDetector = new ConflictDetectorService(events, conflicts);
  const sync = new SyncEmitService(events, conflictDetector);
  const ledger = new StockLedgerService(new StockMovedEventEmitter(new EventBus()));
  const approvals = new ApprovalService(new ApprovalsRepository());
  const wasteService = new WasteService(new WasteRepository(), approvals, ledger, sync);
  return { wasteService };
}

function actorFor(
  fx: Fixtures,
  role: RoleKey,
  locationScope: readonly string[] | null = null,
): ActorContext {
  return { userId: fx.usersByRole[role], roleKey: role, locationScope };
}

const cleanupPool = new Pool({
  connectionString:
    process.env.DATABASE_MIGRATION_URL ??
    `postgres://${process.env.POSTGRES_USER ?? 'mimi'}:${process.env.POSTGRES_PASSWORD ?? 'mimi_secret'}@localhost:${process.env.POSTGRES_PORT ?? '55433'}/${process.env.POSTGRES_DB ?? 'mimi'}`,
});

/** Same cleanup shape as `waste-return.integration.spec.ts` — see that file's header comment for
 * why the balance must be reconciled to the fold of remaining movements, never blind-deleted. */
async function cleanupWasteBatch(batchId: string): Promise<void> {
  const rows = await cleanupPool.query<{
    id: string;
    location_id: string;
    storage_area_id: string;
    item_id: string;
  }>(`SELECT id, location_id, storage_area_id, item_id FROM waste_records WHERE batch_id = $1`, [
    batchId,
  ]);
  for (const row of rows.rows) {
    await cleanupPool.query(`UPDATE waste_records SET approval_id = NULL WHERE id = $1`, [row.id]);
    await cleanupPool.query(
      `DELETE FROM approval_steps WHERE approval_id IN (SELECT id FROM approvals WHERE document_type = 'waste' AND document_id = $1)`,
      [row.id],
    );
    await cleanupPool.query(
      `DELETE FROM approvals WHERE document_type = 'waste' AND document_id = $1`,
      [row.id],
    );
    await cleanupPool.query(
      `DELETE FROM stock_movements WHERE ref_type = 'waste_record' AND ref_id = $1`,
      [row.id],
    );
    await reconcileStockBalance(row.location_id, row.storage_area_id, row.item_id);
  }
  await cleanupPool.query(`DELETE FROM waste_records WHERE batch_id = $1`, [batchId]);
}

describe.skipIf(!process.env.DATABASE_URL)(
  'Waste (cold-chain breach reason) — GL posting reachability, live database',
  () => {
    let fx: Fixtures;
    const attachmentIds: string[] = [];
    const batchIds: string[] = [];

    beforeAll(async () => {
      fx = await loadFixtures();
      await ensureStock(fx.warehouseId, fx.storageAreaWarehouse, fx.itemId, '50.000');
    });

    afterEach(async () => {
      while (attachmentIds.length) await deleteAttachment(attachmentIds.pop()!);
      while (batchIds.length) await cleanupWasteBatch(batchIds.pop()!);
    });

    afterAll(async () => {
      await reconcileStockBalance(fx.warehouseId, fx.storageAreaWarehouse, fx.itemId);
      await cleanupPool.end();
      await closePool();
    });

    it('control: a COLD_CHAIN_BREACH waste report, once approved, DOES post a real waste_out stock movement and decrement the warehouse balance', async () => {
      const kgd = actorFor(fx, RoleKey.KEPALA_GUDANG, [fx.warehouseId]);

      const photoId = await createAttachment(fx.kepalaGudangUserId, 'cold_chain_breach_photo');
      attachmentIds.push(photoId);

      const before = await withRollbackAs(
        { role: 'owner', userId: fx.usersByRole[RoleKey.OWNER], locationIds: [] },
        (client) =>
          client.query<{ qty_on_hand: string }>(
            `SELECT qty_on_hand FROM stock_balances WHERE location_id = $1 AND storage_area_id = $2 AND item_id = $3`,
            [fx.warehouseId, fx.storageAreaWarehouse, fx.itemId],
          ),
      );

      const created = await withRollbackAs(
        { role: 'kepala_gudang', userId: kgd.userId, locationIds: [fx.warehouseId] },
        (client) => {
          const { wasteService } = buildKit();
          return wasteService.create(client, kgd, {
            locationId: fx.warehouseId,
            items: [
              {
                storageAreaId: fx.storageAreaWarehouse,
                itemId: fx.itemId,
                qty: '4.000',
                reason: WasteReason.COLD_CHAIN_BREACH,
                reasonDetail: 'Reefer excursion above -15C on SJ (see sj_temperature_logs)',
              },
            ],
            photoAttachmentIds: [photoId],
          });
        },
      );
      batchIds.push(created[0]!.batchId);
      expect(created[0]!.reason).toBe(WasteReason.COLD_CHAIN_BREACH);

      // Kepala Gudang's own approval role for a warehouse waste batch, per this module's approval
      // routing (mirrors the leader_outlet -> supervisor pairing `waste-return.integration.spec.ts`
      // uses for the outlet side).
      const approved = await withRollbackAs(
        { role: 'kepala_gudang', userId: kgd.userId, locationIds: [fx.warehouseId] },
        (client) => {
          const { wasteService } = buildKit();
          return wasteService.approve(client, kgd, created[0]!.batchId, {});
        },
      );
      expect(approved[0]!.status).toBe('approved');

      const after = await withRollbackAs(
        { role: 'owner', userId: fx.usersByRole[RoleKey.OWNER], locationIds: [] },
        (client) =>
          client.query<{ qty_on_hand: string }>(
            `SELECT qty_on_hand FROM stock_balances WHERE location_id = $1 AND storage_area_id = $2 AND item_id = $3`,
            [fx.warehouseId, fx.storageAreaWarehouse, fx.itemId],
          ),
      );
      expect(Number(before.rows[0]!.qty_on_hand) - Number(after.rows[0]!.qty_on_hand)).toBeCloseTo(
        4,
        3,
      );

      const movementRows = await cleanupPool.query<{ movement_type: string; ref_type: string }>(
        `SELECT movement_type, ref_type FROM stock_movements WHERE ref_type = 'waste_record' AND ref_id = $1`,
        [created[0]!.id],
      );
      expect(movementRows.rows).toHaveLength(1);
      expect(movementRows.rows[0]!.movement_type).toBe('waste_out');
    });

    it('DEFECT: the SAME approval never produces a journal_entries row for gudang_waste (JGUD-05) — the GL leg of the cold-chain breach -> waste -> journal path is unreachable in production', async () => {
      const kgd = actorFor(fx, RoleKey.KEPALA_GUDANG, [fx.warehouseId]);
      const photoId = await createAttachment(fx.kepalaGudangUserId, 'cold_chain_breach_photo_2');
      attachmentIds.push(photoId);

      const created = await withRollbackAs(
        { role: 'kepala_gudang', userId: kgd.userId, locationIds: [fx.warehouseId] },
        (client) => {
          const { wasteService } = buildKit();
          return wasteService.create(client, kgd, {
            locationId: fx.warehouseId,
            items: [
              {
                storageAreaId: fx.storageAreaWarehouse,
                itemId: fx.itemId,
                qty: '2.000',
                reason: WasteReason.COLD_CHAIN_BREACH,
                reasonDetail: 'Reefer excursion, second batch',
              },
            ],
            photoAttachmentIds: [photoId],
          });
        },
      );
      batchIds.push(created[0]!.batchId);

      await withRollbackAs(
        { role: 'kepala_gudang', userId: kgd.userId, locationIds: [fx.warehouseId] },
        (client) => {
          const { wasteService } = buildKit();
          return wasteService.approve(client, kgd, created[0]!.batchId, {});
        },
      );

      // Give any (nonexistent) async posting-engine subscriber a moment, in case a future fix
      // makes this asynchronous rather than synchronous-in-transaction.
      await new Promise((resolve) => setTimeout(resolve, 250));

      const journalRows = await cleanupPool.query<{ id: string; event_type: string }>(
        `SELECT id, event_type FROM journal_entries WHERE ref_type = 'waste_record' AND ref_id = $1`,
        [created[0]!.id],
      );
      // EXPECTED (per JGUD-05/posting-rules.ts): 1 row, event_type='gudang_waste'.
      // ACTUAL, today: 0 rows — WasteService never publishes 'journal.action'. This assertion
      // pins the CURRENT (broken) behavior explicitly so it goes RED the moment someone wires the
      // fix — flip it to `toHaveLength(1)` / assert the balanced Dr 5100 / Cr 1100 legs as part of
      // that fix, per the module report's recommendation.
      expect(journalRows.rows).toHaveLength(0);

      // Cross-check against the account this SHOULD have hit — 5100 (Kerugian/Waste expense) has
      // no line at all referencing this waste_record, anywhere in journal_lines.
      const anyLine = await cleanupPool.query(
        `SELECT jl.id FROM journal_lines jl
           JOIN journal_entries je ON je.id = jl.entry_id
          WHERE je.ref_type = 'waste_record' AND je.ref_id = $1`,
        [created[0]!.id],
      );
      expect(anyLine.rows).toHaveLength(0);
    });
  },
);
