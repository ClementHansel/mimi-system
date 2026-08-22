import type { Pool } from 'pg';
import type { ConfigService } from '@nestjs/config';
import { ConflictDetectorService } from '../conflict-detector.service';
import { OfflineAuthService } from '../offline-auth.service';
import { OfflineCredentialsRepository } from '../offline-credentials.repository';
import { ReconciliationService } from '../reconciliation.service';
import { RegistryRepository } from '../registry.repository';
import { SyncConflictsRepository } from '../sync-conflicts.repository';
import { SyncEventsRepository } from '../sync-events.repository';
import { SyncIngestService } from '../sync-ingest.service';
import { SyncProjectorRegistry } from '../sync-projector-registry.service';
import type { SyncProjector } from '../sync-projector.types';

/**
 * D-14 — one place that knows how to build a real `SyncIngestService`.
 *
 * Six test files used to assemble this graph by hand, each repeating the same
 * seven constructions in the same order. That is not merely repetitive: a
 * change to any of those constructors breaks all six AT ONCE, and — because
 * they are spread across four modules — usually a wave later, in files whose
 * owner has moved on. **This is exactly what produced B-02**, where the
 * multi-origin relay regressed because a constructor signature moved and the
 * hand-built copies did not.
 *
 * The factory is deliberately NOT a mock. It wires the real ingest pipeline
 * against a real pool, because the thing these suites exist to prove is that
 * a genuinely offline-shaped event survives the real path. What it removes is
 * the boilerplate, not the fidelity.
 */
export interface IngestKit {
  ingest: SyncIngestService;
  events: SyncEventsRepository;
  conflicts: SyncConflictsRepository;
  conflictDetector: ConflictDetectorService;
  offlineAuth: OfflineAuthService;
  reconciliation: ReconciliationService;
  registryRepo: RegistryRepository;
  projectors: SyncProjectorRegistry;
}

/**
 * A `ConfigService` stand-in that answers every lookup with the caller's
 * default. `OfflineAuthService` only ever reads optional tuning values, so the
 * real thing would add a Nest dependency to six suites for no coverage.
 */
function defaultConfig(): ConfigService {
  return { get: (_key: string, def?: string) => def } as unknown as ConfigService;
}

/**
 * Builds the real ingest graph.
 *
 * `projectors` defaults to an EMPTY registry — the honest default, since most
 * of these suites run in a process where no domain module has registered
 * anything. Pass the ones under test explicitly; an unregistered `(entity, op)`
 * is silently a no-op (see `SyncProjectorRegistry.project`), so a suite that
 * forgets to pass its projector proves nothing while appearing to pass.
 */
export function buildIngestKit(
  pool: Pool,
  options: { projectors?: readonly SyncProjector[]; config?: ConfigService } = {},
): IngestKit {
  const events = new SyncEventsRepository(pool);
  const conflicts = new SyncConflictsRepository();
  const registryRepo = new RegistryRepository(pool);
  const conflictDetector = new ConflictDetectorService(events, conflicts);
  const offlineAuth = new OfflineAuthService(
    new OfflineCredentialsRepository(),
    conflicts,
    options.config ?? defaultConfig(),
  );
  const reconciliation = new ReconciliationService(pool, events, conflicts, registryRepo);

  const projectors = new SyncProjectorRegistry();
  for (const projector of options.projectors ?? []) projectors.register(projector);

  const ingest = new SyncIngestService(
    events,
    conflictDetector,
    offlineAuth,
    reconciliation,
    projectors,
  );

  return {
    ingest,
    events,
    conflicts,
    conflictDetector,
    offlineAuth,
    reconciliation,
    registryRepo,
    projectors,
  };
}
