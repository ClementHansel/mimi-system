import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { SyncEventEnvelope } from '@mimi/sync-protocol';
import type { ISODateTime, UUID } from '@mimi/shared';
import type { ProjectionContext, SyncProjector } from '../../../kernel/sync/sync-projector.types';
import { AttendanceService } from '../attendance/attendance.service';
import type { CheckAttendanceDto } from '../dto/attendance.dto';

/** The exact `attendance.checked_in` / `.checked_out` payload shape (`packages/sync-protocol/src/schema/registry.ts`'s `GROUP_7_SCHEMAS`) — identical to `CheckAttendanceDto`. */
interface AttendanceFactData {
  clientId: UUID;
  locationId: UUID;
  lat: string;
  lng: string;
  accuracyM: number;
  selfieAttachmentId: UUID;
  deviceId?: UUID;
  at?: ISODateTime;
}

function toDto(data: AttendanceFactData): CheckAttendanceDto {
  return {
    clientId: data.clientId,
    locationId: data.locationId,
    lat: data.lat,
    lng: data.lng,
    accuracyM: data.accuracyM,
    selfieAttachmentId: data.selfieAttachmentId,
    deviceId: data.deviceId,
    at: data.at,
  };
}

/**
 * The domain projector for `attendance.checked_in`/`.checked_out` (M14, per
 * the coordinator's directive: `kernel/sync` durably logs, dedupes, and
 * conflict-checks every pushed event, but nothing previously turned an
 * OFFLINE-originated fact into an `attendance` row — an outlet with no
 * signal all shift would sync its check-ins up and they would never become
 * payroll input. This closes that gap for M14 specifically.
 *
 * SHARES the online REST endpoint's exact derivation code
 * (`AttendanceService.applyCheckIn`/`applyCheckOut`) — the coordinator's
 * "wrinkle": a projector that just wrote `payload.data.at` into the row
 * would throw away `time_suspect`/`time_disputed`/`defensibleAt` clamping
 * (SYNC-PROTOCOL §6.3/§6.4) exactly where it matters most (a long-offline
 * device is precisely where clock skew accumulates), and would let
 * lateness/overtime (PIN-02/POUT-07) diverge from the online path depending
 * on whether the outlet had internet that day. The only thing this
 * projector supplies that the REST controller doesn't is `relayReceivedAt`
 * — sourced from `sync_events.relay_received_at` (the fact's REAL first
 * server sighting), never `new Date()`: recomputing "now" here would make a
 * later re-projection sweep (crash-retry, `projection_failed` requeue)
 * non-idempotent and silently move the defensibility clamp forward in time
 * every time it re-ran. `event.relayReceivedAt` on the in-memory envelope is
 * NOT populated by the current ingest pipeline for either the fresh-insert
 * or promoted-gap-fill path (`sync-ingest.service.ts`'s `envelopeFromRow`
 * omits it) — reading the persisted column directly is correct today and
 * stays correct if that gap is later closed upstream.
 *
 * IDEMPOTENCY: `applyCheckIn`/`applyCheckOut` already dedupe on
 * `client_id`/`check_out_client_id` (the REST path's own idempotency key,
 * §2.2) BEFORE writing anything — reused verbatim here per the interface's
 * own instruction to share that exact check between the REST and sync
 * paths, so the two can never both materialize the same action twice
 * regardless of which one lands first.
 *
 * CONFLICT LOSERS: SYNC-PROTOCOL §5.2 C4 (attendance overlap) is explicitly
 * a "both sides legitimately recorded, human reviews" case and never sets
 * `isConflictLoser` today — but this projector still honors it defensively
 * (skips the write entirely) per the coordinator's explicit instruction, so
 * a future conflict-detector change that DOES mark an attendance loser
 * can't silently double-count without this projector also changing.
 */
@Injectable()
export class AttendanceSyncProjector implements SyncProjector {
  private readonly logger = new Logger(AttendanceSyncProjector.name);
  readonly handles = ['attendance.checked_in', 'attendance.checked_out'];

  constructor(private readonly attendance: AttendanceService) {}

  async project(
    client: PoolClient,
    event: SyncEventEnvelope,
    context: ProjectionContext,
  ): Promise<void> {
    if (context.isConflictLoser) {
      this.logger.warn(
        `skipping conflict-loser attendance event ${event.eventId} (${event.op}) — not double-counting`,
      );
      return;
    }

    const employee = await this.attendance.resolveSelfEmployee(client, event.actorUserId);
    const relayReceivedAt = await this.resolveRelayReceivedAt(client, event);
    const dto = toDto(event.payload.data as AttendanceFactData);

    if (event.op === 'checked_in') {
      await this.attendance.applyCheckIn(client, employee.id, dto, relayReceivedAt);
    } else if (event.op === 'checked_out') {
      await this.attendance.applyCheckOut(client, employee.id, dto, relayReceivedAt);
    } else {
      // Unreachable given `handles` above, but fail loudly rather than silently no-op if the
      // registry ever routes a third op here.
      throw new Error(`AttendanceSyncProjector: unhandled op '${event.op}'`);
    }
  }

  /**
   * The fact's REAL first server sighting, from the SAME row
   * `SyncEventsRepository.insertEvent` just wrote in this transaction — see
   * this class's header for why `event.relayReceivedAt`/`new Date()` are
   * both wrong here.
   */
  private async resolveRelayReceivedAt(
    client: PoolClient,
    event: SyncEventEnvelope,
  ): Promise<ISODateTime> {
    const res = await client.query<{ relay_received_at: ISODateTime | null }>(
      'SELECT relay_received_at FROM sync_events WHERE event_id = $1',
      [event.eventId],
    );
    return res.rows[0]?.relay_received_at ?? event.relayReceivedAt ?? event.occurredAt;
  }
}
