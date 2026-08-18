/**
 * Cloud-origin sync-event emission — the kernel helper BUILD-PLAN §6 rule 6
 * ("every mutation emits a sync event via the kernel helper") and the agent
 * brief template (`SyncService.emit()`) refer to. Every Wave 3+ domain
 * module that creates a cloud-born master-data edit or decision (surat
 * jalan issue, warehouse approval, payment verification, ...) calls this
 * INSTEAD OF inserting into `sync_events` itself — it is the only writer
 * (mirrors `SyncEventsRepository`'s role on the ingest side).
 *
 * SYNC-PROTOCOL §1.5: "the cloud is just another (privileged) origin... one
 * apply path serves all three tiers." A cloud-emitted event skips §3.4's
 * push-authority checks (the cloud is exempt, `canOriginate` always `true`
 * for it) but still runs the SAME conflict-detection hook as an
 * ingested device event — e.g. an online `approved` racing an already
 * `approved_offline` decision is exactly SYNC-PROTOCOL §5.2 C3, and must be
 * caught here too, not only on the device-push path.
 */
import { Injectable } from '@nestjs/common';
import type { UUID } from '@mimi/shared';
import { SyncOriginType } from '@mimi/shared';
import {
  canOriginate,
  formatUuidV7,
  type SyncEventEnvelope,
  type SyncPayload,
} from '@mimi/sync-protocol';
import { randomBytes } from 'node:crypto';
import { SyncEventsRepository, type DbClient } from './sync-events.repository';
import { ConflictDetectorService } from './conflict-detector.service';
import { CLOUD_ORIGIN_DEVICE_ID } from './constants';

export interface EmitParams<TData = unknown> {
  entity: string;
  op: string;
  entityId: UUID;
  /** `null` = global master data (visible to every subscriber). */
  locationId: UUID | null;
  actorUserId: UUID;
  data: TData;
  /** Defaults to `now()`; cloud-born facts rarely need a different value. */
  occurredAt?: string;
  schemaV?: number;
}

@Injectable()
export class SyncEmitService {
  constructor(
    private readonly events: SyncEventsRepository,
    private readonly conflictDetector: ConflictDetectorService,
  ) {}

  /**
   * Emits one cloud-origin event, durably, immediately `applied` (the cloud
   * needs no authority check against itself). Runs INSIDE the caller's own
   * transaction when `client` is supplied (so the domain write and the sync
   * event commit atomically, per collision rule 6's intent — a module that
   * writes without emitting silently breaks offline outlets); opens its own
   * transaction otherwise.
   */
  async emit<TData = unknown>(
    client: DbClient | undefined,
    params: EmitParams<TData>,
  ): Promise<SyncEventEnvelope<TData>> {
    // FIXED (was checking `resolveDirection(entity)` against 'pull'/'bidirectional' — wrong axis, per
    // W3-07/the coordinator's report). `sj_drops.*`, `sj_temperature_logs.logged`, `goods_receipts
    // .recorded`, `attendance.*`, and any other class-F/B entity whose direction happens to be declared
    // `'push'` normally originates at a device (a driver's tablet, a cashier's phone) — but the SAME fact
    // can legitimately originate at the cloud too (a warehouse clerk marking a drop received through the
    // web UI, HR entering an attendance correction, a desktop waste entry). `canOriginate()` ALREADY
    // encodes exactly this: it checks the op is in the entity's known vocabulary (`meta.ops` — the thing
    // that's genuinely empty for class X/D/T, which is the ONLY case that should ever be rejected here),
    // then unconditionally returns `true` for `SyncOriginType.CLOUD` regardless of the entity's
    // device-facing `direction` label (`packages/sync-protocol/src/authority-matrix.ts`: "The cloud tier
    // is exempt... and always returns `true` for a known `(entity, op)` pair regardless of direction").
    // Delegating to it directly — rather than re-deriving a parallel condition from `direction` — is what
    // keeps this guard from drifting out of sync with the SAME authority data `checkAuthority` (the
    // device-ingest path) already enforces correctly.
    if (!canOriginate(SyncOriginType.CLOUD, params.entity, params.op)) {
      throw new Error(
        `SyncEmitService.emit: '${params.entity}.${params.op}' is not a known op for this entity, or the entity is class X/D/T (never on the wire in either direction) — see @mimi/sync-protocol's AUTHORITY data`,
      );
    }

    const run = async (c: DbClient): Promise<SyncEventEnvelope<TData>> => {
      const clientSeq = await this.events.nextCloudClientSeq(c);
      const occurredAt = params.occurredAt ?? new Date().toISOString();
      const payload: SyncPayload<TData> = {
        v: params.schemaV ?? 1,
        data: params.data,
        meta: { actorUserId: params.actorUserId, actorRole: 'cloud', appVersion: 'cloud' },
      };
      const envelope: SyncEventEnvelope<TData> = {
        eventId: formatUuidV7(Date.now(), randomBytes(16)),
        originTier: SyncOriginType.CLOUD,
        originDeviceId: CLOUD_ORIGIN_DEVICE_ID,
        locationId: params.locationId,
        entity: params.entity,
        entityId: params.entityId,
        op: params.op,
        payload,
        clientSeq,
        occurredAt,
        actorUserId: params.actorUserId,
        schemaV: payload.v,
      };

      await this.events.insertEvent(c, {
        event: envelope as unknown as SyncEventEnvelope,
        applyStatus: 'applied',
        batchId: null,
        appliedAt: new Date().toISOString(),
        relayReceivedAt: occurredAt,
      });
      await this.conflictDetector.detectAtApply(c, envelope as unknown as SyncEventEnvelope);
      return envelope;
    };

    if (client) return run(client);
    return this.events.withTransaction(run);
  }
}
