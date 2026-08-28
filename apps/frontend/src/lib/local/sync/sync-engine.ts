/**
 * The orchestrator — wires upstream selection (§1.3), the outbox drain
 * (§4.3), the pull loop (§4.5), and heartbeat telemetry (§4.6) into one
 * runnable engine, and reports real state into W1-E's `connectivity-store`
 * (the store's own header says this runtime "calls setTier, setQueueDepth,
 * setLastSyncAt from its real outbox/health-probe logic" — this file is
 * exactly that caller).
 *
 * `runSyncCycle` is the pure, directly-testable half (drain + pull, given an
 * already-selected upstream); `SyncEngine` is the stateful timer/wiring half
 * that Wave 4 surfaces never need to touch directly — they use
 * `api/local-runtime.ts` instead.
 */
import type { LocalDatabase } from '../store/local-database';
import type { SyncTransport } from '../transport/types';
import type { UpstreamKind } from '../types';
import { drainOutboxOnce, type DrainResult } from './outbox-drain';
import { pullUntilCaughtUp, type PullResult } from './pull-loop';
import { getOutboxDepth } from '../idempotent-commit';
import {
  UpstreamSelector,
  type UpstreamCandidate,
  type UpstreamState,
} from '../upstream/upstream-selector';
import { UPSTREAM_PROBE_INTERVAL_MS, HEARTBEAT_INTERVAL_MS } from '../constants';
import type { ReconcileOptions } from './reconciler';
import type { ClockState, DeviceIdentity } from '../types';
import { recordOffsetSample } from '../clock/clock';

export interface SyncCycleResult {
  drain: DrainResult;
  pull: PullResult;
  offline: boolean;
}

export async function runSyncCycle(
  db: LocalDatabase,
  transport: SyncTransport,
  baseUrl: string,
  upstream: UpstreamKind,
  reconcileOptions: ReconcileOptions = {},
): Promise<SyncCycleResult> {
  const drain = await drainOutboxOnce(db, transport, baseUrl);
  if (drain.transportFailed) {
    return {
      drain,
      pull: { pagesApplied: 0, eventsApplied: 0, cursor: 0 },
      offline: true,
    };
  }

  try {
    const pull = await pullUntilCaughtUp(db, transport, baseUrl, upstream, reconcileOptions);
    return { drain, pull, offline: false };
  } catch {
    return { drain, pull: { pagesApplied: 0, eventsApplied: 0, cursor: 0 }, offline: true };
  }
}

export interface ConnectivityReporter {
  setTier(tier: 'online' | 'lan' | 'isolated'): void;
  setCloudReachable(reachable: boolean): void;
  setQueueDepth(depth: number): void;
  setLastSyncAt(iso: string | null): void;
  setSyncing(syncing: boolean): void;
}

export interface SyncEngineOptions {
  db: LocalDatabase;
  transport: SyncTransport;
  candidates: UpstreamCandidate[];
  connectivity: ConnectivityReporter;
  reconcileOptions?: ReconcileOptions;
  now?: () => number;
  /**
   * Whether this device holds a credential the cloud will accept.
   *
   * `/sync/v1/health` is unauthenticated — which is what lets the upstream
   * selector establish the tier for ANY device — but `push`/`pull`/`heartbeat`
   * all require a device credential issued by `/api/devices/register`. An
   * unregistered browser therefore has a perfectly good upstream and no way to
   * use it, and firing the cycle anyway just produced a 401 on every heartbeat
   * (`GET /sync/v1/pull` -> "Missing device credential"), on every page.
   *
   * Omitted = always allowed, preserving existing behaviour for tests and for
   * the in-memory runtime, which are registered by construction.
   */
  hasDeviceCredential?: () => boolean;
}

/**
 * D-08 — the real device storage figures, or `undefined` when the platform
 * cannot answer.
 *
 * This used to be a hardcoded `{usedMb: 0, quotaMb: 0}`. The cloud derives
 * `storage_free_mb = quotaMb - usedMb` and stored **0 MB free for every device
 * in the fleet**, forever — which does not read as "no data", it reads as a
 * full disk. Any threshold that ever gets wired to it (`storage_warning` /
 * `storage_full` are already declared ops) would have fired on everything at
 * once, and a fleet-wide alert that is always on is one nobody looks at.
 *
 * `navigator.storage.estimate()` is the standard answer and is supported on
 * both PWA targets. It is deliberately NOT filled in with a guess where it is
 * missing: omitting the field records "unknown", which is true, and the
 * heartbeat schema now allows that. The numbers are approximate by design —
 * browsers pad the quota and round the usage to resist fingerprinting — so
 * this is a capacity signal, never an accounting figure.
 */
export async function estimateStorage(): Promise<{ usedMb: number; quotaMb: number } | undefined> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return undefined;
    const { usage, quota } = await navigator.storage.estimate();
    if (usage === undefined || quota === undefined) return undefined;
    const MB = 1024 * 1024;
    return { usedMb: Math.round(usage / MB), quotaMb: Math.round(quota / MB) };
  } catch {
    // Some privacy modes throw rather than returning empty. Unknown, not zero.
    return undefined;
  }
}

/**
 * Stateful runtime object: owns the upstream selector's timer and drives
 * push/pull cycles whenever an upstream is available. Not itself unit-tested
 * in isolation (it is thin glue over already-tested pieces); the scenario
 * tests in `sync-engine.scenario.test.ts` exercise it end-to-end against
 * `FakeCloud`.
 */
export class SyncEngine {
  private readonly db: LocalDatabase;
  private readonly transport: SyncTransport;
  private readonly selector: UpstreamSelector;
  private readonly connectivity: ConnectivityReporter;
  private readonly reconcileOptions: ReconcileOptions;
  private readonly now: () => number;
  private readonly hasDeviceCredential?: () => boolean;
  private probeTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private syncing = false;

  constructor(opts: SyncEngineOptions) {
    this.db = opts.db;
    this.transport = opts.transport;
    this.connectivity = opts.connectivity;
    this.reconcileOptions = opts.reconcileOptions ?? {};
    this.now = opts.now ?? Date.now;
    this.hasDeviceCredential = opts.hasDeviceCredential;
    this.selector = new UpstreamSelector(
      opts.candidates,
      (baseUrl) => this.transport.health(baseUrl),
      this.now,
    );
    this.selector.onChange((state) => this.onUpstreamChange(state));
  }

  /**
   * `cloudReachable` gates ordinary REST calls (dashboards, admin, warehouse,
   * HR — every screen with no offline path, §8's four B-11 flows included).
   * Those calls target the CLOUD ORIGIN specifically, never a branch node —
   * so 'lan' (upstream = node, WAN down) must report `false` here exactly
   * like 'isolated' does. `tier !== 'isolated'` was wrong: it reported `true`
   * in LAN-only mode, which would send every plain-REST screen straight into
   * a failed request that LOOKS like a server error instead of "you are not
   * connected to the cloud." Only 'online' means the cloud origin itself is
   * the current upstream.
   *
   * Called unconditionally from `start()`/`recheckConnectivity()` — NOT only
   * from `UpstreamSelector`'s `onChange` — because `onChange` only fires on
   * an actual transition, and a device that is ALREADY isolated on its very
   * first tick (current === null before AND after — no candidate ever
   * healthy) never transitions at all. Relying solely on `onChange` would
   * leave `connectivity-store`'s own defaults (`tier: 'online'`,
   * `cloudReachable: true`) uncorrected for a user who opens the app for the
   * first time with no connectivity — silently showing "online" until some
   * LATER transition happened to fire.
   */
  private reportUpstreamState(state: UpstreamState): void {
    this.connectivity.setTier(state.tier);
    this.connectivity.setCloudReachable(state.tier === 'online');
  }

  private onUpstreamChange(state: UpstreamState): void {
    this.reportUpstreamState(state);
    if (state.current) void this.syncNow();
  }

  setCandidates(candidates: UpstreamCandidate[]): void {
    this.selector.setCandidates(candidates);
  }

  getUpstreamState(): UpstreamState {
    return this.selector.getState();
  }

  /**
   * Forces one fresh probe cycle right now (the same `UpstreamSelector.tick()`
   * that `start()` runs once up front and the idle timer re-runs every
   * `UPSTREAM_PROBE_INTERVAL_MS`), for a user-initiated "retry" affordance —
   * without tearing down and restarting the engine (`stop()`+`start()`) just
   * to get a fresh tick, which also drops the heartbeat/probe timers for the
   * duration and re-triggers `start()`'s own internal sync. `onUpstreamChange`
   * already reports the resulting tier/cloudReachable through the normal
   * `ConnectivityReporter` path if the tick changes anything; this method's
   * return value is for the CALLER to decide what to do next (e.g. skip a
   * pointless `syncNow()` when `hasUpstream` is `false`).
   */
  async recheckConnectivity(): Promise<{ tier: UpstreamState['tier']; hasUpstream: boolean }> {
    const state = await this.selector.tick();
    this.reportUpstreamState(state); // unconditional — see reportUpstreamState's doc comment
    return { tier: state.tier, hasUpstream: state.current !== null };
  }

  async start(): Promise<void> {
    const state = await this.selector.tick();
    this.reportUpstreamState(state); // unconditional — see reportUpstreamState's doc comment
    this.probeTimer = setInterval(() => void this.selector.tick(), UPSTREAM_PROBE_INTERVAL_MS);
    this.heartbeatTimer = setInterval(() => void this.sendHeartbeat(), HEARTBEAT_INTERVAL_MS);
    await this.syncNow();
  }

  stop(): void {
    if (this.probeTimer) clearInterval(this.probeTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.probeTimer = null;
    this.heartbeatTimer = null;
  }

  /** Runs one push+pull cycle right now against the current upstream, if any. Safe to call concurrently — reentrant calls no-op while one is already running (§4.3's "one outstanding batch" applied at the cycle level too). */
  async syncNow(): Promise<SyncCycleResult | null> {
    const state = this.selector.getState();
    if (!state.current || this.syncing) return null;
    // No credential -> push/pull can only 401. The tier is already correct
    // (the selector's own unauthenticated health probe set it), so skipping
    // here costs nothing and stops the noise.
    if (this.hasDeviceCredential && !this.hasDeviceCredential()) return null;

    this.syncing = true;
    this.connectivity.setSyncing(true);
    try {
      const upstreamKind: UpstreamKind = state.current.kind;
      const result = await runSyncCycle(
        this.db,
        this.transport,
        state.current.baseUrl,
        upstreamKind,
        this.reconcileOptions,
      );

      if (!result.offline) {
        await this.updateClockFromHealth(state.current.baseUrl);
        this.connectivity.setLastSyncAt(new Date(this.now()).toISOString());
      }

      const depth = await getOutboxDepth(this.db);
      this.connectivity.setQueueDepth(depth);
      return result;
    } finally {
      this.syncing = false;
      this.connectivity.setSyncing(false);
    }
  }

  private async updateClockFromHealth(baseUrl: string): Promise<void> {
    try {
      const start = this.now();
      const health = await this.transport.health(baseUrl);
      const rtt = this.now() - start;
      const clockStore = this.db.store<ClockState>('clock_state');
      const current = (await clockStore.get('self')) ?? {
        id: 'self' as const,
        offsetMs: 0,
        samples: [],
        lastMeasuredAt: null,
      };
      const updated = recordOffsetSample(
        current,
        health.serverTime,
        start,
        rtt,
        new Date(this.now()).toISOString(),
      );
      await clockStore.put(updated);
    } catch {
      // best-effort; clock sync never blocks the pipe (§6.2/§6.3)
    }
  }

  private async sendHeartbeat(): Promise<void> {
    const state = this.selector.getState();
    if (!state.current) return;
    const identity = await this.db.store<DeviceIdentity>('device_identity').get('self');
    if (!identity) return;
    // Same reason as `syncNow`: heartbeat is device-authenticated. Its own
    // catch swallows the rejection, but the browser still logs the 401 — and
    // telemetry for a device the registry has never heard of is meaningless.
    if (!identity.deviceToken) return;
    const depth = await getOutboxDepth(this.db);
    try {
      await this.transport.heartbeat(state.current.baseUrl, {
        deviceId: identity.originDeviceId,
        at: new Date(this.now()).toISOString(),
        appVersion: 'dev',
        queueDepth: depth,
        quarantineDepth: await this.db.store('outbox_quarantine').count(),
        pullLag: 0,
        lastSyncAt: null,
        storage: await estimateStorage(),
        clockOffsetMs: (await this.db.store<ClockState>('clock_state').get('self'))?.offsetMs ?? 0,
      });
    } catch {
      // heartbeat is loss-tolerant telemetry (§4.6) — never surfaces as an error
    }
  }
}
