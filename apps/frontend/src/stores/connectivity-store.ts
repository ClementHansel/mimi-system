import { create } from 'zustand';

/**
 * Connectivity store — the three tiers of SYNC-PROTOCOL §1.1: a device talks
 * to exactly one upstream at a time, in preference order (paired node, then
 * cloud). This store is the FRONTEND-WIDE INTERFACE other agents branch UI on
 * (SYNC-PROTOCOL §8 tier-degradation matrix — every "B"/"P"/"D" cell in that
 * table reads `tier` from here to decide what to greroy out).
 *
 * W1-E ships only the interface + a simple `navigator.onLine`-based default
 * (online ⇄ isolated). The real upstream-selection algorithm — probing the
 * paired node, the 3-failure/60s-hysteresis fail-away/fail-back rule, the
 * 'lan' tier — is W2-E's (`src/lib/local/**`), which calls `setTier`,
 * `setQueueDepth`, `setLastSyncAt` from its real outbox/health-probe logic.
 * Do not build the probing logic here — that duplicates W2-E's ownership.
 */

export type ConnectivityTier = 'online' | 'lan' | 'isolated';

/**
 * Outcome of the most recent manual "Coba Sinkron" action (D-25b) — kept
 * separate from `isSyncing` (which reflects the background engine's own
 * continuous push/pull cycles) so the button can show its own
 * in-progress/outcome state without lying about what triggered it. `idle`
 * means "never run this session"; a completed run stays `success`/`error`
 * until the next attempt, rather than resetting itself, so a cashier who
 * glances back later still sees the last real outcome.
 */
export type ManualCheckStatus = 'idle' | 'checking' | 'success' | 'error';

interface ConnectivityState {
  /** Which upstream (if any) the sync channel is currently using. */
  tier: ConnectivityTier;
  /** Is the CLOUD (not just the current upstream) reachable? Drives ordinary REST calls. */
  cloudReachable: boolean;
  /** Local outbox depth (events not yet cloud-confirmed) — feeds SyncStatusPill. */
  queueDepth: number;
  /** ISO timestamp of the last successful sync, or null if never synced on this device. */
  lastSyncAt: string | null;
  /** A push/pull round is actively in flight right now (distinct from "has a queue"). */
  isSyncing: boolean;
  /** D-25b manual action state — see `ManualCheckStatus`. */
  manualCheckStatus: ManualCheckStatus;
  /** i18n key (under `offline.retryFailedReason`) explaining the last manual-check failure, or null when not applicable/not failed. */
  manualCheckErrorKey: string | null;
  setTier: (tier: ConnectivityTier) => void;
  setCloudReachable: (reachable: boolean) => void;
  setQueueDepth: (depth: number) => void;
  setLastSyncAt: (iso: string | null) => void;
  setSyncing: (syncing: boolean) => void;
  setManualCheckStatus: (status: ManualCheckStatus, errorKey?: string | null) => void;
}

export const useConnectivityStore = create<ConnectivityState>((set) => ({
  tier: 'online',
  cloudReachable: true,
  queueDepth: 0,
  lastSyncAt: null,
  isSyncing: false,
  manualCheckStatus: 'idle',
  manualCheckErrorKey: null,
  setTier: (tier) => set({ tier }),
  setCloudReachable: (cloudReachable) => set({ cloudReachable }),
  setQueueDepth: (queueDepth) => set({ queueDepth }),
  setLastSyncAt: (lastSyncAt) => set({ lastSyncAt }),
  setSyncing: (isSyncing) => set({ isSyncing }),
  setManualCheckStatus: (manualCheckStatus, errorKey = null) =>
    set({ manualCheckStatus, manualCheckErrorKey: manualCheckStatus === 'error' ? errorKey : null }),
}));

/**
 * Minimal `navigator.onLine`-based default watcher — superseded now that
 * `AppShell` bootstraps W2-E's real `LocalRuntime` (`src/lib/local/browser.ts`),
 * whose `SyncEngine` calls this store's setters from its own upstream
 * health-probe instead of trusting `navigator.onLine` (which only knows
 * "some network interface is up", not "the cloud, or a paired node, actually
 * answered" — the exact gap SYNC-PROTOCOL §1.3's probe-based selection
 * closes). Kept exported as a fallback for a context with no local runtime
 * (a test harness, or a future non-PWA surface) — not wired by AppShell.
 */
export function initConnectivityWatcher(): () => void {
  if (typeof window === 'undefined') return () => {};

  const update = () => {
    const online = navigator.onLine;
    useConnectivityStore.getState().setCloudReachable(online);
    useConnectivityStore.getState().setTier(online ? 'online' : 'isolated');
  };

  update();
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  return () => {
    window.removeEventListener('online', update);
    window.removeEventListener('offline', update);
  };
}
