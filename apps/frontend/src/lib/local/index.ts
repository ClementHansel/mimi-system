/**
 * `src/lib/local` public surface — the Tier-1 device local-first runtime
 * (BUILD-PLAN §5 W2-E, SYNC-PROTOCOL D-12). Wave 4's POS (F02) and driver
 * (F13) surfaces should import from `./api/local-runtime` (re-exported
 * below) and, in the browser, `getBrowserLocalRuntime()` from `./browser`.
 * Everything else here is exported for testability and for the rare case a
 * Wave 4 surface needs a lower-level piece directly (e.g. `stock/stock-cache`
 * for a live balance widget).
 */
export * from './types';
export * from './constants';
export * from './store/local-database';
export { createMemoryDatabase } from './store/memory-database';
export { openLocalDatabase } from './store/idb-database';
export * from './identity';
export * from './clock/clock';
export * from './idempotent-commit';
export * from './stock/stock-cache';
export * from './upstream/upstream-selector';
export * from './transport/types';
export { createHttpTransport } from './transport/http-transport';
export { drainOutboxOnce, backoffFor } from './sync/outbox-drain';
export { pullUntilCaughtUp } from './sync/pull-loop';
export { reconcilePulledEvents } from './sync/reconciler';
export { SyncEngine, runSyncCycle, type ConnectivityReporter } from './sync/sync-engine';
export * from './credentials/offline-credentials';
export * from './credentials/pin-verifier';
export * from './credentials/signature-verifier';
export * from './attachments/attachment-store';
export * from './api/local-runtime';
export { registerServiceWorker } from './sw-register';
