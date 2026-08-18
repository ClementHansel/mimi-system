'use client';

/**
 * Real-browser bootstrap: wires the `idb`-backed database, the HTTP-fallback
 * transport, and W1-E's `connectivity-store` into one `LocalRuntime`. This is
 * the ONE call Wave 4 surfaces (or W1-E's `AppShell`, wherever the app
 * decides to initialize the offline runtime once at startup — that call site
 * is outside `src/lib/local/**`, so wiring it in is a follow-up integration
 * step for whoever owns that file, not this package) needs to make in
 * production. Every test in this package uses `createLocalRuntime` directly
 * with the memory database + `FakeCloud` instead.
 */
import { useConnectivityStore } from '@/stores/connectivity-store';
import { openLocalDatabase } from './store/idb-database';
import { createHttpTransport } from './transport/http-transport';
import { createLocalRuntime, type LocalRuntime } from './api/local-runtime';
import type { UpstreamCandidate } from './upstream/upstream-selector';
import { loadDeviceIdentity } from './identity';
import type { ConnectivityReporter } from './sync/sync-engine';

const connectivityReporter: ConnectivityReporter = {
  setTier: (tier) => useConnectivityStore.getState().setTier(tier),
  setCloudReachable: (reachable) => useConnectivityStore.getState().setCloudReachable(reachable),
  setQueueDepth: (depth) => useConnectivityStore.getState().setQueueDepth(depth),
  setLastSyncAt: (iso) => useConnectivityStore.getState().setLastSyncAt(iso),
  setSyncing: (syncing) => useConnectivityStore.getState().setSyncing(syncing),
};

let singleton: LocalRuntime | null = null;

export async function getBrowserLocalRuntime(): Promise<LocalRuntime> {
  if (singleton) return singleton;

  const db = await openLocalDatabase();
  const identity = await loadDeviceIdentity(db);
  const transport = createHttpTransport(() => identity?.deviceToken ?? null);

  const candidates: UpstreamCandidate[] = [];
  if (identity?.nodeLanUrl) candidates.push({ kind: 'node', baseUrl: identity.nodeLanUrl });
  if (identity?.cloudUrl) candidates.push({ kind: 'cloud', baseUrl: identity.cloudUrl });

  const runtime = createLocalRuntime({
    db,
    transport,
    candidates,
    connectivity: connectivityReporter,
  });
  await runtime.init();
  singleton = runtime;
  return runtime;
}
