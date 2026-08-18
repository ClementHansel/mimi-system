import { describe, it, expect } from 'vitest';
import { SyncEntity, SyncOriginType } from '@mimi/shared';
import {
  assembleBatches,
  estimateEventBytes,
  groupByOrigin,
  isStaleGap,
  processOriginBatch,
  retryBackoffMs,
  sortByClientSeq,
  type SequencedEvent,
} from './cursor';
import type { SyncEventEnvelope } from './types';

function ev(
  originDeviceId: string,
  clientSeq: number,
  eventId = `${originDeviceId}-${clientSeq}`,
): SequencedEvent {
  return { originDeviceId, clientSeq: BigInt(clientSeq), eventId };
}

describe('groupByOrigin / sortByClientSeq', () => {
  it('groups events by origin and preserves membership', () => {
    const events = [ev('a', 1), ev('b', 1), ev('a', 2)];
    const groups = groupByOrigin(events);
    expect(groups.get('a')).toHaveLength(2);
    expect(groups.get('b')).toHaveLength(1);
  });

  it('sorts ascending by client_seq', () => {
    const sorted = sortByClientSeq([ev('a', 3), ev('a', 1), ev('a', 2)]);
    expect(sorted.map((e) => e.clientSeq)).toEqual([1n, 2n, 3n]);
  });
});

describe('processOriginBatch — the normal case', () => {
  it('applies a fully gapless run starting right after the high-water mark', () => {
    const result = processOriginBatch([ev('a', 1), ev('a', 2), ev('a', 3)], 0n);
    expect(result.applied.map((e) => e.clientSeq)).toEqual([1n, 2n, 3n]);
    expect(result.newHighWater).toBe(3n);
    expect(result.gapAt).toBeUndefined();
    expect(result.parked).toHaveLength(0);
  });

  it('drops exact re-deliveries as duplicates (no-op re-delivery)', () => {
    const result = processOriginBatch([ev('a', 1), ev('a', 2)], 2n);
    expect(result.duplicates).toHaveLength(2);
    expect(result.applied).toHaveLength(0);
    expect(result.newHighWater).toBe(2n);
  });
});

describe('processOriginBatch — gap handling (§4.4)', () => {
  it('parks everything from the gap onward and reports resend_from via gapAt', () => {
    // High-water is 5480; batch starts at 5490 -> gap at 5481.
    const result = processOriginBatch([ev('a', 5490), ev('a', 5491)], 5480n);
    expect(result.applied).toHaveLength(0);
    expect(result.gapAt).toBe(5481n);
    expect(result.parked.map((e) => e.clientSeq)).toEqual([5490n, 5491n]);
    expect(result.newHighWater).toBe(5480n); // unchanged
  });

  it('applies the contiguous prefix before a mid-batch gap, then parks the rest', () => {
    const result = processOriginBatch([ev('a', 1), ev('a', 2), ev('a', 5)], 0n);
    expect(result.applied.map((e) => e.clientSeq)).toEqual([1n, 2n]);
    expect(result.gapAt).toBe(3n);
    expect(result.parked.map((e) => e.clientSeq)).toEqual([5n]);
    expect(result.newHighWater).toBe(2n);
  });
});

describe('processOriginBatch — seq_conflict (§2.2 rule 4)', () => {
  it('flags a same-seq, different-event_id arrival as a conflict, not a duplicate', () => {
    const knownEventIdAtSeq = (seq: bigint) => (seq === 1n ? 'original-event-id' : undefined);
    const result = processOriginBatch([ev('a', 1, 'a-different-event-id')], 1n, knownEventIdAtSeq);
    expect(result.seqConflicts).toEqual([
      { incoming: ev('a', 1, 'a-different-event-id'), conflictsWithSeq: 1n },
    ]);
    expect(result.duplicates).toHaveLength(0);
  });

  it('a same-seq, same-event_id arrival is a plain duplicate, not a conflict', () => {
    const knownEventIdAtSeq = (seq: bigint) => (seq === 1n ? 'a-1' : undefined);
    const result = processOriginBatch([ev('a', 1)], 1n, knownEventIdAtSeq);
    expect(result.seqConflicts).toHaveLength(0);
    expect(result.duplicates).toHaveLength(1);
  });
});

describe('isStaleGap', () => {
  it('is false within the threshold and true past it', () => {
    const detectedAt = 0;
    expect(isStaleGap(detectedAt, 59 * 60 * 1000)).toBe(false);
    expect(isStaleGap(detectedAt, 61 * 60 * 1000)).toBe(true);
  });
});

describe('assembleBatches', () => {
  it('splits by max event count', () => {
    const events = Array.from({ length: 450 }, (_, i) => i);
    const batches = assembleBatches(events, () => 1, 200, 1_000_000);
    expect(batches.map((b) => b.length)).toEqual([200, 200, 50]);
  });

  it('splits by max byte size', () => {
    const events = Array.from({ length: 10 }, (_, i) => i);
    const batches = assembleBatches(events, () => 300, 200, 1000); // 3 events fit per 1000-byte batch
    expect(batches.every((b) => b.length <= 3)).toBe(true);
    expect(batches.flat()).toEqual(events);
  });

  it('gives an oversized single event its own batch rather than dropping it', () => {
    const batches = assembleBatches(['huge'], () => 5_000_000, 200, 1_000_000);
    expect(batches).toEqual([['huge']]);
  });

  it('returns no batches for an empty input', () => {
    expect(assembleBatches([], () => 1)).toEqual([]);
  });
});

describe('estimateEventBytes — must survive a REAL envelope, not just hand-built test objects', () => {
  function realEnvelope(clientSeq: bigint): SyncEventEnvelope {
    return {
      eventId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      originTier: SyncOriginType.DEVICE,
      originDeviceId: 'device-1',
      locationId: 'loc-1',
      entity: SyncEntity.SALES,
      entityId: 'sale-1',
      op: 'completed',
      payload: {
        v: 1,
        data: { total: '135000.00' },
        meta: { actorUserId: 'user-1', actorRole: 'kasir', appVersion: '1.4.2' },
      },
      clientSeq,
      occurredAt: '2026-08-17T05:00:00.000Z',
      actorUserId: 'user-1',
      schemaV: 1,
    };
  }

  it('does not throw on an envelope whose clientSeq is a bigint (the reported bug)', () => {
    // `JSON.stringify` on a bare bigint throws `TypeError: Do not know how to
    // serialize a BigInt` — clientSeq is ALWAYS a bigint on a real envelope
    // (`SyncEventEnvelope.clientSeq`, ../types.ts), so this must never throw.
    expect(() => estimateEventBytes(realEnvelope(42n))).not.toThrow();
  });

  it('does not throw for a clientSeq beyond Number.MAX_SAFE_INTEGER', () => {
    expect(() => estimateEventBytes(realEnvelope(9_007_199_254_740_993n))).not.toThrow();
  });

  it('returns a sane, non-zero byte estimate that reflects the clientSeq digits', () => {
    const small = estimateEventBytes(realEnvelope(1n));
    const large = estimateEventBytes(realEnvelope(9_007_199_254_740_993n));
    expect(small).toBeGreaterThan(0);
    expect(large).toBeGreaterThan(small); // more digits -> a (slightly) larger estimate
  });

  it('assembleBatches works end-to-end over real envelopes with bigint clientSeq, using the default estimator', () => {
    const events = [realEnvelope(1n), realEnvelope(2n), realEnvelope(9_007_199_254_740_993n)];
    expect(() => assembleBatches(events)).not.toThrow();
    expect(assembleBatches(events).flat()).toEqual(events);
  });
});

describe('retryBackoffMs', () => {
  it('doubles each attempt up to the cap, jitter-free at jitterFn=0.5', () => {
    expect(retryBackoffMs(0)).toBe(1000);
    expect(retryBackoffMs(1)).toBe(2000);
    expect(retryBackoffMs(2)).toBe(4000);
  });

  it('caps at the maximum regardless of attempt number', () => {
    expect(retryBackoffMs(20)).toBe(5 * 60 * 1000);
  });

  it('applies jitter within ±20%', () => {
    const low = retryBackoffMs(3, () => 0);
    const high = retryBackoffMs(3, () => 1);
    const base = 8000;
    expect(low).toBeCloseTo(base * 0.8, -1);
    expect(high).toBeCloseTo(base * 1.2, -1);
  });

  it('rejects a negative attempt', () => {
    expect(() => retryBackoffMs(-1)).toThrow(RangeError);
  });
});
