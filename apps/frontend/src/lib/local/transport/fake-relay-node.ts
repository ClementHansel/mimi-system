/**
 * A fake Tier-2 branch node relay — test support for the two-level-ack
 * property (§4.3: "total node loss (disk death) loses nothing") and the
 * node-up/node-down flap scenarios (T-04, T-11, T-12). Sits in front of a
 * `FakeCloud` and deliberately does NOT relay pushes immediately: it accepts
 * them durably (as a real node would) but only forwards to the cloud when
 * `relayPending()` is called, so tests can assert on the gap between
 * `acceptedThrough` (this node) and `confirmedThrough` (the cloud) before
 * ever calling it — and can simulate total node loss via `kill()`, after
 * which relay never happens and whatever it was holding is gone, exactly as
 * disk death would lose it.
 */
import type {
  SyncHelloAck,
  SyncHelloRequest,
  SyncPullResult,
  SyncPushAck,
  SyncPushBatch,
} from '@mimi/sync-protocol';
import type { UUID } from '@mimi/shared';
import type { HeartbeatAck, HeartbeatPayload, SyncHealth, SyncTransport } from './types';
import type { FakeCloud } from './fake-cloud';

export class FakeRelayNode implements SyncTransport {
  private pendingRelay: SyncPushBatch[] = [];
  private acceptedThrough = new Map<UUID, bigint>();
  private alive = true;

  constructor(private readonly cloud: FakeCloud) {}

  kill(): void {
    this.alive = false;
    this.pendingRelay = []; // disk death: whatever wasn't relayed yet is gone
  }

  async health(): Promise<SyncHealth> {
    if (!this.alive) throw new Error('FakeRelayNode: down');
    return { ok: true, protocolV: 1, serverTime: new Date().toISOString(), tier: 'node' };
  }

  async hello(_baseUrl: string, req: SyncHelloRequest): Promise<SyncHelloAck> {
    if (!this.alive) throw new Error('FakeRelayNode: down');
    return {
      ok: true,
      protocolV: 1,
      serverTime: new Date().toISOString(),
      resumeCursor: req.pullCursor,
      confirmedThrough: {},
      scope: {
        globalMaster: true,
        locationIds: req.locationIds,
        projectionRole: 'pos_device',
        excludeOrigin: req.subscriberId,
      },
    };
  }

  async push(_baseUrl: string, batch: SyncPushBatch): Promise<SyncPushAck> {
    if (!this.alive) throw new Error('FakeRelayNode: down');
    this.pendingRelay.push(batch);

    const acceptedThrough: Record<string, number> = {};
    for (const e of batch.events) {
      const current = this.acceptedThrough.get(e.originDeviceId) ?? 0n;
      if (e.clientSeq > current) this.acceptedThrough.set(e.originDeviceId, e.clientSeq);
    }
    for (const [origin, seq] of this.acceptedThrough) acceptedThrough[origin] = Number(seq);

    // confirmedThrough reflects only what the CLOUD already durably has — NOT what this node just
    // accepted (§4.3's two-level ack). Learned from whatever the node last relayed successfully; a
    // batch this node hasn't relayed yet reports whatever the cloud already had BEFORE this push.
    const confirmedThrough: Record<string, number> = {};
    for (const e of batch.events)
      confirmedThrough[e.originDeviceId] = Number(this.cloud.confirmedThroughFor(e.originDeviceId));

    return { batchId: batch.batchId, acceptedThrough, confirmedThrough, rejected: [] };
  }

  /** Forwards everything accepted-but-not-yet-relayed to the underlying cloud, as the node's outbound socket would. No-op once killed. */
  async relayPending(): Promise<void> {
    if (!this.alive) return;
    const batches = this.pendingRelay;
    this.pendingRelay = [];
    for (const batch of batches) {
      await this.cloud.push('irrelevant', batch);
    }
  }

  async pull(baseUrl: string, cursor: number, limit: number): Promise<SyncPullResult> {
    if (!this.alive) throw new Error('FakeRelayNode: down');
    // Simplification (flagged): this fake serves pulls straight from the cloud's applied log rather than
    // maintaining its own mirrored store — real §1.4 node-side projection/fan-out is W2-F's territory.
    return this.cloud.pull(baseUrl, cursor, limit);
  }

  async heartbeat(_baseUrl: string, _payload: HeartbeatPayload): Promise<HeartbeatAck> {
    if (!this.alive) throw new Error('FakeRelayNode: down');
    return { ok: true, serverTime: new Date().toISOString() };
  }
}
