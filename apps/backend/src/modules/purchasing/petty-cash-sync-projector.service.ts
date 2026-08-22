import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { RoleKey, type Money, type Qty, type UUID } from '@mimi/shared';
import type { SyncEventEnvelope } from '@mimi/sync-protocol';
import type { ProjectionContext, SyncProjector } from '../../kernel/sync/sync-projector.types';
import type { CreatePettyCashDto } from './dto/petty-cash.dto';
import { PettyCashService } from './petty-cash.service';
import type { ActorContext } from './purchase-request.service';

/**
 * B-11 — the server half of recording a petty-cash purchase offline.
 *
 * The device could already queue it (`commitPettyCashRecorded`, a
 * `PETTY_CASH` authority entry with `pushOps: ['recorded']`, a payload in the
 * schema registry) and no projector claimed `petty_cash.recorded`, so the claim
 * synced into `sync_events` and never became a `petty_cash` row. Money spent
 * from the float, with a photographed receipt, that the system had no record
 * of — and nothing went red, because `SyncProjectorRegistry` treats an
 * unhandled `(entity, op)` as success.
 *
 * `verified`/`rejected` are deliberately not handled: verifying a claim is a
 * finance act against the real receipt, online, and `pushOps` says so.
 */

interface PettyCashLinePayload {
  description: string;
  itemId: UUID | null;
  storageAreaId?: UUID;
  qty: Qty | null;
  amount: Money;
  expenseCategory: string;
}

interface RecordedPayload {
  id: UUID;
  locationId: UUID;
  purchasedBy: UUID;
  purchaseDate: string;
  storeName: string;
  lines: PettyCashLinePayload[];
  paymentProofAttachmentId: UUID;
  goodsPhotoAttachmentId: UUID;
}

@Injectable()
export class PettyCashSyncProjector implements SyncProjector {
  private readonly logger = new Logger(PettyCashSyncProjector.name);

  readonly handles = ['petty_cash.recorded'];

  constructor(private readonly pettyCash: PettyCashService) {}

  async project(
    client: PoolClient,
    event: SyncEventEnvelope,
    context: ProjectionContext,
  ): Promise<void> {
    if (context.isConflictLoser) {
      this.logger.warn(`skipping conflict-loser petty-cash projection for event ${event.eventId}`);
      return;
    }

    const data = event.payload.data as RecordedPayload;

    // `purchasedBy` on the payload is who actually spent the money, and the
    // service takes the buyer from `actor.userId` — so the actor here is the
    // PURCHASER, not merely whoever's device pushed the batch. On a shared
    // outlet tablet those differ, and the claim has to name the person who
    // handed over the cash.
    const actor: ActorContext = {
      userId: data.purchasedBy,
      roleKey: (event.payload.meta?.actorRole as RoleKey) || RoleKey.LEADER_OUTLET,
      locationScope: null,
    };

    const dto: CreatePettyCashDto = {
      locationId: data.locationId,
      purchaseDate: data.purchaseDate,
      storeName: data.storeName,
      lines: data.lines.map((l) => ({
        description: l.description,
        itemId: l.itemId ?? undefined,
        storageAreaId: l.storageAreaId,
        qty: l.qty ?? undefined,
        amount: l.amount,
        expenseCategory: l.expenseCategory,
      })),
      paymentProofAttachmentId: data.paymentProofAttachmentId,
      goodsPhotoAttachmentId: data.goodsPhotoAttachmentId,
    };

    await this.pettyCash.create(client, actor, dto, { id: data.id });
  }
}
