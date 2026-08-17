import { Module } from '@nestjs/common';

/**
 * M23 `sync` — the HTTP/module-level surface, owned by Wave 2, agent W2-D
 * (senior-integrator), same owner as the engine it wraps.
 *
 * D-12: per-location sync status, conflict/exception queues, reconciliation
 * triggers, event forensics (CONTRACTS.md §4.23's `/api/sync/*` rows — user
 * JWT + RBAC, distinct from `kernel/sync`'s device-token `/sync/v1/*`
 * routes). Thin wrapper over `kernel/sync`'s engine (`SyncEngineModule`) —
 * the engine does the work, this module exposes the ADMIN half as
 * `/api/sync/*` endpoints.
 */
import { SyncEngineModule } from '../../kernel/sync/sync.module';
import { SyncAdminController } from './sync-admin.controller';

@Module({
  imports: [SyncEngineModule],
  controllers: [SyncAdminController],
})
export class SyncModule {}
