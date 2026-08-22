import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { RoleKey, type Qty, type UUID, type WasteReason } from '@mimi/shared';
import type { SyncEventEnvelope } from '@mimi/sync-protocol';
import type { ProjectionContext, SyncProjector } from '../../../kernel/sync/sync-projector.types';
import type { CreateWasteDto } from '../dto/waste.dto';
import { WasteService, type ActorContext } from '../waste.service';

/**
 * B-11 — the missing half of offline waste reporting.
 *
 * ## What was actually broken
 *
 * The blocker read "LocalRuntime exposes no commit helpers for waste_records",
 * which stopped being true some waves ago: `commitWasteReported` and
 * `commitWasteApprovedOffline` exist, `WASTE_RECORDS` has an authority-matrix
 * entry with `pushOps: ['reported', 'approved_offline']`, and both payloads are
 * in the schema registry. The device end was finished.
 *
 * The SERVER end was not, and its absence is silent by design:
 * `SyncProjectorRegistry.project` treats "no projector registered for this
 * (entity, op)" as success — correct for the many entities that are pull-only
 * or logged-only, and a data-loss trap for one whose entire purpose is offline
 * capture. An outlet with no internet photographed spoiled chicken, the event
 * synced, `sync_events` recorded it, and **no `waste_records` row was ever
 * created**. Nothing failed; the report just never existed.
 *
 * ## Why this calls the service instead of writing the tables
 *
 * `WasteService.create` owns the wajib-foto check (FR-WST-01), document
 * numbering, the approval submission and the attachment re-parenting. A
 * projector that inserted rows itself would be a second implementation of
 * "file a waste report" — the exact shape of D-27, where the two copies of the
 * recipe formula silently disagreed for waves. The service gained an optional
 * `batchId` for this; nothing else about it changed.
 *
 * ## Idempotency
 *
 * The DEVICE's `batchId` is the key, not `event.eventId`: a retried push whose
 * ack was lost, or a re-projection sweep off the conflict queue, must not file
 * the same waste twice. `WasteService.create` returns the existing batch
 * untouched when it already exists.
 */
interface WasteLinePayload {
  storageAreaId: UUID;
  itemId: UUID;
  qty: Qty;
  /** Validated against the `WasteReason` enum by the schema registry before it reaches here. */
  reason: WasteReason;
  reasonDetail?: string;
}

interface WasteReportedPayload {
  batchId: UUID;
  locationId: UUID;
  items: WasteLinePayload[];
  photoAttachmentIds: UUID[];
}

@Injectable()
export class WasteSyncProjector implements SyncProjector {
  private readonly logger = new Logger(WasteSyncProjector.name);

  /**
   * `approved_offline` is deliberately NOT handled here.
   *
   * A provisional offline approval is not a domain write to replay — it is a
   * claim that has to be RE-VERIFIED against the cached credential (§7.4's
   * eight checks, D-17), which `kernel/sync`'s `OfflineAuthService` already
   * does on ingest, recording the outcome and raising a finance exception when
   * it fails. Projecting an approval here as well would apply the effect
   * before that verdict exists, and would double-approve on a re-projection.
   * The waste stays `pending` until a verified decision lands, which is the
   * conservative and auditable end of that fork.
   */
  readonly handles = ['waste_records.reported'];

  constructor(private readonly waste: WasteService) {}

  async project(
    client: PoolClient,
    event: SyncEventEnvelope,
    context: ProjectionContext,
  ): Promise<void> {
    if (context.isConflictLoser) {
      // C3 decision race on `waste_records` — the winning fact is already
      // recorded; writing this one too would file the same spoilage twice.
      this.logger.warn(`skipping conflict-loser waste projection for event ${event.eventId}`);
      return;
    }

    const data = event.payload.data as WasteReportedPayload;

    // The actor is the person who reported it ON THE DEVICE, carried in the
    // envelope. `locationScope: null` because scope was already enforced where
    // it can be enforced honestly — on the device, against the credential it
    // holds — and re-deriving it here from a role string the device supplied
    // would be theatre, not a check. The location on the payload is the one
    // the report is filed against either way.
    const actor: ActorContext = {
      userId: event.actorUserId,
      roleKey: (event.payload.meta?.actorRole as RoleKey) || RoleKey.LEADER_OUTLET,
      locationScope: null,
    };

    const dto: CreateWasteDto = {
      locationId: data.locationId,
      items: data.items.map((i) => ({
        storageAreaId: i.storageAreaId,
        itemId: i.itemId,
        qty: i.qty,
        reason: i.reason,
        reasonDetail: i.reasonDetail,
      })),
      photoAttachmentIds: data.photoAttachmentIds,
    };

    await this.waste.create(client, actor, dto, { batchId: data.batchId });
  }
}
