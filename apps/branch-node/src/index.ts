/**
 * Branch-node entrypoint (Tier 2, D-12/D-13 — optional by design, RISK-P5).
 * Loads config, opens the store (embedded Postgres when configured, else the
 * in-memory SIMULATE-mode store), and starts the relay engine: one outbound
 * socket.io connection to the cloud, never an inbound port.
 */
import { loadConfig } from './config';
import { createStore } from './store';
import { RelayEngine } from './relay';

// Re-export the public surface so this package is importable/unit-testable
// (mirrors AIRE `branch-bridge`'s `index.ts` pattern).
export { loadConfig } from './config';
export type { NodeConfig } from './config';
export { createStore, MemoryStore, PgStore } from './store';
export { RelayEngine } from './relay';
export { runScan, simulatedDevices } from './discovery/scanner';
export { CloudSyncClient } from './cloud-sync-client';
export { BridgeClient, registerNode } from './bridge-client';
export { LanServer } from './lan-server';

async function main(): Promise<void> {
  const config = loadConfig();
  console.log('[branch-node] starting branch-node agent');
  console.log(`[branch-node] cloud=${config.cloudUrl} simulate=${config.simulate}`);

  if (!config.pairingToken) {
    console.error('[branch-node] BRANCH_NODE_PAIRING_TOKEN is required (or set SIMULATE=true)');
    process.exit(1);
  }

  const store = createStore(config);
  const engine = new RelayEngine(config, store);

  try {
    await engine.start();
    console.log(`[branch-node] listening on :${engine.getLanServerPort() ?? config.healthPort} (health + /sync/v1/*)`);
  } catch (err) {
    console.error('[branch-node] fatal: failed to start:', err);
    process.exit(1);
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('[branch-node] shutting down...');
    await engine.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[branch-node] fatal:', err);
    process.exit(1);
  });
}
