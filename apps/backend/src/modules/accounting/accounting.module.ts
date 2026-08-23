import { Module } from '@nestjs/common';
import { EventsModule } from '../../kernel/events/events.module';
import { SyncEngineModule } from '../../kernel/sync/sync.module';
import {
  AccountsController,
  DailyPostingController,
  ExceptionsController,
  GlCoverageController,
  JournalController,
  PaymentsController,
  PeriodsController,
  PostingRulesController,
  ReportsController,
} from './accounting.controller';
import { ChartOfAccountsService } from './chart-of-accounts.service';
import { FiscalPeriodsService } from './fiscal-periods.service';
import { JournalService } from './journal.service';
import { PostingEngineService } from './posting-engine.service';
import { PaymentVerificationsService } from './payment-verifications.service';
import { ReportsService } from './reports.service';
import { DailyPostingService } from './daily-posting.service';
import { DailyPostingScheduler } from './daily-posting.scheduler';
import { ExceptionsService } from './exceptions.service';
import { GlCoverageService } from './gl-coverage.service';

/**
 * M17 `accounting` — owned by Wave 4, agent W4-03 (senior-be).
 *
 * D-04 full double-entry GL: COA, fiscal periods, balanced journal entries,
 * a declarative posting-rule engine consuming domain events (`StockMoved`,
 * sales, payroll runs, …) from `kernel/events`, payment verification, trial
 * balance / P&L / balance sheet (FR-ACCT-01..04 — CONTRACTS.md §4.17, §6).
 * The 16 PRD journal event types + 7 system extensions (§6.2/§6.3) are
 * posting RULES the engine reacts to (`PostingEngineService`, subscribed to
 * `EventBus`'s `journal.action`) — every domain module stays unaware of GL
 * mechanics beyond `eventBus.publish('journal.action', ...)`.
 *
 * `PaymentVerificationsService` is exported (unlike every other provider
 * here) so a future cross-module caller — `modules/pos` chief among them,
 * see that service's doc comment on the RLS carried item — can inject it
 * directly for the escalated `createSystemVerification` path, the same way
 * `StockLedgerModule`/`ApprovalsModule` already export their services for
 * `modules/stock-opname` to consume.
 */
@Module({
  imports: [EventsModule, SyncEngineModule],
  controllers: [
    AccountsController,
    PostingRulesController,
    JournalController,
    DailyPostingController,
    PeriodsController,
    ReportsController,
    PaymentsController,
    ExceptionsController,
    GlCoverageController,
  ],
  providers: [
    ChartOfAccountsService,
    FiscalPeriodsService,
    JournalService,
    PostingEngineService,
    PaymentVerificationsService,
    ReportsService,
    ExceptionsService,
    DailyPostingService,
    DailyPostingScheduler,
    GlCoverageService,
  ],
  exports: [
    PaymentVerificationsService,
    JournalService,
    ChartOfAccountsService,
    DailyPostingService,
  ],
})
export class AccountingModule {}
