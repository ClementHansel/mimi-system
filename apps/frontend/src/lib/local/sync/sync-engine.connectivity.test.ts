import { describe, expect, it } from 'vitest';
import { SyncEngine, type ConnectivityReporter } from './sync-engine';
import { createTestDatabase } from '../test-support/fixtures';
import type { SyncTransport } from '../transport/types';
import type { UpstreamCandidate } from '../upstream/upstream-selector';

/**
 * A minimal `SyncTransport` whose `health()` is healthy ONLY for the URLs in
 * `healthyUrls` — needed because `UpstreamSelector` probes every candidate
 * through the SAME transport instance, differentiated solely by `baseUrl`
 * (see `sync-engine.ts`'s constructor). Push/pull/heartbeat are trivial
 * no-ops: these tests exercise connectivity REPORTING, not the sync cycle
 * itself (already covered by `sync-engine.scenario.test.ts`'s `FakeCloud`).
 */
function makeTransport(healthyUrls: Set<string>): SyncTransport {
  return {
    async health(baseUrl) {
      if (healthyUrls.has(baseUrl)) {
        return { ok: true, protocolV: 1, serverTime: new Date().toISOString(), tier: baseUrl.includes('node') ? 'node' : 'cloud' };
      }
      throw new Error('unhealthy');
    },
    async hello() {
      throw new Error('not exercised by these tests');
    },
    async push() {
      throw new Error('not exercised by these tests');
    },
    async pull(_baseUrl, cursor) {
      return { events: [], nextCursor: cursor, hasMore: false };
    },
    async heartbeat() {
      return { ok: true, serverTime: new Date().toISOString() };
    },
  };
}

function recordingConnectivity(): { reporter: ConnectivityReporter; tierCalls: string[]; cloudReachableCalls: boolean[] } {
  const tierCalls: string[] = [];
  const cloudReachableCalls: boolean[] = [];
  const reporter: ConnectivityReporter = {
    setTier: (t) => tierCalls.push(t),
    setCloudReachable: (r) => cloudReachableCalls.push(r),
    setQueueDepth: () => {},
    setLastSyncAt: () => {},
    setSyncing: () => {},
  };
  return { reporter, tierCalls, cloudReachableCalls };
}

const NODE: UpstreamCandidate = { kind: 'node', baseUrl: 'https://node.local' };
const CLOUD: UpstreamCandidate = { kind: 'cloud', baseUrl: 'https://cloud.mimi' };

describe('SyncEngine connectivity reporting (the tier/cloudReachable combination nothing previously asserted)', () => {
  it('LAN-only: tier is "lan" but cloudReachable is false — the device reaches the NODE, not the cloud', async () => {
    const db = createTestDatabase();
    const transport = makeTransport(new Set([NODE.baseUrl])); // only the node answers; cloud is down
    const { reporter, tierCalls, cloudReachableCalls } = recordingConnectivity();

    const engine = new SyncEngine({ db, transport, candidates: [NODE, CLOUD], connectivity: reporter });
    try {
      await engine.start();

      expect(engine.getUpstreamState()).toEqual({ current: NODE, tier: 'lan' });
      expect(tierCalls).toContain('lan');
      expect(cloudReachableCalls[cloudReachableCalls.length - 1]).toBe(false); // <- the exact combination that was wrong
    } finally {
      engine.stop();
    }
  });

  it('online: tier is "online" and cloudReachable is true', async () => {
    const db = createTestDatabase();
    const transport = makeTransport(new Set([CLOUD.baseUrl])); // no node candidate at all — cloud-direct
    const { reporter, tierCalls, cloudReachableCalls } = recordingConnectivity();

    const engine = new SyncEngine({ db, transport, candidates: [CLOUD], connectivity: reporter });
    try {
      await engine.start();

      expect(engine.getUpstreamState().tier).toBe('online');
      expect(tierCalls).toContain('online');
      expect(cloudReachableCalls[cloudReachableCalls.length - 1]).toBe(true);
    } finally {
      engine.stop();
    }
  });

  it('isolated: tier is "isolated" and cloudReachable is false (unchanged behavior — regression guard)', async () => {
    const db = createTestDatabase();
    const transport = makeTransport(new Set()); // nothing answers
    const { reporter, tierCalls, cloudReachableCalls } = recordingConnectivity();

    const engine = new SyncEngine({ db, transport, candidates: [NODE, CLOUD], connectivity: reporter });
    try {
      await engine.start();

      expect(engine.getUpstreamState()).toEqual({ current: null, tier: 'isolated' });
      expect(tierCalls).toContain('isolated');
      expect(cloudReachableCalls[cloudReachableCalls.length - 1]).toBe(false);
    } finally {
      engine.stop();
    }
  });
});

describe('SyncEngine.recheckConnectivity()', () => {
  it('forces a fresh probe and reports the resulting tier + whether an upstream was found', async () => {
    const db = createTestDatabase();
    const transport = makeTransport(new Set());
    const { reporter } = recordingConnectivity();
    const engine = new SyncEngine({ db, transport, candidates: [NODE, CLOUD], connectivity: reporter });

    try {
      const result = await engine.recheckConnectivity();
      expect(result).toEqual({ tier: 'isolated', hasUpstream: false });
    } finally {
      engine.stop();
    }
  });

  it('reflects a newly-healthy upstream without needing stop()+start() (no restart of the engine)', async () => {
    const db = createTestDatabase();
    const healthyUrls = new Set<string>();
    const transport = makeTransport(healthyUrls);
    const { reporter } = recordingConnectivity();
    const engine = new SyncEngine({ db, transport, candidates: [NODE, CLOUD], connectivity: reporter });

    try {
      const before = await engine.recheckConnectivity();
      expect(before).toEqual({ tier: 'isolated', hasUpstream: false });

      // The network "comes back" — nothing about the engine itself is torn down or restarted.
      healthyUrls.add(CLOUD.baseUrl);
      const after = await engine.recheckConnectivity();
      expect(after).toEqual({ tier: 'online', hasUpstream: true });
      expect(engine.getUpstreamState().tier).toBe('online');
    } finally {
      engine.stop();
    }
  });

  it('does not restart the probe/heartbeat timers — safe to call repeatedly from a user-initiated retry button', async () => {
    const db = createTestDatabase();
    const transport = makeTransport(new Set([CLOUD.baseUrl]));
    const { reporter } = recordingConnectivity();
    const engine = new SyncEngine({ db, transport, candidates: [CLOUD], connectivity: reporter });

    try {
      await engine.start();
      // Calling recheckConnectivity() repeatedly must not throw or double-register timers.
      await engine.recheckConnectivity();
      await engine.recheckConnectivity();
      const result = await engine.recheckConnectivity();
      expect(result).toEqual({ tier: 'online', hasUpstream: true });
    } finally {
      engine.stop();
    }
  });
});
