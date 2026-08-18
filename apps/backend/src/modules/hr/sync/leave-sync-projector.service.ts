import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { SyncEventEnvelope } from '@mimi/sync-protocol';
import { LeaveType, type UUID } from '@mimi/shared';
import type { ProjectionContext, SyncProjector } from '../../../kernel/sync/sync-projector.types';
import { LeavesService } from '../leaves/leaves.service';
import type { SubmitLeaveDto } from '../dto/leave.dto';

/** `leave_requests.submitted` payload (`packages/sync-protocol/src/schema/registry.ts`) — identical to `SubmitLeaveDto`. */
interface LeaveSubmittedData {
  clientId: UUID;
  type: LeaveType;
  startDate: string;
  endDate: string;
  reason?: string;
  attachmentId?: UUID;
}

/**
 * The domain projector for the two `leave_requests` ops a DEVICE can
 * originate offline (SYNC-PROTOCOL §3.3 Group 7: push side is `submitted`,
 * `cancelled` — decisions (`approved`/`rejected`) are online-only and never
 * reach here). Same gap this closes as `AttendanceSyncProjector` (see that
 * file's header) — an employee submitting or cancelling cuti/izin while
 * genuinely offline must still become a real `leave_requests` row (and, for
 * `submitted`, a real `approvals` chain) once the fact syncs up, not a
 * silently-dropped fact.
 *
 * Both handlers call `LeavesService`'s shared, NON-emitting cores
 * (`insertAndSubmit`/`applyCancel`) — the SAME derivation the online REST
 * endpoint uses, so an offline-submitted leave gets the identical quota
 * check and approval-chain routing as an online one. They deliberately do
 * NOT call `SyncEmitService.emit()` themselves: the event THIS projector is
 * handling already IS the canonical `leave_requests.submitted`/`.cancelled`
 * fact in `sync_events` — re-emitting a second cloud-origin copy of it would
 * be a duplicate, not a sync.
 *
 * `entityId` (§2.1 "client-minted id of the business record") becomes the
 * `leave_requests.id` primary key for `submitted` — required so that a
 * LATER `cancelled` fact (or an online `approved`/`rejected` decision) for
 * the SAME `entityId` resolves to the row this projector created.
 *
 * IDEMPOTENCY: `insertAndSubmit` dedupes on `client_id` (created once,
 * never regenerated, §2.2); `applyCancel` treats an already-`cancelled` row
 * as a no-op rather than erroring — both survive a re-projection sweep
 * replaying the same event.
 */
@Injectable()
export class LeaveSyncProjector implements SyncProjector {
  private readonly logger = new Logger(LeaveSyncProjector.name);
  readonly handles = ['leave_requests.submitted', 'leave_requests.cancelled'];

  constructor(private readonly leaves: LeavesService) {}

  async project(
    client: PoolClient,
    event: SyncEventEnvelope,
    context: ProjectionContext,
  ): Promise<void> {
    if (context.isConflictLoser) {
      this.logger.warn(
        `skipping conflict-loser leave_requests event ${event.eventId} (${event.op})`,
      );
      return;
    }

    if (event.op === 'submitted') {
      const data = event.payload.data as LeaveSubmittedData;
      const dto: SubmitLeaveDto = {
        clientId: data.clientId,
        type: data.type,
        startDate: data.startDate,
        endDate: data.endDate,
        reason: data.reason,
        attachmentId: data.attachmentId,
      };
      await this.leaves.insertAndSubmit(client, event.actorUserId, dto, event.entityId);
      return;
    }

    if (event.op === 'cancelled') {
      const actorRole = await this.leaves.resolveActorRole(client, event.actorUserId);
      await this.leaves.applyCancel(client, event.actorUserId, actorRole, event.entityId);
      return;
    }

    throw new Error(`LeaveSyncProjector: unhandled op '${event.op}'`);
  }
}
