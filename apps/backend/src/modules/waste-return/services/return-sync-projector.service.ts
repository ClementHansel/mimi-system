import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  RoleKey,
  type Qty,
  type ReturnCondition,
  type ReturnDirection,
  type UUID,
} from '@mimi/shared';
import type { SyncEventEnvelope } from '@mimi/sync-protocol';
import type { ProjectionContext, SyncProjector } from '../../../kernel/sync/sync-projector.types';
import type { CreateReturnDto, ShipReturnDto } from '../dto/return.dto';
import { ReturnService, type ActorContext } from '../return.service';

/**
 * B-11 — the server half of raising a retur offline.
 *
 * `RETURNS` already had `pushOps: ['submitted', 'shipped_back']` and both
 * payloads in the schema registry, and no projector claimed either, so a retur
 * raised during an outage synced into `sync_events` and never became a
 * `returns` row. This is the leg where goods physically leave an outlet, so
 * losing it means stock that walked out of the building with no document
 * behind it.
 *
 * ## Two ops, two very different acts
 *
 * `submitted` CREATES the retur (the device's own id carries identity), then
 * submits it for approval — the offline equivalent of filling in the form and
 * handing it over. `shipped_back` is the later act of the goods actually
 * leaving, and it moves stock, so it is only legal once the retur has been
 * APPROVED. `ReturnService.ship` enforces that itself and throws otherwise;
 * that throw is the correct outcome, recorded by the registry as a projection
 * exception rather than silently swallowed.
 *
 * `approved`/`rejected`/`received_at_warehouse` are not handled here: the
 * first two are decisions (`pushOps` excludes them), and receiving is the
 * warehouse's own online act at the other end of the journey.
 */

interface ReturnLinePayload {
  itemId: UUID;
  storageAreaId: UUID;
  qty: Qty;
  condition: ReturnCondition;
  reason: string;
}

interface SubmittedPayload {
  id: UUID;
  direction: ReturnDirection;
  fromLocationId: UUID;
  toLocationId?: UUID;
  supplierId?: UUID;
  lines: ReturnLinePayload[];
  photoAttachmentIds: UUID[];
}

interface ShippedBackPayload {
  proofAttachmentIds: UUID[];
}

@Injectable()
export class ReturnSyncProjector implements SyncProjector {
  private readonly logger = new Logger(ReturnSyncProjector.name);

  readonly handles = ['returns.submitted', 'returns.shipped_back'];

  constructor(private readonly returns: ReturnService) {}

  async project(
    client: PoolClient,
    event: SyncEventEnvelope,
    context: ProjectionContext,
  ): Promise<void> {
    if (context.isConflictLoser) {
      // A losing retur must not move stock a second time — the winning fact
      // already did, and `shipped_back` posts `return_out`.
      this.logger.warn(`skipping conflict-loser return projection for event ${event.eventId}`);
      return;
    }

    const actor: ActorContext = {
      userId: event.actorUserId,
      roleKey: (event.payload.meta?.actorRole as RoleKey) || RoleKey.LEADER_OUTLET,
      locationScope: null,
    };

    switch (`${event.entity}.${event.op}`) {
      case 'returns.submitted':
        return this.projectSubmitted(client, event, actor);
      case 'returns.shipped_back':
        return this.projectShippedBack(client, event, actor);
      default:
        this.logger.warn(`unhandled key ${event.entity}.${event.op} reached the return projector`);
    }
  }

  private async projectSubmitted(
    client: PoolClient,
    event: SyncEventEnvelope,
    actor: ActorContext,
  ): Promise<void> {
    const data = event.payload.data as SubmittedPayload;

    const dto: CreateReturnDto = {
      direction: data.direction,
      fromLocationId: data.fromLocationId,
      toLocationId: data.toLocationId,
      supplierId: data.supplierId,
      lines: data.lines.map((l) => ({
        itemId: l.itemId,
        storageAreaId: l.storageAreaId,
        qty: l.qty,
        condition: l.condition,
        reason: l.reason,
      })),
      photoAttachmentIds: data.photoAttachmentIds,
    };

    const created = await this.returns.create(client, actor, dto, { id: data.id });

    // `create` leaves the retur in `draft`; the device's op is `submitted`, so
    // the form was handed over, not merely started. Submitting separately —
    // rather than adding a "create and submit" service method — keeps the
    // offline path on exactly the same two transitions the online one makes,
    // including the approval chain `submit` starts.
    if (created.status === 'draft') {
      await this.returns.submit(client, actor, data.id);
    }
  }

  private async projectShippedBack(
    client: PoolClient,
    event: SyncEventEnvelope,
    actor: ActorContext,
  ): Promise<void> {
    const data = event.payload.data as ShippedBackPayload;
    const dto: ShipReturnDto = { proofAttachmentIds: data.proofAttachmentIds };
    await this.returns.ship(client, actor, event.entityId, dto);
  }
}
