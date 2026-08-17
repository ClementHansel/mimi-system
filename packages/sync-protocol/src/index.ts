/**
 * `@mimi/sync-protocol` public surface — frozen after Gate G1 (BUILD-PLAN §6
 * rule 4). Shared, byte-identical, by all three tiers: the cloud sync engine
 * (`apps/backend/src/kernel/sync`), the device local runtime
 * (`apps/frontend/src/lib/local`), and the branch node
 * (`apps/branch-node`). Zero I/O — every function here takes data in and
 * returns data out.
 */

// The sync_events envelope + handshake/push/pull wire shapes (SYNC-PROTOCOL §2, §4)
export * from './types';

// Idempotency-key derivation (UUIDv7) + the outbox-corruption dedupe key (§2.2, §1.5)
export * from './idempotency';

// The authority matrix as executable data + canOriginate()/resolveDirection() (§3)
export * from './authority-matrix';

// The shared stock projector: fact -> movements -> balances (D-16a, T-02)
export * from './stock-projector';

// Cursor/ordering helpers: gap detection, batch assembly, retry backoff (§2.1, §4.3-4.5)
export * from './cursor';

// Order-independent state checksums (§9, R2)
export * from './checksum';

// Payload schema registry: per-(entity,op) TS types + runtime validator, one
// declaration each (§2.3) — scoped to the wire-eligible (M/F/B) entities.
export * from './schema';
