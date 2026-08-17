export * from './types';
export { MemoryStore } from './memory-store';
export { PgStore } from './pg-store';

import type { NodeConfig } from '../config';
import { MemoryStore } from './memory-store';
import { PgStore } from './pg-store';
import type { Store } from './types';

/**
 * Chooses the store backend: `PgStore` when `databaseUrl` is configured
 * (production, embedded Postgres per SYNC-PROTOCOL §1.1), else `MemoryStore`
 * (SIMULATE mode and every test — no Postgres required, per BUILD-PLAN W2-F's
 * "genuinely representative" hardware-free requirement).
 */
export function createStore(config: Pick<NodeConfig, 'databaseUrl' | 'simulate'>): Store {
  if (config.databaseUrl && !config.simulate) {
    return new PgStore(config.databaseUrl);
  }
  return new MemoryStore();
}
