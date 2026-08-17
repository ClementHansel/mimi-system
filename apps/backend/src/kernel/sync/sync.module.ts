import { Module } from '@nestjs/common';

/**
 * kernel/sync — Wave 2, agent W2-D (senior-integrator). SYNC-PROTOCOL.md is
 * the spec; this module is its cloud half.
 *
 * Idempotent batch ingest (`SyncIngestService`), cursors/pull/bootstrap
 * (`SyncPullService`), authority-matrix enforcement (`@mimi/sync-protocol`'s
 * `canOriginate`, wired in `SyncIngestService.checkAuthority`), conflict log
 * (`ConflictDetectorService`), offline-authorization re-verification
 * (`OfflineAuthService`), reconciliation jobs R1-R10
 * (`ReconciliationService`), the cloud-origin emit helper future domain
 * modules call (`SyncEmitService` — BUILD-PLAN §6 rule 6's
 * `SyncService.emit()`), the `/sync/v1/*` HTTP surface
 * (`SyncHttpController`) and the `/sync` socket.io namespace (`SyncGateway`).
 *
 * Everything here is exported: every Wave 3+ domain module that mutates
 * data needs `SyncEmitService` (collision rule 6 — "every mutation emits a
 * sync event"), `StockLedgerService` (W2-A) will need
 * `SyncConflictsRepository`/`SyncEventsRepository` to open C5/C6
 * reconciliation rows, and EVERY Wave 3+ module whose entity is push/
 * bidirectional (sales, attendance, waste_records, goods_receipts,
 * stock_opname, ...) needs `SyncProjectorRegistry` to self-register a
 * `SyncProjector` (see `sync-projector.types.ts`) — without one, an
 * offline-originated fact durably logs and never becomes a domain row.
 */
import { SyncEventsRepository } from './sync-events.repository';
import { SyncConflictsRepository } from './sync-conflicts.repository';
import { OfflineCredentialsRepository } from './offline-credentials.repository';
import { RegistryRepository } from './registry.repository';
import { ConflictDetectorService } from './conflict-detector.service';
import { OfflineAuthService } from './offline-auth.service';
import { ReconciliationService } from './reconciliation.service';
import { SyncIngestService } from './sync-ingest.service';
import { SyncEmitService } from './sync-emit.service';
import { SyncPullService } from './sync-pull.service';
import { SyncProjectorRegistry } from './sync-projector-registry.service';
import { DeviceAuthGuard } from './device-auth.guard';
import { SyncHttpController } from './sync-http.controller';
import { SyncGateway } from './sync.gateway';

const PROVIDERS = [
  SyncEventsRepository,
  SyncConflictsRepository,
  OfflineCredentialsRepository,
  RegistryRepository,
  ConflictDetectorService,
  OfflineAuthService,
  ReconciliationService,
  SyncIngestService,
  SyncEmitService,
  SyncPullService,
  SyncProjectorRegistry,
  DeviceAuthGuard,
  SyncGateway,
];

@Module({
  controllers: [SyncHttpController],
  providers: PROVIDERS,
  exports: [
    SyncEventsRepository,
    SyncConflictsRepository,
    OfflineCredentialsRepository,
    RegistryRepository,
    ConflictDetectorService,
    OfflineAuthService,
    ReconciliationService,
    SyncIngestService,
    SyncEmitService,
    SyncPullService,
    SyncProjectorRegistry,
  ],
})
export class SyncEngineModule {}
