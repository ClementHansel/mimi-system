/**
 * The push side of the sync engine — SYNC-PROTOCOL §4.3. Drains the durable
 * outbox against whichever upstream `upstream-selector.ts` currently holds,
 * respecting:
 *  - batch assembly (`assembleBatches`, ≤200 events / ≤1MB, §4.3),
 *  - "one outstanding push batch per upstream connection" (sequential await,
 *    never `Promise.all` over batches),
 *  - the two-level ack (`accepted` vs `confirmed`, §4.3) — an outbox row
 *    prunes ONLY at `confirmed`, never merely `accepted` (this is what makes
 *    "total node loss loses nothing" true — a row the node accepted but
 *    hadn't yet relayed is STILL in the device's outbox and gets re-pushed
 *    cloud-direct after failover),
 *  - permanent rejects moving straight to `outbox_quarantine` (§4.4:
 *    "rejected ≠ lost" — the row is dead, not missing, and is removed from
 *    the retry path immediately rather than retried forever),
 *  - exponential backoff on transport failure (`retryBackoffMs`, §4.3).
 */
import { assembleBatches, retryBackoffMs, type SyncEventEnvelope, type SyncPushBatch } from '@mimi/sync-protocol';
import type { LocalDatabase } from '../store/local-database';
import type { OutboxRecord, PushAckState, QuarantineRecord } from '../types';
import type { SyncTransport } from '../transport/types';
import { mintEventId, type RandomSource, cryptoRandomSource } from '../identity';
import { MAX_EVENTS_PER_PUSH_BATCH, MAX_PUSH_BATCH_BYTES } from '../constants';

export interface DrainResult {
  batchesSent: number;
  eventsPushed: number;
  eventsConfirmed: number;
  eventsQuarantined: number;
  /** `true` if the transport itself failed (network down / upstream unhealthy) — caller should back off before retrying. */
  transportFailed: boolean;
  resendFrom?: Record<string, number>;
}

const STORES = ['outbox', 'outbox_quarantine', 'push_ack_state'] as const;

export async function drainOutboxOnce(
  db: LocalDatabase,
  transport: SyncTransport,
  baseUrl: string,
  random: RandomSource = cryptoRandomSource,
): Promise<DrainResult> {
  const rows = await db.store<OutboxRecord>('outbox').getAll();
  if (rows.length === 0) {
    return { batchesSent: 0, eventsPushed: 0, eventsConfirmed: 0, eventsQuarantined: 0, transportFailed: false };
  }

  const byEventId = new Map<string, OutboxRecord>(rows.map((r) => [r.eventId, r]));
  const sorted = [...rows].sort((a, b) => (a.envelope.clientSeq < b.envelope.clientSeq ? -1 : a.envelope.clientSeq > b.envelope.clientSeq ? 1 : 0));
  const batches = assembleBatches(
    sorted.map((r) => r.envelope),
    (e) => JSON.stringify(e, bigintSafeReplacer).length,
    MAX_EVENTS_PER_PUSH_BATCH,
    MAX_PUSH_BATCH_BYTES,
  );

  let eventsConfirmed = 0;
  let eventsQuarantined = 0;
  let batchesSent = 0;
  let resendFrom: Record<string, number> | undefined;

  for (const events of batches) {
    const batch: SyncPushBatch = { batchId: mintEventId(random), sentAt: new Date().toISOString(), events };

    let ack;
    try {
      ack = await transport.push(baseUrl, batch);
    } catch {
      // Transport failure: mark attempts on the rows we tried to send, stop draining, let the caller back off (§4.3 retry).
      await db.runTransaction(['outbox'], 'readwrite', async (tx) => {
        const store = tx.store<OutboxRecord>('outbox');
        for (const e of events) {
          const row = byEventId.get(e.eventId);
          if (!row) continue;
          await store.put({ ...row, attempt: row.attempt + 1, lastAttemptAt: new Date().toISOString(), lastError: 'transport_failure' });
        }
      });
      return { batchesSent, eventsPushed: 0, eventsConfirmed, eventsQuarantined, transportFailed: true };
    }

    batchesSent += 1;
    resendFrom = ack.resendFrom;

    await db.runTransaction(STORES, 'readwrite', async (tx) => {
      const outboxStore = tx.store<OutboxRecord>('outbox');
      const quarantineStore = tx.store<QuarantineRecord>('outbox_quarantine');
      const ackStore = tx.store<PushAckState>('push_ack_state');

      const rejectedIds = new Map(ack.rejected.map((r) => [r.eventId, r]));

      for (const e of events) {
        const rejection = rejectedIds.get(e.eventId);
        if (rejection) {
          await quarantineStore.put({
            eventId: e.eventId,
            envelope: e,
            code: rejection.code,
            detail: rejection.detail,
            quarantinedAt: new Date().toISOString(),
          });
          await outboxStore.delete(e.eventId);
          eventsQuarantined += 1;
        }
      }

      const confirmedThrough = BigInt(ack.confirmedThrough[events[0]!.originDeviceId] ?? 0);
      const acceptedThrough = BigInt(ack.acceptedThrough[events[0]!.originDeviceId] ?? 0);

      await ackStore.put({ id: 'self', acceptedThrough: acceptedThrough.toString(), confirmedThrough: confirmedThrough.toString() });

      for (const e of events) {
        if (rejectedIds.has(e.eventId)) continue;
        if (e.clientSeq <= confirmedThrough) {
          await outboxStore.delete(e.eventId);
          eventsConfirmed += 1;
        } else if (e.clientSeq <= acceptedThrough) {
          const row = byEventId.get(e.eventId);
          if (row) await outboxStore.put({ ...row, status: 'accepted', lastAttemptAt: new Date().toISOString() });
        }
      }
    });
  }

  return {
    batchesSent,
    eventsPushed: sorted.length,
    eventsConfirmed,
    eventsQuarantined,
    transportFailed: false,
    resendFrom,
  };
}

/** Backoff helper for the caller's retry loop after a `transportFailed` result. */
export function backoffFor(attempt: number): number {
  return retryBackoffMs(attempt);
}

/** `clientSeq` is a `bigint` (§2.1) — `JSON.stringify` can't serialize it natively; this is size-ESTIMATION only (batch-splitting), never the actual wire encoding (see `transport/http-transport.ts`'s `serializeBatch` for that). */
function bigintSafeReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

export type { SyncEventEnvelope };
