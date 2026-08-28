/**
 * W3-10 hardening — the two gaps the owner flagged had no real backend at
 * all before this ticket:
 *
 *  1. A remote write path for a branch node's network settings that the
 *     node actually APPLIES (`config_updated` -> `RelayEngine
 *     .handleNetworkConfigUpdate`), with apply-then-confirm and an
 *     automatic revert to last-known-good if the node cannot prove it's
 *     still reachable within a timeout — the safety mandate this ticket
 *     centers on. Only `healthPort`/`scanSubnet` are genuinely appliable by
 *     this node build (see `src/network/applier.ts`'s doc comment for
 *     exactly why WiFi/static-IP are NOT — accepted and stored cloud-side,
 *     but honestly reported `applied: false`, never faked).
 *  2. Three of four `POST /api/nodes/:id/command` types that used to ack
 *     `'done'` as a blanket no-op. `restart` and `log_pull` are exercised
 *     for real here; `update` is proven to fail HONESTLY (never `'done'`)
 *     rather than lying about work it did not do.
 *
 * Same harness discipline as `lifecycle.test.ts`: `FakeCloud` implements the
 * wire shapes for real; every assertion here drives REAL production code
 * (`RelayEngine`, `LanServer.rebind`, `MemoryStore`) end to end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import type { UUID } from '@mimi/shared';
import { loadConfig } from '../src/config';
import { MemoryStore } from '../src/store/memory-store';
import { RelayEngine } from '../src/relay';
import { InProcessNetworkApplier, SimulateNetworkApplier } from '../src/network/applier';
import { FakeCloud } from './fake-cloud';

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

/** A real, currently-free TCP port picked by the OS — used both as a fresh target port and, held
 *  open, as a guaranteed EADDRINUSE collision for the bind-failure test. */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

describe('branch-node network config — apply-then-confirm/revert (W3-10)', () => {
  let fakeCloud: FakeCloud;
  let cloudPort: number;
  let store: MemoryStore;
  let engine: RelayEngine;
  const location = { id: randomUUID() as UUID, code: 'JKT-02', name: 'Outlet Network Test' };

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
      BRANCH_NODE_NETWORK_CONFIG_CONFIRM_TIMEOUT_MS: '80',
      ...overrides,
    } as NodeJS.ProcessEnv);
    engine = new RelayEngine(config, store, fakeCloud.socketFactory);
    await engine.start();
    return config;
  }

  it('applies a real healthPort change, confirms reachable, and promotes it to last-known-good', async () => {
    await startNode();
    const identity = await store.getIdentity();
    const nodeId = identity.nodeId!;
    const oldPort = engine.getLanServerPort()!;
    const newPort = await getFreePort();
    const configId = randomUUID();

    fakeCloud.sendConfigUpdated(nodeId, { configId, config: { healthPort: newPort } });

    // The LAN listener actually rebound — this is the real effect, not a state-only flag.
    await waitUntil(async () => {
      try {
        const health = await fetchJson<{ status: string }>(`http://localhost:${newPort}/health`);
        return health.status === 'ok';
      } catch {
        return false;
      }
    });

    await waitUntil(() => fakeCloud.networkConfigAcksReceived.length >= 1);
    const ack = fakeCloud.networkConfigAcksReceived[0] as {
      configId: string;
      status: string;
      fields: { field: string; applied: boolean }[];
    };
    expect(ack.configId).toBe(configId);
    expect(ack.status).toBe('applied');
    expect(ack.fields).toContainEqual({ field: 'healthPort', applied: true, reason: 'ok' });

    const after = await store.getIdentity();
    expect(after.networkState.status).toBe('stable');
    expect(after.networkState.effective.healthPort).toBe(newPort);
    expect(after.networkState.lastKnownGood.healthPort).toBe(newPort);
    expect(after.networkState.effective.healthPort).not.toBe(oldPort);
  });

  it(
    'reverts to the last-known-good port when the node cannot be confirmed reachable within the ' +
      'timeout — the safety mechanism this ticket is actually about',
    async () => {
      await startNode();
      const identity = await store.getIdentity();
      const nodeId = identity.nodeId!;
      const oldPort = engine.getLanServerPort()!;
      const newPort = await getFreePort();
      const configId = randomUUID();

      fakeCloud.sendConfigUpdated(nodeId, { configId, config: { healthPort: newPort } });
      // Simulate exactly the failure mode this design exists for: the node applied the change and
      // can no longer be reached — never told to revert, because nothing CAN tell it to.
      fakeCloud.disconnectBridge(nodeId);

      await waitUntil(() => fakeCloud.networkConfigAcksReceived.length >= 1, 2000);
      const ack = fakeCloud.networkConfigAcksReceived[0] as { status: string; detail?: string };
      expect(ack.status).toBe('reverted');
      expect(ack.detail).toBe('confirm_timeout_unreachable');

      // The REAL, load-bearing assertion: the LAN listener is back on the OLD port — an outlet's
      // POS devices can reach this node again without any human intervention.
      const health = await fetchJson<{ status: string }>(`http://localhost:${oldPort}/health`);
      expect(health.status).toBe('ok');

      const after = await store.getIdentity();
      expect(after.networkState.status).toBe('reverted');
      expect(after.networkState.effective.healthPort).toBe(oldPort);
      expect(after.networkState.lastKnownGood.healthPort).toBe(oldPort);
    },
  );

  it('reverts IMMEDIATELY (not after the full confirm timeout) when the new port cannot be bound at all', async () => {
    await startNode({ BRANCH_NODE_NETWORK_CONFIG_CONFIRM_TIMEOUT_MS: '5000' });
    const identity = await store.getIdentity();
    const nodeId = identity.nodeId!;
    const oldPort = engine.getLanServerPort()!;

    // Hold a real listener open on a free port so the node's rebind attempt hits a genuine
    // EADDRINUSE — this is the "port collision... discovered by an outlet going dark" case the
    // API's own validation cannot catch (only this machine, at bind time, knows the port is taken).
    const occupied = net.createServer();
    const occupiedPort = await new Promise<number>((resolve) => {
      occupied.listen(0, () => {
        const addr = occupied.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });

    try {
      const started = Date.now();
      fakeCloud.sendConfigUpdated(nodeId, {
        configId: randomUUID(),
        config: { healthPort: occupiedPort },
      });

      await waitUntil(() => fakeCloud.networkConfigAcksReceived.length >= 1, 2000);
      const elapsedMs = Date.now() - started;
      // Well under the 5s confirm timeout above — proves the bind failure short-circuited the
      // wait rather than the test merely outrunning a slow assertion.
      expect(elapsedMs).toBeLessThan(2000);

      const ack = fakeCloud.networkConfigAcksReceived[0] as {
        status: string;
        fields: { field: string; applied: boolean; reason: string }[];
      };
      expect(ack.status).toBe('reverted');
      expect(ack.fields.find((f) => f.field === 'healthPort')?.reason).toMatch(/bind_failed/);

      // The old port was never taken down for this to happen (see `LanServer.rebind`'s
      // bind-candidate-first design) — still serving throughout.
      const health = await fetchJson<{ status: string }>(`http://localhost:${oldPort}/health`);
      expect(health.status).toBe('ok');
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });

  it("restart command acks 'accepted' and invokes the injected exit function, never the real process.exit", async () => {
    const exitSpy = vi.fn();
    const pairingToken = fakeCloud.mintPairingToken();
    const config = loadConfig({
      SIMULATE: 'true',
      BRANCH_NODE_CLOUD_URL: `http://localhost:${cloudPort}`,
      BRANCH_NODE_PAIRING_TOKEN: pairingToken,
      BRANCH_NODE_HEALTH_PORT: '0',
      BRANCH_NODE_HEARTBEAT_INTERVAL_MS: '30',
      BRANCH_NODE_DISCOVERY_INTERVAL_MS: '30',
    } as NodeJS.ProcessEnv);
    engine = new RelayEngine(config, store, fakeCloud.socketFactory, exitSpy);
    await engine.start();

    const identity = await store.getIdentity();
    fakeCloud.sendCommand(identity.nodeId!, { commandId: randomUUID(), type: 'restart' });

    await waitUntil(() => fakeCloud.commandAcksReceived.length >= 1);
    expect(fakeCloud.commandAcksReceived[0]).toMatchObject({ status: 'accepted' });
    await waitUntil(() => exitSpy.mock.calls.length >= 1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('log_pull command sends back real recent log lines and acks done', async () => {
    await startNode();
    const identity = await store.getIdentity();
    console.log('W3-10 network-config test canary line — must appear in the pulled logs');

    fakeCloud.sendCommand(identity.nodeId!, {
      commandId: randomUUID(),
      type: 'log_pull',
      params: { lines: 50 },
    });

    await waitUntil(() => fakeCloud.logsChunksReceived.length >= 1);
    await waitUntil(() =>
      fakeCloud.commandAcksReceived.some((a) => (a as { status: string }).status === 'done'),
    );
    const allLines = fakeCloud.logsChunksReceived.flatMap((c) => (c as { lines: string[] }).lines);
    expect(allLines.some((l) => l.includes('W3-10 network-config test canary line'))).toBe(true);
  });

  it("update command acks 'failed' with an honest reason — never 'done' for work it did not do", async () => {
    await startNode();
    const identity = await store.getIdentity();
    fakeCloud.sendCommand(identity.nodeId!, { commandId: randomUUID(), type: 'update' });

    await waitUntil(() => fakeCloud.commandAcksReceived.length >= 1);
    const ack = fakeCloud.commandAcksReceived[0] as { status: string; detail?: string };
    expect(ack.status).toBe('failed');
    expect(ack.detail).toMatch(/no software-update distribution mechanism/);
  });
});

describe('NetworkConfigApplier — per-field honesty contract (unit, no RelayEngine)', () => {
  it('InProcessNetworkApplier reports WiFi/static-IP fields unsupported, never faked applied', async () => {
    const applier = new InProcessNetworkApplier({
      rebindLanServer: async () => {},
      setScanSubnet: () => {},
    });
    const results = await applier.apply({
      healthPort: 5555,
      wifiSsid: 'Outlet-WiFi',
      wifiPassphrase: 'super-secret-passphrase',
      staticIp: '192.168.1.50',
    });
    expect(results).toContainEqual({ field: 'healthPort', applied: true, reason: 'ok' });
    expect(results.find((r) => r.field === 'wifiSsid')).toMatchObject({ applied: false });
    expect(results.find((r) => r.field === 'wifiPassphrase')).toMatchObject({ applied: false });
    expect(results.find((r) => r.field === 'staticIp')).toMatchObject({ applied: false });
  });

  it('a bind failure in the appliable field propagates as a rejection (never swallowed)', async () => {
    const applier = new InProcessNetworkApplier({
      rebindLanServer: async () => {
        throw new Error('EADDRINUSE');
      },
      setScanSubnet: () => {},
    });
    await expect(applier.apply({ healthPort: 1 })).rejects.toThrow('EADDRINUSE');
  });

  it('SimulateNetworkApplier (test/SIMULATE-only) fakes every field applied — documents the future OS-integration contract, never wired into a real RelayEngine', async () => {
    const applier = new SimulateNetworkApplier({
      rebindLanServer: async () => {},
      setScanSubnet: () => {},
    });
    const results = await applier.apply({ wifiSsid: 'x', staticIp: '10.0.0.5' });
    expect(results.every((r) => r.applied)).toBe(true);
  });
});
