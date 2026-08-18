'use client';

/**
 * Registers `public/sw.js` and wires its `MIMI_SYNC_NOW` wake-up message
 * (see `sw.js`'s `sync` event handler) to `LocalRuntime.syncNow()`.
 *
 * INTEGRATION NOTE for whoever wires app bootstrap (`src/app/layout.tsx` /
 * `components/layout/AppShell.tsx` — W1-E's files, not this package's): call
 * `registerServiceWorker(runtime)` once, client-side, after
 * `getBrowserLocalRuntime()` resolves. Neither call happens automatically
 * from this file so that `src/lib/local` never imports from `src/app` or
 * `src/components` (BUILD-PLAN §6 rule 1 — this package only OWNS
 * `src/lib/local/**` and `public/**`; it does not reach into the shell).
 */
import type { LocalRuntime } from './api/local-runtime';

export async function registerServiceWorker(runtime: Pick<LocalRuntime, 'syncNow'>): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

  const registration = await navigator.serviceWorker.register('/sw.js');

  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'MIMI_SYNC_NOW') void runtime.syncNow();
  });

  // Background Sync API — best-effort; unsupported in Safari/iOS (NFR-07's
  // other target), where reconnect-triggered sync instead relies on this
  // page's own `online` event + the SyncEngine's probe timer, both already
  // wired in `getBrowserLocalRuntime()`.
  const reg = registration as ServiceWorkerRegistration & {
    sync?: { register(tag: string): Promise<void> };
  };
  if (reg.sync) {
    window.addEventListener('online', () => {
      void reg.sync?.register('mimi-outbox-drain').catch(() => undefined);
    });
  }
}
