/**
 * The atomic outbox commit — SYNC-PROTOCOL §2.2, THE load-bearing rule this
 * entire runtime exists to satisfy: "the W2-E runtime executes ONE IndexedDB
 * transaction that atomically (a) mints event_id, (b) increments the durable
 * client_seq counter, (c) writes the event row to the outbox, and (d)
 * applies the local projection. Commit of this transaction IS the acceptance
 * of the action."
 *
 * Consequences this function is built to honor:
 *  - Rule 1 (atomicity): if the transaction fails (quota, crash), the action
 *    visibly did not happen. There is no code path here that writes the
 *    outbox row without also writing whatever local projection the caller
 *    supplied, or vice versa — `db.runTransaction` guarantees that (see
 *    `store/local-database.ts`).
 *  - Rule 2 (no re-minting): every transmission re-reads this same row; nothing
 *    downstream of this function ever mints a second `event_id` for one
 *    committed action. That is `sync/outbox-drain.ts`'s job.
 *  - Rule 3 (double-tap guard): the caller binds `entityId` at DRAFT time
 *    (before the user can even tap submit) and passes the SAME `entityId` on
 *    every retry of that one action. This function looks up an existing
 *    outbox row by `(entity, entityId, op)` first and returns it unchanged
 *    rather than minting a second event — two rapid submits of one draft
 *    race on the same lookup and cannot enqueue twice. Submitting a NEW
 *    action after a completed one (a fresh `entityId`) is a new fact by
 *    design (two identical sales are legal, §2.2 rule 3's own wording).
 *  - Rule 4 (uniqueness): `event_id` PK + `(origin_device_id, client_seq)`
 *    uniqueness are upstream's job (cloud/node); this function's job is only
 *    to never produce a collision from ITS side, which gapless counter
 *    increment-in-the-same-tx guarantees.
 *  - Rule 5: UUIDv7 via `@mimi/sync-protocol`'s `formatUuidV7`.
 */
import { canOriginate } from '@mimi/sync-protocol';
import type { SyncEventEnvelope, SyncPayloadMeta } from '@mimi/sync-protocol';
import { SyncOriginType } from '@mimi/shared';
import type { ISODateTime, UUID } from '@mimi/shared';
import type { LocalDatabase, StoreOps, TxHandle } from './store/local-database';
import type { ClientSeqCounter, DeviceIdentity, OutboxRecord } from './types';
import { cryptoRandomSource, mintEventId, type RandomSource } from './identity';
import { stampNow } from './clock/clock';
import type { ClockState } from './types';

export interface CommitFactInput<TData = unknown> {
  entity: string;
  op: string;
  /** Client-minted at draft time — the same id on every retry of ONE action (§2.2 rule 3). */
  entityId: UUID;
  data: TData;
  meta: Omit<SyncPayloadMeta, 'clockOffsetMs' | 'rawDeviceTime'>;
  schemaV?: number;
  /**
   * Runs INSIDE the same atomic transaction, after the outbox row is queued
   * but before commit — the "(d) applies the local projection" half of
   * §2.2's rule 1. Typically `stock/stock-cache.ts`'s `record*ToMovements`
   * helpers. Omitted for facts with no stock effect (attendance, petty cash…).
   */
  projectWithin?: (tx: TxHandle, envelope: SyncEventEnvelope<TData>) => Promise<void>;
}

export interface CommitFactResult<TData = unknown> {
  record: OutboxRecord;
  /** `true` if an existing outbox row for this `(entity, entityId, op)` was found and returned instead of a new one (the double-tap guard fired). */
  wasAlreadyCommitted: boolean;
  envelope: SyncEventEnvelope<TData>;
}

const REQUIRED_STORES = ['device_identity', 'client_seq_counter', 'outbox'] as const;

export async function commitFact<TData = unknown>(
  db: LocalDatabase,
  input: CommitFactInput<TData>,
  extraStoresForProjection: readonly string[] = [],
  random: RandomSource = cryptoRandomSource,
): Promise<CommitFactResult<TData>> {
  if (!canOriginate(SyncOriginType.DEVICE, input.entity, input.op)) {
    throw new Error(
      `ERR_SYNC_AUTHORITY_VIOLATION: device may not originate (${input.entity}, ${input.op}) — check the authority matrix`,
    );
  }

  const storeNames = [...REQUIRED_STORES, 'clock_state', ...extraStoresForProjection];

  return db.runTransaction(storeNames, 'readwrite', async (tx) => {
    const outboxStore = tx.store<OutboxRecord>('outbox');
    const existing = await findExisting(outboxStore, input.entity, input.entityId, input.op);
    if (existing) {
      return { record: existing, wasAlreadyCommitted: true, envelope: existing.envelope as SyncEventEnvelope<TData> };
    }

    const identity = await tx.store<DeviceIdentity>('device_identity').get('self');
    if (!identity) throw new Error('Device identity not initialized — call ensureDeviceIdentity() first');

    const counterStore = tx.store<ClientSeqCounter>('client_seq_counter');
    const counterRow = await counterStore.get('self');
    const nextSeq = BigInt(counterRow?.value ?? '0') + 1n;
    await counterStore.put({ id: 'self', value: nextSeq.toString() });

    const clockState = (await tx.store<ClockState>('clock_state').get('self')) ?? {
      id: 'self' as const,
      offsetMs: 0,
      samples: [],
      lastMeasuredAt: null,
    };
    const stamped = stampNow(clockState);

    const eventId = mintEventId(random);
    const envelope: SyncEventEnvelope<TData> = {
      eventId,
      originTier: SyncOriginType.DEVICE,
      originDeviceId: identity.originDeviceId,
      locationId: identity.locationId,
      entity: input.entity,
      entityId: input.entityId,
      op: input.op,
      payload: {
        v: input.schemaV ?? 1,
        data: input.data,
        meta: {
          ...input.meta,
          clockOffsetMs: stamped.clockOffsetMs,
          rawDeviceTime: stamped.rawDeviceTime,
        },
      },
      clientSeq: nextSeq,
      occurredAt: stamped.occurredAt,
      relayReceivedAt: null,
      relayedViaNodeId: null,
      actorUserId: input.meta.actorUserId,
      schemaV: input.schemaV ?? 1,
    };

    const record: OutboxRecord = {
      eventId,
      envelope: envelope as SyncEventEnvelope,
      status: 'pending',
      attempt: 0,
      lastAttemptAt: null,
      lastError: null,
      createdAt: stamped.rawDeviceTime,
    };

    await outboxStore.put(record);

    if (input.projectWithin) {
      await input.projectWithin(tx, envelope);
    }

    return { record, wasAlreadyCommitted: false, envelope };
  });
}

async function findExisting(
  store: StoreOps<OutboxRecord>,
  entity: string,
  entityId: UUID,
  op: string,
): Promise<OutboxRecord | undefined> {
  const all = await store.getAll();
  return all.find((r) => r.envelope.entity === entity && r.envelope.entityId === entityId && r.envelope.op === op);
}

/** Convenience: read the outbox depth (queued, not yet cloud-confirmed) — feeds `SyncStatusPill`/heartbeats. */
export async function getOutboxDepth(db: LocalDatabase): Promise<number> {
  return db.store<OutboxRecord>('outbox').count();
}

export function nowIso(): ISODateTime {
  return new Date().toISOString();
}
