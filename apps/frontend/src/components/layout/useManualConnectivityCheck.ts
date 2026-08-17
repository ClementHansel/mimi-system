'use client';

import { useCallback } from 'react';
import { getBrowserLocalRuntime } from '@/lib/local/browser';
import { useConnectivityStore } from '@/stores/connectivity-store';

/**
 * Drives the D-25b manual "Coba Sinkron" action — the owner's requirement
 * for a button that "forces both: re-check connectivity *and* attempt a
 * sync." Built entirely on `LocalRuntime`'s public lifecycle API
 * (`stop`/`start`/`syncNow` from `lib/local/api/local-runtime.ts`); this
 * file never reaches into `lib/local`'s internals.
 *
 * Awkward part worth flagging: `LocalRuntime` has no dedicated
 * "re-probe connectivity now" method — the actual health probe
 * (`UpstreamSelector.tick()`) is private to `SyncEngine`, only ever called
 * on a timer (every `UPSTREAM_PROBE_INTERVAL_MS`, 5s) or as the first line
 * of `SyncEngine.start()`. So "re-check connectivity" here is approximated
 * as `stop()` then `start()`: `start()` awaits a fresh `tick()` before doing
 * anything else, which is the one guaranteed-immediate probe the public API
 * exposes. It works, but it's borrowing a lifecycle method for something it
 * wasn't named for — a real `recheckConnectivity()` on `LocalRuntime` would
 * be more honest and is worth adding upstream (see ticket report).
 *
 * After the forced re-probe, `tier` in `connectivity-store` reflects the
 * fresh result (SyncEngine's onUpstreamChange calls `setTier` synchronously
 * as part of that same `start()` call). If still `isolated`, the connectivity
 * half of the check has already answered "no" and there's nothing to sync
 * against, so that's reported directly instead of pretending a sync ran. Only
 * when an upstream was found do we run an explicit extra `syncNow()` to read
 * back its real `{ offline }` outcome — `start()` already ran one sync cycle
 * internally, but doesn't return that result, so this is the only way to get
 * an honest success/failure signal for the button.
 */
export function useManualConnectivityCheck() {
  const status = useConnectivityStore((s) => s.manualCheckStatus);
  const errorKey = useConnectivityStore((s) => s.manualCheckErrorKey);
  const setManualCheckStatus = useConnectivityStore((s) => s.setManualCheckStatus);

  const run = useCallback(async () => {
    setManualCheckStatus('checking');
    try {
      const runtime = await getBrowserLocalRuntime();
      runtime.stop();
      await runtime.start();

      if (useConnectivityStore.getState().tier === 'isolated') {
        setManualCheckStatus('error', 'offline');
        return;
      }

      const result = await runtime.syncNow();
      if (!result || result.offline) {
        setManualCheckStatus('error', 'syncFailed');
        return;
      }
      setManualCheckStatus('success');
    } catch {
      setManualCheckStatus('error', 'unknown');
    }
  }, [setManualCheckStatus]);

  return { status, errorKey, run };
}
