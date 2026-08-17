/**
 * Public surface for the 8+ approval-driving domain modules to import.
 * Never reach into `./approvals.repository` or `./document-context.resolver`
 * directly from outside this directory — `ApprovalService` is the seam.
 */
export { ApprovalsModule } from './approvals.module';
export { ApprovalService } from './approvals.service';
export type {
  ApprovalDetailRow,
  ApprovalStepDetailRow,
  CallerScope,
  DecideApprovalInput,
  DecisionOutcome,
  DecisionResult,
  NamedDecisionInput,
  OfflineReverificationInput,
  OfflineReverificationResult,
  PendingApprovalRow,
  PendingApprovalsQuery,
  SubmitApprovalInput,
  SubmitResult,
} from './types';
