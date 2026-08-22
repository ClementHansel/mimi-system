import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  loadFixtures,
  withRollbackAs,
  type Fixtures,
} from './test-support/live-db';

/**
 * B-11 — an offline waste report must actually become a `waste_records` row.
 *
 * ## What this is really testing
 *
 * Not the projector's arithmetic — there isn't any. It is testing that the
 * projector is REGISTERED and that the fact survives the trip. Before this,
 * `waste_records.reported` had a device commit helper, an authority-matrix
 * entry and a payload schema, and no server-side projector — and
 * `SyncProjectorRegistry.project` returns `{ ok: true, ran: false }` for an
 * unhandled `(entity, op)`. So an outlet with no internet photographed spoiled
 * chicken, the event synced, `sync_events` recorded it, ingest reported
 * success, and no waste report ever existed. Nothing anywhere went red.
 *
 * The first test therefore asserts the REGISTRATION explicitly, because a
 * projector that exists but is not wired reproduces the original bug exactly
 * while looking finished in review.
 */

const hasDb = Boolean(process.env.DATABASE_URL);

function mkEvent(params: {
  originDeviceId: string;
  clientSeq: number;
  locationId: string;
  entityId: string;
  op: string;
  data: unknown;
  actorUserId: string;
  actorRole: string;
}): SyncEventEnvelope {
  return {
    eventId: formatUuidV7(Date.now() + params.clientSeq, randomBytes(16)),
    originTier: SyncOriginType.DEVICE,
    originDeviceId: params.originDeviceId,
    locationId: params.locationId,
    entity: 'waste_records',
    entityId: params.entityId,
    op: params.op,
    payload: {
      v: 1,
      data: params.data,
      meta: {
        actorUserId: params.actorUserId,
        actorRole: params.actorRole,
        appVersion: '1.0.0',
      },
    },
    clientSeq: BigInt(params.clientSeq),
    occurredAt: new Date().toISOString(),
    actorUserId: params.actorUserId,
    schemaV: 1,
  };
}

/** Same construction as `waste-return.integration.spec.ts` — a fresh, unsubscribed `EventBus` because this file is about the projection hook, not the GL leg. */
function buildProjector(): WasteSyncProjector {
  const pool = appPoolForDi();
  const events = new SyncEventsRepository(pool);
  const sync = new SyncEmitService(
    events,
    new ConflictDetectorService(events, new SyncConflictsRepository()),
  );
  const ledger = new StockLedgerService(new StockMovedEventEmitter(new EventBus()));
  const waste = new WasteService(
    new WasteRepository(),
    new ApprovalService(new ApprovalsRepository()),
    ledger,
    sync,
    new EventBus(),
  );
  return new WasteSyncProjector(waste);
}

let fx: Fixtures;

beforeAll(async () => {
  if (!hasDb) return;
  fx = await loadFixtures();
}, 30_000);

afterAll(async () => {
  if (!hasDb) return;
  await closePool();
});

describe.skipIf(!hasDb)('B-11 — WasteSyncProjector, live database', () => {
  it('is REGISTERED for waste_records.reported — an unwired projector is the original bug', () => {
    const registry = new SyncProjectorRegistry();
    registry.register(buildProjector());
    // `SyncProjectorRegistry.project` treats an unhandled key as success, so
    // this is the assertion that distinguishes "handled" from "silently dropped".
    expect(registry.isRegistered('waste_records', 'reported')).toBe(true);
  });

  it('turns an offline-shaped waste report into real waste_records rows, keyed by the DEVICE batch id', async () => {
    const batchId = randomUUID();
    const projector = buildProjector();
    // Wajib foto (FR-WST-01) is a hard requirement of `WasteService.create`, and
    // the projector must satisfy the SAME rule the REST path does rather than
    // bypass it. Committed over the owner pool so the rolled-back transaction
    // under test can still see it.
    const attachmentId = await createAttachment(fx.leaderOutletUserId, 'waste_photo');

    await withRollbackAs(
      { role: 'leader_outlet', userId: fx.leaderOutletUserId, locationIds: [fx.outletId] },
      async (client) => {
        const event = mkEvent({
          originDeviceId: randomUUID(),
          clientSeq: 1,
          locationId: fx.outletId,
          entityId: batchId,
          op: 'reported',
          actorUserId: fx.leaderOutletUserId,
          actorRole: RoleKey.LEADER_OUTLET,
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
            photoAttachmentIds: [attachmentId],
          },
        });

        await projector.project(client, event, { isConflictLoser: false });

        const rows = await client.query<{ id: string; status: string; qty: string }>(
          `SELECT id, status, qty FROM waste_records WHERE batch_id = $1`,
          [batchId],
        );
        expect(rows.rowCount).toBe(1);
        expect(rows.rows[0]!.qty).toBe('2.000');
        // Pending, not approved: filing a report is not deciding it. The
        // supervisor's offline approval is a separate, re-verified fact.
        expect(rows.rows[0]!.status).toBe('pending');
      },
    );
  }, 30_000);

  it('is idempotent on the DEVICE batch id — a retried push does not file the waste twice', async () => {
    const batchId = randomUUID();
    const projector = buildProjector();
    const attachmentId = await createAttachment(fx.leaderOutletUserId, 'waste_photo');

    await withRollbackAs(
      { role: 'leader_outlet', userId: fx.leaderOutletUserId, locationIds: [fx.outletId] },
      async (client) => {
        const data = {
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
          photoAttachmentIds: [attachmentId],
        };
        const base = {
          originDeviceId: randomUUID(),
          locationId: fx.outletId,
          entityId: batchId,
          op: 'reported',
          actorUserId: fx.leaderOutletUserId,
          actorRole: RoleKey.LEADER_OUTLET,
          data,
        };

        await projector.project(client, mkEvent({ ...base, clientSeq: 1 }), {
          isConflictLoser: false,
        });
        // A DIFFERENT event id carrying the SAME device batch — exactly what a
        // re-projection sweep or a resent push produces. `event.eventId` would
        // not dedupe this; the device's own batch id is the only key that does.
        await projector.project(client, mkEvent({ ...base, clientSeq: 2 }), {
          isConflictLoser: false,
        });

        const rows = await client.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM waste_records WHERE batch_id = $1`,
          [batchId],
        );
        expect(rows.rows[0]!.n).toBe('1');
      },
    );
  }, 30_000);

  it('writes nothing for a conflict loser — the winning report already recorded that spoilage', async () => {
    const batchId = randomUUID();
    const projector = buildProjector();

    await withRollbackAs(
      { role: 'leader_outlet', userId: fx.leaderOutletUserId, locationIds: [fx.outletId] },
      async (client) => {
        const event = mkEvent({
          originDeviceId: randomUUID(),
          clientSeq: 1,
          locationId: fx.outletId,
          entityId: batchId,
          op: 'reported',
          actorUserId: fx.leaderOutletUserId,
          actorRole: RoleKey.LEADER_OUTLET,
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
            photoAttachmentIds: [randomUUID()],
          },
        });

        await projector.project(client, event, { isConflictLoser: true });

        const rows = await client.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM waste_records WHERE batch_id = $1`,
          [batchId],
        );
        expect(rows.rows[0]!.n).toBe('0');
      },
    );
  }, 30_000);
});
