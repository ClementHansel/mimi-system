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
  // ONE source of truth for "does this device hold a credential", shared by
  // the transport (which attaches it) and the engine's sync gate (which skips
  // authenticated cycles without it) so the two cannot disagree.
  const deviceToken = () => identity?.deviceToken ?? null;
  const transport = createHttpTransport(deviceToken);

  const candidates: UpstreamCandidate[] = [];
  if (identity?.nodeLanUrl) candidates.push({ kind: 'node', baseUrl: identity.nodeLanUrl });

  // Cloud upstream, defaulting to the app's OWN ORIGIN.
  //
  // `identity.cloudUrl` is only ever populated by `applyRegistration()` —
  // i.e. after a device has been through `/api/devices/register`.
  // `ensureDeviceIdentity()` seeds it as `''`, and nothing else writes it, so
  // every browser that has not been paired produced an EMPTY candidate list:
  // the selector had nothing to probe, `setTier` never moved off its initial
  // value, and every surface showed "Offline — Tidak Ada Koneksi. Perangkat
  // ini bekerja sendiri" permanently — while sitting on a working connection
  // where every REST call succeeded. A false offline banner on a laptop in
  // the back office trains people to ignore the one indicator that matters
  // when a device really is isolated.
  //
  // The origin is the correct default rather than a guess: `next.config.ts`
  // rewrites `/sync/v1/*` to the backend precisely so the PWA works
  // same-origin "whether it's reached directly on :3000 (dev) or through
  // Traefik in prod". A registered device still wins — its `cloudUrl` may
  // legitimately point somewhere else — and `upstream-selector.ts`'s own
  // header already describes the no-node case as "the candidate list is just
  // [cloud]", which is exactly what this restores.
  const cloudUrl =
    identity?.cloudUrl || (typeof window !== 'undefined' ? window.location.origin : '');
  if (cloudUrl) candidates.push({ kind: 'cloud', baseUrl: cloudUrl });

  const runtime = createLocalRuntime({
    db,
    transport,
    candidates,
    connectivity: connectivityReporter,
    // Without this, the same-origin cloud candidate above turned every page
    // into a 401 generator: health (unauthenticated) succeeds and sets the
    // tier, then push/pull/heartbeat fire with no credential. No browser has
    // one today — nothing in the app calls `/api/devices/register` yet.
    hasDeviceCredential: () => deviceToken() !== null,
  });
  await runtime.init();
  singleton = runtime;
  return runtime;
}
