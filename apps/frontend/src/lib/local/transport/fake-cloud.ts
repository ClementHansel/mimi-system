/**
 * A fake cloud sync engine speaking exactly the wire contract of
 * SYNC-PROTOCOL §4 — used by every test in this package because W2-D (the
 * real cloud engine) is built concurrently and neither side sees the other's
 * code before Gate G2. This is also the artifact for the "what did W2-E
 * assume about W2-D's wire contract" question in the package report.
 *
 * What it implements faithfully (§3.4 steps 1-2, §4.3, §4.4, §4.5):
 *  - idempotent push via `event_id` PK (duplicates ack as accepted, no-op)
 *  - gapless per-origin ordering via `processOriginBatch` (the SAME function
 *    the cloud is specified to use — §4.4's algorithm, not a re-implementation)
 *  - `seq_conflict` origin-freeze (§2.2 rule 4, §4.4)
 *  - `malformed` / `authority_violation` permanent rejects via `canOriginate`
 *    (§3.4 steps 1-2) — rejected events still advance the high-water mark
 *    (§4.4: "rejected ≠ lost")
 *  - two-level ack: this fake behaves as the CLOUD tier directly (no relay
 *    hop), so `acceptedThrough === confirmedThrough` always, matching §4.3's
 *    "when the upstream is the cloud, the levels coincide." A NODE relay hop
 *    with independent confirmation timing is simulated separately by
 *    `FakeRelayNode` below, for T-04/T-11/T-12-style tests.
 *  - pull via a gapless `server_seq` in arrival order (§4.5)
 *
 * What it deliberately does NOT implement (out of scope for a device-side
 * fake, flagged as an assumption): §3.4 step 3 (location-match), step 4
 * (RBAC-at-`occurred_at`), §3.2 field projection, §5 conflict-queue rows, and
 * real persistence (it is memory-only, restart-per-test by design).
 */
import {
  canOriginate,
  groupByOrigin,
  processOriginBatch,
  sortByClientSeq,
  type SyncEventEnvelope,
  type SyncHelloAck,
  type SyncHelloRequest,
  type SyncPullResult,
  type SyncPushAck,
  type SyncPushBatch,
} from '@mimi/sync-protocol';
import { SyncOriginType } from '@mimi/shared';
import type { UUID } from '@mimi/shared';
import type { HeartbeatAck, HeartbeatPayload, SyncHealth, SyncTransport } from './types';

interface StoredEvent {
  envelope: SyncEventEnvelope;
  serverSeq: number;
  applyStatus: 'applied' | 'quarantined' | 'pending_dependency';
  rejectCode?: string;
}

export interface FakeCloudOptions {
  /** Simulates transient upstream trouble: every push/pull/hello/health call fails until healthy is set back to true. */
  healthy?: boolean;
  /** Injects a hard failure for the next N push calls (T-04-style node-loss simulation at a layer above this). */
  protocolV?: number;
}

export class FakeCloud implements SyncTransport {
  private events: StoredEvent[] = [];
  private highWater = new Map<UUID, bigint>();
  private frozenOrigins = new Set<UUID>();
  private nextServerSeq = 1;
  healthy: boolean;
  protocolV: number;

  constructor(opts: FakeCloudOptions = {}) {
    this.healthy = opts.healthy ?? true;
    this.protocolV = opts.protocolV ?? 1;
  }

  /** Test hook: everything applied so far, for state-checksum-style assertions. */
  appliedEvents(): SyncEventEnvelope[] {
    return this.events.filter((e) => e.applyStatus === 'applied').map((e) => e.envelope);
  }

  /** Test hook (used by `FakeRelayNode` to learn what it may report as `confirmedThrough` after relaying — §4.3's "disseminates confirmed_through... on every subsequent ack"). */
  confirmedThroughFor(originId: UUID): bigint {
    return this.highWater.get(originId) ?? 0n;
  }

  quarantinedEvents(): StoredEvent[] {
    return this.events.filter((e) => e.applyStatus === 'quarantined');
  }

  async health(): Promise<SyncHealth> {
    if (!this.healthy) throw new Error('FakeCloud: unhealthy');
    return {
      ok: true,
      protocolV: this.protocolV,
      serverTime: new Date().toISOString(),
      tier: 'cloud',
    };
  }

  async hello(_baseUrl: string, req: SyncHelloRequest): Promise<SyncHelloAck> {
    if (!this.healthy) throw new Error('FakeCloud: unhealthy');
    const confirmedThrough: Record<string, number> = {};
    for (const [origin, seq] of this.highWater) confirmedThrough[origin] = Number(seq);
    return {
      ok: true,
      protocolV: this.protocolV,
      serverTime: new Date().toISOString(),
      resumeCursor: req.pullCursor,
      confirmedThrough,
      scope: {
        globalMaster: true,
        locationIds: req.locationIds,
        projectionRole: 'pos_device',
        excludeOrigin: req.subscriberId,
      },
    };
  }

  async push(_baseUrl: string, batch: SyncPushBatch): Promise<SyncPushAck> {
    if (!this.healthy) throw new Error('FakeCloud: unhealthy');

    const rejected: SyncPushAck['rejected'] = [];
    const acceptedThrough: Record<string, number> = {};
    const resendFrom: Record<string, number> = {};

    const byOrigin = groupByOrigin(
      batch.events.map((e) => ({ ...e, originDeviceId: e.originDeviceId })),
    );

    for (const [originId, events] of byOrigin) {
      const sorted = sortByClientSeq(events);

      if (this.frozenOrigins.has(originId)) {
        for (const e of sorted)
          rejected.push({
            eventId: e.eventId,
            code: 'seq_conflict',
            detail: 'origin frozen (prior seq_conflict)',
          });
        acceptedThrough[originId] = Number(this.highWater.get(originId) ?? 0n);
        continue;
      }

      const currentHighWater = this.highWater.get(originId) ?? 0n;
      const knownEventIdAtSeq = (seq: bigint): UUID | undefined =>
        this.events.find(
          (e) => e.envelope.originDeviceId === originId && e.envelope.clientSeq === seq,
        )?.envelope.eventId;

      const result = processOriginBatch(sorted, currentHighWater, knownEventIdAtSeq);

      for (const e of result.applied) {
        const reject = this.classify(e);
        const stored: StoredEvent = {
          envelope: e,
          serverSeq: this.nextServerSeq++,
          applyStatus: reject ? 'quarantined' : 'applied',
          rejectCode: reject,
        };
        this.events.push(stored);
        if (reject)
          rejected.push({ eventId: e.eventId, code: reject, detail: `rejected: ${reject}` });
      }

      for (const parked of result.parked) {
        this.events.push({
          envelope: parked,
          serverSeq: this.nextServerSeq++,
          applyStatus: 'pending_dependency',
        });
      }

      for (const conflict of result.seqConflicts) {
        this.frozenOrigins.add(originId);
        rejected.push({
          eventId: conflict.incoming.eventId,
          code: 'seq_conflict',
          detail: `clientSeq ${conflict.conflictsWithSeq} already has a different event_id`,
        });
      }

      this.highWater.set(originId, result.newHighWater);
      acceptedThrough[originId] = Number(result.newHighWater);
      if (result.gapAt !== undefined) resendFrom[originId] = Number(result.gapAt);
    }

    return {
      batchId: batch.batchId,
      acceptedThrough,
      confirmedThrough: acceptedThrough, // fake IS cloud: levels coincide (§4.3)
      rejected,
      ...(Object.keys(resendFrom).length > 0 ? { resendFrom } : {}),
    };
  }

  async pull(_baseUrl: string, cursor: number, limit: number): Promise<SyncPullResult> {
    if (!this.healthy) throw new Error('FakeCloud: unhealthy');
    const applied = this.events
      .filter((e) => e.applyStatus === 'applied' && e.serverSeq > cursor)
      .sort((a, b) => a.serverSeq - b.serverSeq);
    const page = applied.slice(0, limit);
    const nextCursor = page.length > 0 ? page[page.length - 1]!.serverSeq : cursor;
    return {
      events: page.map((e) => e.envelope),
      nextCursor,
      hasMore: applied.length > page.length,
    };
  }

  async heartbeat(_baseUrl: string, _payload: HeartbeatPayload): Promise<HeartbeatAck> {
    if (!this.healthy) throw new Error('FakeCloud: unhealthy');
    return { ok: true, serverTime: new Date().toISOString() };
  }

  /** §3.4 steps 1-2 only (see file header for what's out of scope). */
  private classify(e: SyncEventEnvelope): string | undefined {
    if (!canOriginate(e.originTier as SyncOriginType, e.entity, e.op)) {
      const known = canOriginate(SyncOriginType.CLOUD, e.entity, e.op);
      return known ? 'authority_violation' : 'malformed';
    }
    return undefined;
  }
}
