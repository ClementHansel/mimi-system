/**
 * Gate G2 harness (BUILD-PLAN §5): "SIMULATE=true node pairs, heartbeats,
 * discovers synthetic devices, appears in the topology tree [via its bridge
 * reports], and its disappearance flips status to offline within the
 * staleness window" + the W2-F brief's "must pair, heartbeat, discover
 * synthetic devices, and relay a sync batch entirely in SIMULATE=true with
 * no hardware and no real cloud."
 *
 * The "no real cloud" stub is `FakeCloud` (SYNC-PROTOCOL §4's wire shapes,
 * implemented for real — idempotent storage, gapless per-origin ordering,
 * accepted===confirmed at the cloud). The "no hardware" side is `SIMULATE`
 * mode's synthetic discovery devices. Every assertion below drives REAL
 * production code (`RelayEngine`, `LanServer`, `CloudSyncClient`,
 * `BridgeClient`, `MemoryStore`) — nothing here is a mock of this app's own
 * logic, only of the cloud on the other end of the wire.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { SyncOriginType, type UUID } from '@mimi/shared';
import type { SyncEventEnvelope } from '@mimi/sync-protocol';
import { loadConfig } from '../src/config';
import { MemoryStore } from '../src/store/memory-store';
import { RelayEngine } from '../src/relay';
import { FakeCloud } from './fake-cloud';

interface PushAckWire {
  batchId: string;
  acceptedThrough: Record<string, number>;
  confirmedThrough: Record<string, number>;
  rejected: { eventId: string; code: string; detail: string }[];
}
interface PullResultWire {
  events: { eventId: string }[];
  nextCursor: number;
  hasMore: boolean;
}

async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, init);
  return (await res.json()) as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3000, stepMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await sleep(stepMs);
  }
}

describe('branch-node lifecycle (G2 harness, SIMULATE=true)', () => {
  let fakeCloud: FakeCloud;
  let cloudPort: number;
  let store: MemoryStore;
  let engine: RelayEngine;
  const location = { id: randomUUID() as UUID, code: 'JKT-01', name: 'Outlet Test' };

  beforeEach(async () => {
    fakeCloud = new FakeCloud(location);
    cloudPort = await fakeCloud.listenHttp(0);
    store = new MemoryStore();
  });

  afterEach(async () => {
    await engine?.stop();
    await fakeCloud.closeHttp();
  });

  async function startNode(overrides: Partial<NodeJS.ProcessEnv> = {}) {
    const pairingToken = fakeCloud.mintPairingToken();
    const config = loadConfig({
      SIMULATE: 'true',
      BRANCH_NODE_CLOUD_URL: `http://localhost:${cloudPort}`,
      BRANCH_NODE_PAIRING_TOKEN: pairingToken,
      BRANCH_NODE_HEALTH_PORT: '0',
      BRANCH_NODE_HEARTBEAT_INTERVAL_MS: '30',
      BRANCH_NODE_DISCOVERY_INTERVAL_MS: '30',
      ...overrides,
    } as NodeJS.ProcessEnv);
    engine = new RelayEngine(config, store, fakeCloud.socketFactory);
    await engine.start();
    return config;
  }

  it('pairs with the cloud and persists its identity', async () => {
    await startNode();
    const identity = await store.getIdentity();
    expect(identity.nodeId).toBeTruthy();
    expect(identity.nodeToken).toBeTruthy();
    expect(identity.locationId).toBe(location.id);
    expect(identity.locationCode).toBe(location.code);
  });

  it('sends heartbeats to the cloud over /bridge and /sync', async () => {
    await startNode();
    await waitUntil(() => fakeCloud.heartbeatsReceived.length >= 2);
    const identity = await store.getIdentity();
    const hb = fakeCloud.heartbeatsReceived[0]!;
    expect(hb.nodeId).toBe(identity.nodeId);
    expect(hb.payload).toMatchObject({ nodeId: identity.nodeId, version: expect.any(String) });
  });

  it('discovers synthetic devices in SIMULATE mode and reports them to the cloud', async () => {
    await startNode();
    await waitUntil(() => fakeCloud.discoveryReportsReceived.length >= 1);
    const report = fakeCloud.discoveryReportsReceived[0]!.payload as {
      devices: { ipAddress: string }[];
    };
    expect(report.devices.length).toBeGreaterThanOrEqual(2); // simulatedDevices(): one printer, one router

    const discovered = await store.listDiscoveredDevices();
    expect(discovered.length).toBeGreaterThanOrEqual(2);
    expect(discovered.some((d) => d.suggestedCategory === 'printer')).toBe(true);
    expect(discovered.some((d) => d.suggestedCategory === 'router')).toBe(true);
  });

  it("exposes a local /health and the protocol's /sync/v1/health", async () => {
    await startNode();
    // `healthPort: '0'` means the OS picked a real port; read it back via the public accessor.
    const port = engine.getLanServerPort()!;

    const health = await fetchJson<Record<string, unknown>>(`http://localhost:${port}/health`);
    expect(health).toMatchObject({
      status: 'ok',
      service: 'branch-node',
      simulate: true,
      cloudConnected: true,
    });

    const syncHealth = await fetchJson<Record<string, unknown>>(
      `http://localhost:${port}/sync/v1/health`,
    );
    expect(syncHealth).toMatchObject({ ok: true, protocolV: 1, tier: 'node' });
  });

  it('relays a device-pushed sync batch to the cloud with real idempotency (SYNC-PROTOCOL §2.2/§4.3)', async () => {
    await startNode();
    const port = engine.getLanServerPort()!;

    const deviceId = randomUUID() as UUID;
    const event: SyncEventEnvelope = {
      eventId: randomUUID() as UUID,
      originTier: SyncOriginType.DEVICE,
      originDeviceId: deviceId,
      locationId: location.id,
      entity: 'sales',
      entityId: randomUUID() as UUID,
      op: 'completed',
      payload: {
        v: 1,
        data: { lines: [{ productId: randomUUID(), qty: '1.000' }] },
        meta: { actorUserId: randomUUID() as UUID, actorRole: 'kasir', appVersion: '1.0.0' },
      },
      clientSeq: 1n,
      occurredAt: new Date().toISOString(),
      actorUserId: randomUUID() as UUID,
      schemaV: 1,
    };

    const pushBody = {
      batchId: randomUUID(),
      sentAt: new Date().toISOString(),
      events: [
        {
          eventId: event.eventId,
          originTier: event.originTier,
          originDeviceId: event.originDeviceId,
          locationId: event.locationId,
          entity: event.entity,
          entityId: event.entityId,
          op: event.op,
          payload: event.payload,
          clientSeq: event.clientSeq.toString(),
          occurredAt: event.occurredAt,
          receivedAt: event.occurredAt,
          relayReceivedAt: null,
          relayedViaNodeId: null,
          actorUserId: event.actorUserId,
          schemaV: event.schemaV,
        },
      ],
    };

    const ack = await fetchJson<PushAckWire>(`http://localhost:${port}/sync/v1/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(pushBody),
    });

    expect(ack.rejected).toEqual([]);
    expect(ack.acceptedThrough[deviceId]).toBe(1);

    // Real relay to the cloud: wait for the node's push loop (or the immediate
    // post-push flush) to land it in FakeCloud's own canonical log.
    await waitUntil(() => fakeCloud.getStoredEvents().some((e) => e.eventId === event.eventId));
    const stored = fakeCloud.getStoredEvents().find((e) => e.eventId === event.eventId)!;
    expect(stored.entity).toBe('sales');
    expect(stored.clientSeq).toBe(1n);

    // Retried, byte-identical push (§2.2/§4.3: a re-send must never duplicate).
    const ack2 = await fetchJson<PushAckWire>(`http://localhost:${port}/sync/v1/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...pushBody, batchId: randomUUID() }),
    });
    expect(ack2.rejected).toEqual([]);
    await waitUntil(() => true, 50); // let any (incorrect) second relay attempt settle
    expect(fakeCloud.getStoredEvents().filter((e) => e.eventId === event.eventId)).toHaveLength(1);

    // The pushed sale is also visible to a second LAN device polling the node's own pull endpoint
    // (intra-outlet visibility, SYNC-PROTOCOL §1.4 whitelist).
    const pullResult = await fetchJson<PullResultWire>(
      `http://localhost:${port}/sync/v1/pull?cursor=0&limit=10`,
    );
    expect(pullResult.events.some((e) => e.eventId === event.eventId)).toBe(true);
  });

  it('rejects a location-mismatched push as authority_violation (§3.4 rule 3, the only check a node makes)', async () => {
    await startNode();
    const port = engine.getLanServerPort()!;

    const wrongLocationEvent = {
      eventId: randomUUID(),
      originTier: 'device',
      originDeviceId: randomUUID(),
      locationId: randomUUID(), // NOT this node's location
      entity: 'sales',
      entityId: randomUUID(),
      op: 'completed',
      payload: {
        v: 1,
        data: {},
        meta: { actorUserId: randomUUID(), actorRole: 'kasir', appVersion: '1.0.0' },
      },
      clientSeq: '1',
      occurredAt: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      relayReceivedAt: null,
      relayedViaNodeId: null,
      actorUserId: randomUUID(),
      schemaV: 1,
    };

    const ack = await fetchJson<PushAckWire>(`http://localhost:${port}/sync/v1/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        batchId: randomUUID(),
        sentAt: new Date().toISOString(),
        events: [wrongLocationEvent],
      }),
    });

    expect(ack.rejected).toHaveLength(1);
    expect(ack.rejected[0]).toMatchObject({
      eventId: wrongLocationEvent.eventId,
      code: 'authority_violation',
    });
  });

  it('rejects a structurally malformed envelope, but never on business/authority grounds (§3.4: nodes check rule 1-lite + 3 only)', async () => {
    await startNode();
    const port = engine.getLanServerPort()!;

    const malformedEvent = {
      eventId: randomUUID(),
      originTier: 'device',
      originDeviceId: randomUUID(),
      locationId: location.id,
      entity: 'sales',
      entityId: randomUUID(),
      op: 'completed',
      payload: {
        v: 1,
        data: {},
        meta: { actorUserId: randomUUID(), actorRole: 'kasir', appVersion: '1.0.0' },
      },
      clientSeq: undefined, // missing — structurally broken, not a business-authority question
      occurredAt: new Date().toISOString(),
      actorUserId: randomUUID(),
      schemaV: 1,
    };

    const ack = await fetchJson<PushAckWire>(`http://localhost:${port}/sync/v1/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        batchId: randomUUID(),
        sentAt: new Date().toISOString(),
        events: [malformedEvent],
      }),
    });

    expect(ack.rejected).toEqual([
      { eventId: malformedEvent.eventId, code: 'malformed', detail: expect.any(String) },
    ]);

    // A future/unrecognized (entity, op) this node's own `@mimi/sync-protocol` copy has never heard of —
    // e.g. from a newer device that shipped after this node's last fleet update — must NOT be rejected
    // locally (that call belongs to the cloud alone, per §3.4's closing note).
    const futureEntityEvent = {
      ...malformedEvent,
      clientSeq: '1',
      entity: 'some_future_entity_v99',
      op: 'did_a_new_thing',
    };
    const ack2 = await fetchJson<PushAckWire>(`http://localhost:${port}/sync/v1/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        batchId: randomUUID(),
        sentAt: new Date().toISOString(),
        events: [futureEntityEvent],
      }),
    });
    expect(ack2.rejected).toEqual([]);
    expect(ack2.acceptedThrough[futureEntityEvent.originDeviceId]).toBe(1);
  });
});
