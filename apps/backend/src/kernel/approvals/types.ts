import type { PoolClient } from 'pg';
import type {
  ApprovalDocumentType,
  ApprovalMode,
  ApprovalState,
  ApprovalStepState,
  Money,
  ReverificationStatus,
  RoleKey,
  TransitionVariant,
  UUID,
} from '@mimi/shared';

/**
 * D-23 — the channels `NotificationService.notify({ channels })` should be
 * restricted to for a given `ApprovalDocumentType`'s CURRENT mode
 * (`ApprovalService.resolveNotificationChannels`). Mirrors
 * `kernel/notification/template-registry.ts`'s `NotificationChannel` union
 * shape exactly but is declared locally rather than imported — `kernel/approvals`
 * has no dependency on `kernel/notification` today and this ticket's brief
 * marks that module read-only, so this stays a same-shaped, independently
 * declared type rather than a new cross-kernel import.
 */
export type ApprovalNotificationChannel = 'in_app' | 'email' | 'whatsapp';

/**
 * Public surface of `kernel/approvals` (D-08). Every domain module
 * (replenishment, void/refund, PR/PO, opname, retur, payroll, payment
 * verification, waste, leave, loan, cash-variance) imports these types and
 * `ApprovalService` — never re-implements chain bookkeeping itself
 * (BUILD-PLAN §6 rule 5).
 *
 * The engine owns exactly the DECISION bookkeeping (`approvals` +
 * `approval_steps`, actor/timestamp/reason, offline flag + reverification):
 * it does NOT own a document's own status column (`replenishment_requests.status`,
 * `void_refunds.status`, ...) — that stays with the owning module, which
 * calls `transition()` (re-exported from `@mimi/shared`) itself for
 * non-decision workflow actions (ship/receive/dispatch/process/issue/pay/
 * close) and passes its OWN current status string into `decide()` below for
 * decision actions (submit/approve/reject/amend/cancel) so this engine can
 * validate the transition and hand back the next status for the caller to
 * persist on its own row, in the SAME transaction/`PoolClient`.
 */

/** Raw caller-supplied context needed to create the bookkeeping row for a document. */
export interface SubmitApprovalInput {
  documentType: ApprovalDocumentType;
  documentId: UUID;
  requestedBy: UUID;
  /** Doc value used for threshold routing (CONTRACTS §1.3 `approvals.amount`). Nullable for non-monetary chains. */
  amount?: Money | null;
  /**
   * Scope for "my pending approvals" (§ location filter). Domain modules MUST
   * supply the location that makes RLS-consistent sense for their document
   * (the outlet/warehouse for stock/logistics docs, the employee's home
   * location for HR docs, the shift's location for cash-variance). A `null`
   * value is legal (visible only to central roles) but loses location
   * filtering for scoped approvers — see the kernel report for why this
   * matters for `leave_request`.
   */
  locationId?: UUID | null;
  /**
   * D-23 "off" mode: when the document type's mode has no human gate,
   * `submit()` still records a decided step (`acted_by = requestedBy`) rather
   * than skipping bookkeeping — this optional role is stamped onto that
   * step's `approver_role` for a truer audit trail. Callers that omit it
   * (every pre-D-23 call site) get the `'system'` sentinel instead; the
   * ACTOR (`acted_by`, a real user id) is recorded either way — this field
   * only affects the cosmetic role label, never whether the actor is captured.
   */
  requestedByRole?: RoleKey;
}

/**
 * Which `@mimi/shared` `transition()` action names count as a chain
 * decision for THIS document type. Most chains name their decision
 * 'approve'/'reject'/'cancel' verbatim (matching `ApprovalService`'s sugar
 * wrappers of the same names) — `payment_verification` is the one chain
 * whose decision-with-escalation is named `'pay'` (its `'verify'` action has
 * no escalation and is validated by the owning module directly via
 * `transition()`, never through this engine — see the kernel report).
 * `decide()` accepts any action string for exactly this reason; the 4 named
 * wrappers below are ergonomic sugar for the common case, not the only
 * inputs this method accepts.
 */
export type DecisionOutcome = 'approved' | 'rejected' | 'cancelled';

export interface DecideApprovalInput {
  documentType: ApprovalDocumentType;
  documentId: UUID;
  /** The exact `@mimi/shared` `transition()` action name for this edge (e.g. `'approve'`, `'reject'`, `'cancel'`, or `'pay'` for payment_verification's escalation step). */
  action: string;
  /** How this decision affects the kernel's OWN bookkeeping (`approval_steps.state` / `approvals.state`) — independent of the `action` string above. */
  outcome: DecisionOutcome;
  /** The document's OWN current status string (owning module's column) — required so `transition()` can validate the edge. */
  currentState: string;
  actorUserId: UUID;
  actorRole: RoleKey;
  /** A non-empty string counts as "reason provided" to `transition()`'s reason gate — no separate boolean flag needed. */
  reason?: string | null;
  /** Replenishment/opname/SJ-receiving-style amendment (per-line qty/discrepancy change) — forces the `on_amend` reason gate. */
  isAmendment?: boolean;
  offline?: {
    credentialId: UUID;
  };
}

/** Input shape for the 4 named sugar wrappers (`action`/`outcome` are implied by the method name). */
export type NamedDecisionInput = Omit<DecideApprovalInput, 'action' | 'outcome'>;

/** `submit()`'s return — unlike `decide()`, submit never calls `transition()` (see the file header), so there is no "next document state" to report. */
export interface SubmitResult {
  approvalId: UUID;
  approvalState: ApprovalState;
  currentStep: number | null;
  stepState: ApprovalStepState;
  /** D-23 — the mode `submit()` actually resolved and acted on, read live from `settings['approval.mode']` at call time. */
  mode: ApprovalMode;
}

export interface DecisionResult {
  approvalId: UUID;
  approvalState: ApprovalState;
  /** The document's NEXT status string per `@mimi/shared`'s `transition()` — caller persists this on its own row. */
  nextState: string;
  /** `null` once the approval itself is terminal (approved/rejected/cancelled) — no further step is pending. */
  currentStep: number | null;
  stepState: ApprovalStepState;
}

export interface ApprovalStepDetailRow {
  stepNo: number;
  approverRole: string;
  state: ApprovalStepState;
  actedBy: string | null;
  actedAt: string | null;
  reason: string | null;
  offlineAuthorized: boolean;
  offlineCredentialId: string | null;
  reverificationStatus: ReverificationStatus | null;
  reverifiedAt: string | null;
}

export interface ApprovalDetailRow {
  approvalId: UUID;
  documentType: string;
  documentId: UUID;
  state: ApprovalState;
  amount: Money | null;
  locationId: UUID | null;
  requestedBy: UUID;
  requestedAt: string;
  decidedAt: string | null;
  /** `null` once `state` is terminal — mirrors `approvals.current_step`'s nullability (migration 216). */
  currentStep: number | null;
  steps: ApprovalStepDetailRow[];
}

/** CONTRACTS.md §4.0 `GET /api/approvals/pending` row shape. */
export interface PendingApprovalRow {
  approvalId: UUID;
  documentType: string;
  documentId: UUID;
  documentNumber: string | null;
  amount: Money | null;
  locationId: UUID | null;
  locationName: string | null;
  requestedBy: string;
  requestedAt: string;
  stepNo: number;
  summary: Record<string, unknown>;
}

export interface PendingApprovalsQuery {
  documentType?: ApprovalDocumentType;
  page: number;
  pageSize: number;
}

export interface CallerScope {
  userId: UUID;
  roleKey: RoleKey;
  /** `null` = unrestricted (central role, matches `ScopeService.LocationScope`). */
  locationIds: readonly UUID[] | null;
}

/** The runtime-resolved context a document carries for the 4 irregular chains (BUILD-PLAN carried-forward item 2). */
export interface DocumentContext {
  variant?: TransitionVariant;
}

export interface OfflineReverificationInput {
  approvalStepId: UUID;
  outcome: ReverificationStatus;
}

export interface OfflineReverificationResult {
  approvalId: UUID;
  stepNo: number;
  outcome: ReverificationStatus;
  /** `true` for `failed`/`unprovable` — SYNC-PROTOCOL §7.4/§7.5: route to the finance exception queue (owned by kernel/sync, W2-D — this engine only flags it). */
  requiresFinanceException: boolean;
}

/** Every method below takes a caller-supplied `PoolClient` — see `ScopeService`'s class comment for why (BUILD-PLAN §1 D-21, `common/scope/scope.service.ts`). */
export type DbClient = PoolClient;
