/**
 * Cursor and ordering helpers — SYNC-PROTOCOL §2.1 (`client_seq`), §4.3-4.5
 * (push/pull, batch assembly), §4.4 (gaps and `seq_conflict`).
 *
 * Ordering authority is `client_seq` per origin (§6.1) — wall clocks never
 * order anything. Everything here operates on that one axis.
 */
import type { UUID } from '@mimi/shared';

export interface SequencedEvent {
  originDeviceId: UUID;
  eventId: UUID;
  clientSeq: bigint;
}

export function groupByOrigin<T extends SequencedEvent>(events: readonly T[]): Map<UUID, T[]> {
  const groups = new Map<UUID, T[]>();
  for (const e of events) {
    const list = groups.get(e.originDeviceId);
    if (list) list.push(e);
    else groups.set(e.originDeviceId, [e]);
  }
  return groups;
}

/** Ascending by `client_seq` — the order the upstream must apply one origin's events in (§4.4). */
export function sortByClientSeq<T extends SequencedEvent>(events: readonly T[]): T[] {
  return [...events].sort((a, b) =>
    a.clientSeq < b.clientSeq ? -1 : a.clientSeq > b.clientSeq ? 1 : 0,
  );
}

export interface OriginBatchResult<T extends SequencedEvent> {
  originDeviceId: UUID;
  /** Already durably stored at or below the current high-water — ack as accepted, discard (no-op re-delivery). */
  duplicates: T[];
  /** The contiguous run starting exactly at `currentHighWater + 1`, safe to apply now. */
  applied: T[];
  /** `currentHighWater` unchanged if nothing new applied. */
  newHighWater: bigint;
  /** First missing seq, if a gap was found partway through this batch. */
  gapAt?: bigint;
  /** Events at/after the gap — stored as `pending_dependency`, not applied yet (§4.4). */
  parked: T[];
  /** Same seq as an already-known one but a DIFFERENT `eventId` — a cloned/corrupted store (§2.2 rule 4, permanent `seq_conflict`). */
  seqConflicts: { incoming: T; conflictsWithSeq: bigint }[];
}

/**
 * Processes one origin's batch (already sorted ascending by `clientSeq`)
 * against its current gapless high-water mark. Detects duplicates (silently
 * dropped — the origin resent something already durable), the contiguous
 * appliable run, and a gap (parks everything from the gap onward and reports
 * `resend_from` via `gapAt`).
 *
 * `knownEventIdAtSeq` is an optional lookup the caller provides (e.g. backed
 * by its actual storage) to detect `seq_conflict`: the same `clientSeq`
 * arriving with a different `eventId` than what was already durably stored
 * there.
 */
export function processOriginBatch<T extends SequencedEvent>(
  sortedEvents: readonly T[],
  currentHighWater: bigint,
  knownEventIdAtSeq?: (seq: bigint) => UUID | undefined,
): OriginBatchResult<T> {
  const duplicates: T[] = [];
  const applied: T[] = [];
  const parked: T[] = [];
  const seqConflicts: { incoming: T; conflictsWithSeq: bigint }[] = [];
  let highWater = currentHighWater;
  let gapAt: bigint | undefined;
  const originDeviceId = sortedEvents[0]?.originDeviceId ?? ('' as UUID);

  for (const event of sortedEvents) {
    if (gapAt !== undefined) {
      parked.push(event);
      continue;
    }

    if (event.clientSeq <= currentHighWater) {
      const knownId = knownEventIdAtSeq?.(event.clientSeq);
      if (knownId !== undefined && knownId !== event.eventId) {
        seqConflicts.push({ incoming: event, conflictsWithSeq: event.clientSeq });
      } else {
        duplicates.push(event);
      }
      continue;
    }

    if (event.clientSeq === highWater + 1n) {
      applied.push(event);
      highWater = event.clientSeq;
    } else {
      gapAt = highWater + 1n;
      parked.push(event);
    }
  }

  return {
    originDeviceId,
    duplicates,
    applied,
    newHighWater: highWater,
    gapAt,
    parked,
    seqConflicts,
  };
}

/** `true` past 60 minutes of a persisting gap (§4.4/§5.5 R9 — "possible data loss / cloned store"). */
export function isStaleGap(
  gapDetectedAtMs: number,
  nowMs: number,
  thresholdMs = 60 * 60 * 1000,
): boolean {
  return nowMs - gapDetectedAtMs > thresholdMs;
}

// ── Batch assembly (§4.3) ─────────────────────────────────────────────────────

export const MAX_EVENTS_PER_BATCH = 200;
export const MAX_BATCH_BYTES = 1_000_000; // 1 MB serialized

/**
 * Rough serialized-size estimate for batch-size accounting (the real
 * transport measures the actual bytes; this is for client-side
 * pre-splitting). `SyncEventEnvelope.clientSeq` (`../types`) is a `bigint` —
 * plain `JSON.stringify` throws `TypeError: Do not know how to serialize a
 * BigInt` on that field, so a real envelope must never be passed through the
 * bare stringifier. The replacer below converts any `bigint` to its decimal
 * string form (matching how `client_seq` actually travels on the wire — see
 * `../types`'s file-header note) before measuring length; this is a size
 * estimate, not the wire encoder, so the string-vs-number difference in the
 * estimate is immaterial.
 */
export function estimateEventBytes(event: unknown): number {
  return JSON.stringify(event, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  ).length;
}

/**
 * Splits one origin's outbox (already in `client_seq` order) into push
 * batches obeying the ≤200-events / ≤1MB rule (§4.3). A single
 * over-sized event still gets its own batch rather than being dropped.
 */
export function assembleBatches<T>(
  events: readonly T[],
  sizeOf: (event: T) => number = estimateEventBytes,
  maxEvents = MAX_EVENTS_PER_BATCH,
  maxBytes = MAX_BATCH_BYTES,
): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let currentBytes = 0;

  for (const event of events) {
    const bytes = sizeOf(event);
    const wouldExceedCount = current.length + 1 > maxEvents;
    const wouldExceedBytes = current.length > 0 && currentBytes + bytes > maxBytes;
    if (wouldExceedCount || wouldExceedBytes) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(event);
    currentBytes += bytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

// ── Retry backoff (§4.3) ───────────────────────────────────────────────────────

/** `1s → 2s → 4s → … capped at 5 min`, ±20% jitter. `attempt` is 0-based. `jitterFn` defaults to a mid-range deterministic value for pure testability. */
export function retryBackoffMs(
  attempt: number,
  jitterFn: () => number = () => 0.5,
  capMs = 5 * 60 * 1000,
): number {
  if (attempt < 0) throw new RangeError(`attempt must be >= 0, got ${attempt}`);
  const base = Math.min(1000 * 2 ** attempt, capMs);
  const jitter = jitterFn(); // expected in [0, 1)
  const jitterRange = base * 0.2;
  return Math.round(base - jitterRange + jitter * 2 * jitterRange);
}
