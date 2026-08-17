import { Module } from '@nestjs/common';
import { NotificationModule } from '../notification/notification.module';
import { ApprovalsController } from './approvals.controller';
import { ApprovalsRepository } from './approvals.repository';
import { ApprovalService } from './approvals.service';

/**
 * kernel/approvals — owned by Wave 2, agent W2-B (senior-be).
 *
 * Generic approval engine (D-08) driving all 12 `ApprovalDocumentType`
 * chains (CONTRACTS.md §5): submit/approve/reject/amend/cancel, multi-step
 * chains per `approval_chain_steps` + live `settings` thresholds, actor +
 * timestamp + reason (mandatory on reject/amend — FR-LOG-13, FR-SO-02),
 * `offline_authorized` + re-verification hook (D-17), and "my pending
 * approvals" (`GET /api/approvals/pending`, CONTRACTS.md §4.0) scoped by
 * role and location.
 *
 * `ApprovalService` is exported for the 8 approval-driving domain modules
 * (replenishment, void/refund, PR/PO, opname, retur, payroll, payment
 * verification, waste, leave, loan, cash-variance) to inject directly —
 * never hand-roll an approval flow (BUILD-PLAN §6 rule 5).
 *
 * `DatabaseModule`/`ScopeModule`/`RlsContextGuard` are `@Global()` (Wave 1,
 * BUILD-PLAN §6 rule 2) so nothing needs importing here for DB access —
 * every method takes the caller-supplied `PoolClient` instead of acquiring
 * its own connection, per `ScopeService`'s established pattern.
 *
 * `NotificationModule` (B-07): `ApprovalService` fires `NotificationService`
 * calls itself on submit/step-advance/decision — see that service's file
 * header — so this module needs `NotificationService` in its own DI graph,
 * the same way `modules/payroll`'s module already imports BOTH
 * `ApprovalsModule` and `NotificationModule` side by side for its own
 * `payroll_slip` notify call.
 */
@Module({
  imports: [NotificationModule],
  controllers: [ApprovalsController],
  providers: [ApprovalsRepository, ApprovalService],
  exports: [ApprovalService],
})
export class ApprovalsModule {}
