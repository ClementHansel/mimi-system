import { Module } from '@nestjs/common';
import { StorageModule } from '../../kernel/storage/storage.module';
import { NotificationModule } from '../../kernel/notification/notification.module';
import { SyncEngineModule } from '../../kernel/sync/sync.module';
import { AccountingModule } from '../accounting/accounting.module';
import { AssetsController } from './assets.controller';
import { AssetsService } from './assets.service';
import { SchedulesController } from './schedules.controller';
import { SchedulesService } from './schedules.service';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';
import { MaintenanceDueSweepService } from './maintenance-due-sweep.service';

/**
 * M16 `asset` — asset register, maintenance schedules/jobs, service history
 * with photo evidence, and automatic reminders (CONTRACTS.md §4.16;
 * FR-PMS-01..04). "PIC Maintenance" is not a role (Appendix A-3) —
 * assignment is data-level (`assets.assigned_to`, `maintenance_jobs
 * .assigned_to`); execution permission `asset.job.execute` is held by
 * LDR/SPV/KGD/MGR, verification (`asset.job.verify`) by SPV/MGR/OWN.
 *
 * `AccountingModule` is imported (not just its export used ad hoc) for
 * `PaymentVerificationsService.createSystemVerification` — `jobs.service.ts
 * #complete()`'s FR-ACCT-04 payment-verification row on cost > 0 (see that
 * service's doc comment for the RLS-escalation reasoning `accounting`
 * already built for exactly this cross-module shape).
 *
 * CONTROLLER REGISTRATION ORDER IS LOAD-BEARING: `JobsController` and
 * `SchedulesController` each declare literal routes (`GET jobs`, `GET
 * maintenance/due`, `PATCH schedules/:scheduleId`) under the SAME
 * `api/assets` prefix `AssetsController` mounts its single-segment
 * `GET/PATCH :id` on — Nest/Express resolves overlapping route shapes in
 * REGISTRATION order, so both must be listed here BEFORE `AssetsController`
 * or `GET /api/assets/jobs` would be swallowed by `GET /api/assets/:id`
 * (`id='jobs'`). See `jobs.controller.ts`/`schedules.controller.ts`'s own
 * header comments for the full route-shape analysis.
 */
@Module({
  imports: [StorageModule, NotificationModule, SyncEngineModule, AccountingModule],
  controllers: [JobsController, SchedulesController, AssetsController],
  providers: [AssetsService, SchedulesService, JobsService, MaintenanceDueSweepService],
})
export class AssetModule {}
