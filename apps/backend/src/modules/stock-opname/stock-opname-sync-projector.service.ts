import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { RoleKey, type Qty, type UUID } from '@mimi/shared';
import type { SyncEventEnvelope } from '@mimi/sync-protocol';
import type { ProjectionContext, SyncProjector } from '../../kernel/sync/sync-projector.types';
import type { CreateOpnameDto } from './dto/create-opname.dto';
import type { UpsertOpnameLinesDto } from './dto/upsert-lines.dto';
import type { ActorContext } from './stock-opname.service';
import { StockOpnameService } from './stock-opname.service';

/**
 * B-11 — the server half of counting stock offline.
 *
 * A stock count is the flow with the least tolerance for waiting out an
 * outage: it is scheduled, it happens with people standing in the store room,
 * and it cannot be repeated later just because the internet was down. The
 * device could already queue it — `commitOpnameOpened`/`AreaCounted`/
 * `Submitted`/`Cancelled` exist, `STOCK_OPNAME` has `pushOps` for all four,
 * and every payload is in the schema registry — but no projector claimed those
 * ops, so the count synced into `sync_events` and never became a
 * `stock_opname` row. Silently: an unhandled `(entity, op)` is success as far
 * as `SyncProjectorRegistry` is concerned.
 *
 * ## Ordering
 *
 * The four ops arrive in `clientSeq` order per origin (SYNC-PROTOCOL §2.1),
 * and each later one needs the header the first created. That ordering is the
 * ingest pipeline's guarantee, not something re-established here — but a
 * missing header still has to be survivable rather than a crash loop, because
 * a `projection_failed` conflict entry can be retried out of order. Each
 * handler below therefore refuses politely on a header it cannot find, and
 * `SyncProjectorRegistry` records the exception without rejecting the fact.
 *
 * ## Approvals stay online
 *
 * `approved`/`rejected` are NOT handled: adjudicating a variance is an online
 * supervisor act (`ops` lists them, `pushOps` does not), and FR-SO-02's
 * mandatory variance reason is a conversation, not a queued fact.
 */

interface OpenedPayload {
  id: UUID;
  opnameNumber: string;
  locationId: UUID;
  storageAreaId: UUID | null;
  countedBy: UUID;
  startedAt: string;
}

interface OpnameLinePayload {
  itemId: UUID;
  storageAreaId: UUID;
  countedQty: Qty;
  varianceReason?: string;
}

interface AreaCountedPayload {
  opnameId: UUID;
  storageAreaId: UUID;
  lines: OpnameLinePayload[];
}

interface SubmittedPayload {
  opnameId: UUID;
  submittedAt: string;
}

interface CancelledPayload {
  opnameId: UUID;
}

@Injectable()
export class StockOpnameSyncProjector implements SyncProjector {
  private readonly logger = new Logger(StockOpnameSyncProjector.name);

  readonly handles = [
    'stock_opname.opened',
    'stock_opname.area_counted',
    'stock_opname.submitted',
    'stock_opname.cancelled',
  ];

  constructor(private readonly opname: StockOpnameService) {}

  async project(
    client: PoolClient,
    event: SyncEventEnvelope,
    context: ProjectionContext,
  ): Promise<void> {
    // C1 (opname double-count) never sets `isConflictLoser` — SYNC-PROTOCOL is
    // explicit that both counts are legitimately recorded facts pending human
    // review. If some future conflict kind does set it for this entity, not
    // writing is the safe default.
    if (context.isConflictLoser) {
      this.logger.warn(`skipping conflict-loser opname projection for event ${event.eventId}`);
      return;
    }

    const actor = this.actorFor(event);

    switch (`${event.entity}.${event.op}`) {
      case 'stock_opname.opened':
        return this.projectOpened(client, event, actor);
      case 'stock_opname.area_counted':
        return this.projectAreaCounted(client, event, actor);
      case 'stock_opname.submitted':
        return this.projectSubmitted(client, event, actor);
      case 'stock_opname.cancelled':
        return this.projectCancelled(client, event, actor);
      default:
        this.logger.warn(`unhandled key ${event.entity}.${event.op} reached the opname projector`);
    }
  }

  /**
   * The actor is the person who did it ON THE DEVICE. `locationScope: null`
   * because the honest scope check already happened where it can be honest —
   * on the device, against the credential it holds. Re-deriving scope here
   * from a role string the device supplied would be theatre.
   */
  private actorFor(event: SyncEventEnvelope): ActorContext {
    return {
      userId: event.actorUserId,
      roleKey: (event.payload.meta?.actorRole as RoleKey) || RoleKey.LEADER_OUTLET,
      locationScope: null,
    };
  }

  private async projectOpened(
    client: PoolClient,
    event: SyncEventEnvelope,
    actor: ActorContext,
  ): Promise<void> {
    const data = event.payload.data as OpenedPayload;
    // The device's `opnameNumber` is deliberately dropped: two tablets counting
    // offline both mint `SO/YYYYMM/0001`, and `opname_number` is UNIQUE. The
    // service issues a real one; the device's id is what carries identity.
    const dto: CreateOpnameDto = {
      locationId: data.locationId,
      storageAreaId: data.storageAreaId ?? undefined,
    };
    await this.opname.create(client, actor, dto, { id: data.id });
  }

  private async projectAreaCounted(
    client: PoolClient,
    event: SyncEventEnvelope,
    actor: ActorContext,
  ): Promise<void> {
    const data = event.payload.data as AreaCountedPayload;
    const dto: UpsertOpnameLinesDto = {
      lines: data.lines.map((l) => ({
        itemId: l.itemId,
        storageAreaId: l.storageAreaId,
        countedQty: l.countedQty,
        varianceReason: l.varianceReason,
      })),
    };
    await this.opname.upsertLines(client, actor, data.opnameId, dto);
  }

  private async projectSubmitted(
    client: PoolClient,
    event: SyncEventEnvelope,
    actor: ActorContext,
  ): Promise<void> {
    const data = event.payload.data as SubmittedPayload;
    await this.opname.submit(client, actor, data.opnameId);
  }

  private async projectCancelled(
    client: PoolClient,
    event: SyncEventEnvelope,
    actor: ActorContext,
  ): Promise<void> {
    const data = event.payload.data as CancelledPayload;
    await this.opname.cancel(client, actor, data.opnameId);
  }
}
