import { Module, OnModuleInit } from '@nestjs/common';
import { ApprovalsModule } from '../../kernel/approvals/approvals.module';
import { StorageModule } from '../../kernel/storage/storage.module';
import { SyncEngineModule } from '../../kernel/sync/sync.module';
import { SyncProjectorRegistry } from '../../kernel/sync/sync-projector-registry.service';
import { EmployeesController } from './employees/employees.controller';
import { ContractsController } from './contracts/contracts.controller';
import { EmployeesService } from './employees/employees.service';
import { ContractsService } from './contracts/contracts.service';
import { ShiftsController } from './shifts/shifts.controller';
import { ShiftsService } from './shifts/shifts.service';
import { AttendanceController } from './attendance/attendance.controller';
import { AttendanceService } from './attendance/attendance.service';
import { LeavesController } from './leaves/leaves.controller';
import { LeavesService } from './leaves/leaves.service';
import { AttendanceSyncProjector } from './sync/attendance-sync-projector.service';
import { LeaveSyncProjector } from './sync/leave-sync-projector.service';

/**
 * M14 `hr` — owned by Wave 3, agent W3-09 (medior).
 *
 * FR-HR-01/02: GPS + selfie geofenced attendance, shift schedules, cuti/izin
 * requests (CONTRACTS.md §4.14). Geofence radius is read per-location from
 * `locations.geofence_radius_m` (NOT a constant — `GEOFENCE_RADIUS_METERS`
 * only backstops a brand-new location with no configured center; see
 * `attendance.service.ts`'s `resolveLocation`). Leave approval delegates to
 * `kernel/approvals` (`ApprovalsModule` import below); attendance selfie
 * evidence is read back through `kernel/storage`'s `StorageService`
 * (`StorageModule` import below) to produce the `selfieUrls` the CONTRACTS
 * `AttendanceRow` shape promises. Every `employees`/`work_shifts`/
 * `shift_assignments`/`leave_requests` mutation emits a sync event via
 * `kernel/sync`'s `SyncEmitService` (`SyncEngineModule` import below) —
 * `attendance` itself does NOT (see `attendance.service.ts`'s header for
 * why: it is class F, push-only/edge-authored by SYNC-PROTOCOL §3.3, and
 * `SyncEmitService.emit()` deliberately rejects push-only entities).
 *
 * OFFLINE PROJECTION: `AttendanceSyncProjector`/`LeaveSyncProjector`
 * (`./sync/`) self-register with `kernel/sync`'s `SyncProjectorRegistry` —
 * see `sync-projector.types.ts`'s header for why this is a plain registry,
 * not a Nest multi-provider token (kernel/sync must never import a domain
 * module). This is what turns an offline-originated `attendance.checked_in`/
 * `.checked_out` and `leave_requests.submitted`/`.cancelled` fact into a
 * real row once it syncs up — without it, an outlet with no signal all
 * shift would push its check-ins and they would silently never become
 * payroll input (FR-HR-03/04, PIN-02, POUT-07).
 */
@Module({
  imports: [ApprovalsModule, StorageModule, SyncEngineModule],
  controllers: [
    EmployeesController,
    ShiftsController,
    AttendanceController,
    LeavesController,
    ContractsController,
  ],
  providers: [
    EmployeesService,
    ContractsService,
    ShiftsService,
    AttendanceService,
    LeavesService,
    AttendanceSyncProjector,
    LeaveSyncProjector,
  ],
})
export class HrModule implements OnModuleInit {
  constructor(
    private readonly registry: SyncProjectorRegistry,
    private readonly attendanceProjector: AttendanceSyncProjector,
    private readonly leaveProjector: LeaveSyncProjector,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.attendanceProjector);
    this.registry.register(this.leaveProjector);
  }
}
