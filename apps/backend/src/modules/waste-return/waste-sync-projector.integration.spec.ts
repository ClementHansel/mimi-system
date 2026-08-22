import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { RoleKey, SyncOriginType, WasteReason } from '@mimi/shared';
import { formatUuidV7, type SyncEventEnvelope } from '@mimi/sync-protocol';
import { ApprovalService } from '../../kernel/approvals/approvals.service';
import { ApprovalsRepository } from '../../kernel/approvals/approvals.repository';
import { EventBus } from '../../kernel/events/event-bus.service';
import { StockLedgerService } from '../../kernel/stock-ledger/stock-ledger.service';
import { StockMovedEventEmitter } from '../../kernel/stock-ledger/stock-ledger-events';
import { ConflictDetectorService } from '../../kernel/sync/conflict-detector.service';
import { SyncConflictsRepository } from '../../kernel/sync/sync-conflicts.repository';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';
import { SyncEventsRepository } from '../../kernel/sync/sync-events.repository';
import { SyncProjectorRegistry } from '../../kernel/sync/sync-projector-registry.service';
import { WasteSyncProjector } from './services/waste-sync-projector.service';
import { WasteRepository } from './waste.repository';
import { WasteService } from './waste.service';
import {
  appPoolForDi,
  closePool,
  createAttachment,
  deleteAttachment,
  loadFixtures,
  withRollbackAs,
  type Fixtures,
} from './test-support/live-db';

/**
 * B-11 — an offline waste report must actually become a `waste_records` row.
 *
 * ## What this is really testing
 *
 * Not arithmetic — there isn't any. It tests that the projector is REGISTERED
 * and that the fact survives the trip. Before this, `waste_records.reported`
 * had a device commit helper, an authority-matrix entry and a payload schema,
 * and no server-side projector — and `SyncProjectorRegistry.project` returns
 * `{ ok: true, ran: false }` for an unhandled `(entity, op)`. So an outlet with
 * no internet photographed spoiled chicken, the event synced, `sync_events`
 * recorded it, ingest reported success, and no waste report ever existed.
 * Nothing anywhere went red.
 *
 * The first test therefore asserts the REGISTRATION explicitly, because a
 * projector that exists but is not wired reproduces the original bug exactly
 * while looking finished in review.
 *
 * ## Why every step gets its own connection
 *
 * `WasteService.create` runs through `withWrite`, which COMMITS. That commit
 * ends the enclosing `withRollbackAs` transaction and — the part that bites —
 * resets `SET LOCAL ROLE`, leaving the connection as bare `mimi_app`, which
 * holds no table grants at all. A follow-up assertion on the same client fails
 * with `permission denied for table waste_records`, which reads like an RLS bug
 * and is not one. (It cost a red run here before it was understood.) So writes
 * and read-backs get separate `withRollbackAs` blocks, exactly as
 * `waste-return.integration.spec.ts` does — and because the rows really are
 * committed, cleanup is explicit rather than a rollback that cannot happen.
 */

const hasDb = Boolean(process.env.DATABASE_URL);

const cleanupPool = new Pool({
  connectionString:
    process.env.DATABASE_MIGRATION_URL ?? 'postgres://mimi:mimi_secret@localhost:55432/mimi',
  max: 2,
});

const batchIds: string[] = [];
const attachmentIds: string[] = [];

async function cleanupWasteBatch(batchId: string): Promise<void> {
  const rows = await cleanupPool.query<{ id: string }>(
    `SELECT id FROM waste_records WHERE batch_id = $1`,
    [batchId],
  );
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
  }
  await cleanupPool.query(`DELETE FROM waste_records WHERE batch_id = $1`, [batchId]);
}

function mkEvent(params: {
  originDeviceId: string;
  clientSeq: number;
  locationId: string;
  entityId: string;
  data: unknown;
  actorUserId: string;
}): SyncEventEnvelope {
  return {
    eventId: formatUuidV7(Date.now() + params.clientSeq, randomBytes(16)),
    originTier: SyncOriginType.DEVICE,
    originDeviceId: params.originDeviceId,
    locationId: params.locationId,
    entity: 'waste_records',
    entityId: params.entityId,
    op: 'reported',
    payload: {
      v: 1,
      data: params.data,
      meta: {
        actorUserId: params.actorUserId,
        actorRole: RoleKey.LEADER_OUTLET,
        appVersion: '1.0.0',
      },
    },
    clientSeq: BigInt(params.clientSeq),
    occurredAt: new Date().toISOString(),
    actorUserId: params.actorUserId,
    schemaV: 1,
  };
}

/** Same construction as `waste-return.integration.spec.ts` — a fresh, unsubscribed `EventBus`, because this file is about the projection hook, not the GL leg. */
function buildProjector(): WasteSyncProjector {
  const pool = appPoolForDi();
  const events = new SyncEventsRepository(pool);
  const sync = new SyncEmitService(
    events,
    new ConflictDetectorService(events, new SyncConflictsRepository()),
  );
  const waste = new WasteService(
    new WasteRepository(),
    new ApprovalService(new ApprovalsRepository()),
    new StockLedgerService(new StockMovedEventEmitter(new EventBus())),
    sync,
    new EventBus(),
  );
  return new WasteSyncProjector(waste);
}

/** Reads back on a SEPARATE connection with its own role — see the file header. */
async function countBatch(fx: Fixtures, batchId: string): Promise<number> {
  return withRollbackAs(
    { role: 'owner', userId: fx.usersByRole[RoleKey.OWNER], locationIds: [] },
    async (client) => {
      const res = await client.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM waste_records WHERE batch_id = $1`,
        [batchId],
      );
      return Number(res.rows[0]!.n);
    },
  );
}

let fx: Fixtures;

beforeAll(async () => {
  if (!hasDb) return;
  fx = await loadFixtures();
}, 30_000);

afterEach(async () => {
  if (!hasDb) return;
  while (batchIds.length) await cleanupWasteBatch(batchIds.pop()!);
  while (attachmentIds.length) await deleteAttachment(attachmentIds.pop()!);
});

afterAll(async () => {
  if (!hasDb) return;
  await cleanupPool.end();
  await closePool();
});

describe.skipIf(!hasDb)('B-11 — WasteSyncProjector, live database', () => {
  it('is REGISTERED for waste_records.reported — an unwired projector is the original bug', () => {
    const registry = new SyncProjectorRegistry();
    registry.register(buildProjector());
    // `SyncProjectorRegistry.project` treats an unhandled key as SUCCESS, so
    // this is the assertion that separates "handled" from "silently dropped".
    expect(registry.isRegistered('waste_records', 'reported')).toBe(true);
  });

  it('turns an offline-shaped waste report into a real waste_records row, keyed by the DEVICE batch id', async () => {
    const batchId = randomUUID();
    batchIds.push(batchId);
    // Wajib foto (FR-WST-01) is a hard requirement of `WasteService.create`,
    // and the projector must satisfy the SAME rule the REST path does.
    const photoId = await createAttachment(fx.leaderOutletUserId, 'waste_photo');
    attachmentIds.push(photoId);

    await withRollbackAs(
      { role: 'leader_outlet', userId: fx.leaderOutletUserId, locationIds: [fx.outletId] },
      (client) =>
        buildProjector().project(
          client,
          mkEvent({
            originDeviceId: randomUUID(),
            clientSeq: 1,
            locationId: fx.outletId,
            entityId: batchId,
            actorUserId: fx.leaderOutletUserId,
            data: {
              batchId,
              locationId: fx.outletId,
              items: [
                {
                  storageAreaId: fx.storageAreaOutlet,
                  itemId: fx.itemId,
                  qty: '2.000',
                  reason: WasteReason.EXPIRED,
                  reasonDetail: 'offline capture during an outage',
                },
              ],
              photoAttachmentIds: [photoId],
            },
          }),
          { isConflictLoser: false },
        ),
    );

    const rows = await withRollbackAs(
      { role: 'owner', userId: fx.usersByRole[RoleKey.OWNER], locationIds: [] },
      async (client) => {
        const res = await client.query<{ qty: string; status: string }>(
          `SELECT qty, status FROM waste_records WHERE batch_id = $1`,
          [batchId],
        );
        return res.rows;
      },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.qty).toBe('2.000');
    // Pending, not approved: filing a report is not deciding it. A supervisor's
    // offline approval is a separate fact, and one that gets re-verified.
    expect(rows[0]!.status).toBe('pending');
  }, 30_000);

  it('is idempotent on the DEVICE batch id — a retried push does not file the waste twice', async () => {
    const batchId = randomUUID();
    batchIds.push(batchId);
    const photoId = await createAttachment(fx.leaderOutletUserId, 'waste_photo');
    attachmentIds.push(photoId);

    const base = {
      originDeviceId: randomUUID(),
      locationId: fx.outletId,
      entityId: batchId,
      actorUserId: fx.leaderOutletUserId,
      data: {
        batchId,
        locationId: fx.outletId,
        items: [
          {
            storageAreaId: fx.storageAreaOutlet,
            itemId: fx.itemId,
            qty: '1.500',
            reason: WasteReason.DAMAGED,
          },
        ],
        photoAttachmentIds: [photoId],
      },
    };

    for (const clientSeq of [1, 2]) {
      // A DIFFERENT event id each time, carrying the SAME device batch — what a
      // re-projection sweep or a resent push actually produces. `event.eventId`
      // would not dedupe these; the device's own batch id is the only key that
      // does, which is why the service takes it.
      await withRollbackAs(
        { role: 'leader_outlet', userId: fx.leaderOutletUserId, locationIds: [fx.outletId] },
        (client) =>
          buildProjector().project(client, mkEvent({ ...base, clientSeq }), {
            isConflictLoser: false,
          }),
      );
    }

    expect(await countBatch(fx, batchId)).toBe(1);
  }, 30_000);

  it('writes nothing for a conflict loser — the winning report already recorded that spoilage', async () => {
    const batchId = randomUUID();
    batchIds.push(batchId);
    const photoId = await createAttachment(fx.leaderOutletUserId, 'waste_photo');
    attachmentIds.push(photoId);

    await withRollbackAs(
      { role: 'leader_outlet', userId: fx.leaderOutletUserId, locationIds: [fx.outletId] },
      (client) =>
        buildProjector().project(
          client,
          mkEvent({
            originDeviceId: randomUUID(),
            clientSeq: 1,
            locationId: fx.outletId,
            entityId: batchId,
            actorUserId: fx.leaderOutletUserId,
            data: {
              batchId,
              locationId: fx.outletId,
              items: [
                {
                  storageAreaId: fx.storageAreaOutlet,
                  itemId: fx.itemId,
                  qty: '3.000',
                  reason: WasteReason.LOST,
                },
              ],
              photoAttachmentIds: [photoId],
            },
          }),
          { isConflictLoser: true },
        ),
    );

    expect(await countBatch(fx, batchId)).toBe(0);
  }, 30_000);
});
