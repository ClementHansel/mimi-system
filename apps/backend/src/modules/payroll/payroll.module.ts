import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../../kernel/approvals/approvals.module';
import { EventsModule } from '../../kernel/events/events.module';
import { NotificationModule } from '../../kernel/notification/notification.module';
import { PeriodsController } from './periods/periods.controller';
import { PeriodsService } from './periods/periods.service';
import { RunsController } from './runs/runs.controller';
import { RunsService } from './runs/runs.service';
import { ComponentsController } from './components/components.controller';
import { ComponentsService } from './components/components.service';
import { LoansController } from './loans/loans.controller';
import { LoansService } from './loans/loans.service';
import { StatutoryController } from './statutory/statutory.controller';
import { StatutoryService } from './statutory/statutory.service';

/**
 * M15 `payroll` — owned by Wave 4, agent W4-01 (senior-be).
 *
 * FR-HR-03/04, PIN-01..07, POUT-01..09: 7 income + 9 deduction components,
 * shift-close cash-variance → PENDING deduction proposal requiring
 * supervisor approval (D-19 — never auto-deducted), kasbon (employee loan)
 * amortization, slip gaji generation/send (CONTRACTS.md §4.15). Statutory
 * PPh21/BPJS is built but OFF by default (D-18) — a settings flag gates it,
 * and every run records which mode it ran in so historical runs stay
 * reproducible after a toggle.
 *
 * `ApprovalsModule` drives the `payroll_run`/`employee_loan` decision chains
 * (§5.7); `EventsModule` is the GL posting SEAM (`journal.action` —
 * `RunsService`'s class header explains why nothing subscribes yet, M17
 * being a stub); `NotificationModule` sends the `payroll_slip` template on
 * `send-slips`. `payroll_runs`/`payroll_lines`/`employee_loans`/
 * `salary_components` are class X in the sync authority matrix — this
 * module deliberately does NOT import `kernel/sync`'s `SyncEmitService`
 * (see `RunsService`'s header for why: calling it for a class-X entity
 * throws by the sync protocol's own design).
 */
@Module({
  imports: [ApprovalsModule, EventsModule, NotificationModule],
  controllers: [
    PeriodsController,
    RunsController,
    ComponentsController,
    LoansController,
    StatutoryController,
  ],
  providers: [PeriodsService, RunsService, ComponentsService, LoansService, StatutoryService],
  // `ComponentsService` exported for `modules/import` (bulk import of
  // `salary_components` master data, 2026-08-27 round) — safe precisely
  // because, per this header, `ComponentsService` never touches
  // `SyncEmitService` at all (class X, no sync path to inherit).
  exports: [ComponentsService],
})
export class PayrollModule {}
