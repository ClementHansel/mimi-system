/**
 * Approval state machines — CONTRACTS.md §5, transcribed as data, with a pure
 * `transition()` executor. Kernel engine is D-08; this module is the
 * declarative transition table + role/reason/offline gate the engine
 * (`apps/backend/src/kernel/approvals`) runs against — it holds no I/O and no
 * approval-chain-threshold routing (that reads `settings['approval.threshold.*']`
 * at runtime and is the engine's job, not this pure function's).
 *
 * Global rules encoded here (§5 preamble):
 *  - Reason is MANDATORY on every reject and every amend (`reasonRequired: true`
 *    or `'on_amend'`) — the engine refuses the transition without it.
 *  - Offline-provisional (D-17) is allowed ONLY where `offlineEligible: true` —
 *    the closed list from SYNC-PROTOCOL §7.6: `void_refund.approve`, the
 *    replenishment SUPERVISOR step, the outlet `waste.approve` step. Payment
 *    verification, PO/PR approvals, stock-adjustment posting, opname
 *    adjudication, payroll, cash-variance decisions (D-19), leave, and
 *    employee loans are never offline-eligible.
 *  - MGR/OWN may act on any step at or below their level (role-rank override)
 *    — modeled generically via `ROLE_RANK`, not by re-listing OWNER/MANAGER on
 *    every rule (see `isRoleAuthorized`).
 *
 * `waste_records`'s §5.10 chain uses `ApprovalDocumentType.WASTE` — added to
 * the enum by architect follow-up after the W1-B report flagged that it was
 * originally missing (Appendix A-5 said waste needed no extra table, which
 * left it without an enum member; W1-C adds the matching DB CHECK value).
 */
import { ApprovalDocumentType, ReturnDirection, RoleKey } from '../enums';
import { ROLE_RANK } from '../constants';
import {
  ERR_APPROVAL_INVALID_TRANSITION,
  ERR_APPROVAL_STEP_ROLE,
  ERR_OFFLINE_NOT_ELIGIBLE,
  ERR_REASON_REQUIRED,
} from '../error-codes';

/** A pseudo-actor for auto-created/system transitions (e.g. R7 shift-close, cash-variance auto-propose). */
export const SYSTEM_ACTOR = 'system' as const;
export type Actor = RoleKey | typeof SYSTEM_ACTOR;

/** The initial pseudo-state for documents that don't pre-exist in `draft`. */
export const NONE_STATE = '(none)' as const;

export type TransitionDocumentType = ApprovalDocumentType;

/** Disambiguates chains that share a document type but differ by which leg/location applies. */
export type TransitionVariant = ReturnDirection | 'outlet' | 'warehouse' | undefined;

export interface ApprovalTransitionRule {
  documentType: TransitionDocumentType;
  variant?: TransitionVariant;
  from: string;
  action: string;
  to: string;
  /** Roles explicitly named in CONTRACTS.md §5's "Role" column for this step. */
  roles: readonly Actor[];
  /** `true` = always required; `'on_amend'` = required only when `isAmendment`/discrepancy is flagged; `false` = never. */
  reasonRequired: boolean | 'on_amend';
  offlineEligible: boolean;
  /** Free-text pointer back to the CONTRACTS.md row, for audit/debugging only. */
  note?: string;
}

export interface TransitionRequest {
  documentType: TransitionDocumentType;
  variant?: TransitionVariant;
  currentState: string;
  action: string;
  actorRole: Actor;
  /** Whether a non-empty reason string was supplied with the request. */
  reasonProvided?: boolean;
  /** Whether this call amends quantities/lines (replenishment) or reports a discrepancy (receiving). */
  isAmendment?: boolean;
  /** Whether this call is being recorded via an offline-provisional credential (D-17). */
  offlineAttempt?: boolean;
}

export type TransitionResult =
  | { ok: true; nextState: string; reasonRequired: boolean; offlineEligible: boolean }
  | { ok: false; code: string; message: string };

/**
 * The role-rank-override authorization check (§5 preamble: "MGR/OWN may act
 * on any step at or below their level"). Exported deliberately — it is the
 * ONE implementation of this rule in the codebase. `transition()` uses it
 * internally (see the agreement property test in `state-machine.test.ts`);
 * any consumer that needs to pre-filter candidate approvers BEFORE calling
 * `transition()` (e.g. "which of my assigned users could act on this step",
 * "should this user see an approve button") must import this rather than
 * reimplementing rank comparison against `ROLE_RANK` itself — a second
 * implementation is exactly how this rule silently drifts from this one.
 */
export function isRoleAuthorized(eligible: readonly Actor[], actor: Actor): boolean {
  if (eligible.includes(actor)) return true;
  if (actor === SYSTEM_ACTOR) return false; // system rules must list 'system' explicitly, never implied
  if (!eligible.some((r) => r !== SYSTEM_ACTOR)) return false; // a system-only rule accepts no human override
  // Role-rank override (§5 preamble): a human actor ranked at or above every
  // explicitly-listed human role for this step is also authorized.
  const humanRoles = eligible.filter((r): r is RoleKey => r !== SYSTEM_ACTOR);
  const maxRequiredRank = Math.max(...humanRoles.map((r) => ROLE_RANK[r]));
  return (
    ROLE_RANK[actor] >= maxRequiredRank && (actor === RoleKey.OWNER || actor === RoleKey.MANAGER)
  );
}

const ALL_ROLES: readonly RoleKey[] = Object.values(RoleKey);
/** Every possible actor, human roles plus the system pseudo-actor — the universe `eligibleActorsForAction` filters. */
const ALL_ACTORS: readonly Actor[] = [...ALL_ROLES, SYSTEM_ACTOR];

function rule(r: ApprovalTransitionRule): ApprovalTransitionRule {
  return r;
}

// prettier-ignore
export const APPROVAL_TRANSITIONS: readonly ApprovalTransitionRule[] = [
  // ── §5.1 Replenishment request (chain: SPV → KGD) ─────────────────────────
  rule({ documentType: ApprovalDocumentType.REPLENISHMENT_REQUEST, from: NONE_STATE, action: 'submit', to: 'submitted', roles: [RoleKey.LEADER_OUTLET, RoleKey.SUPERVISOR], reasonRequired: false, offlineEligible: true, note: '§5.1 row 1' }),
  rule({ documentType: ApprovalDocumentType.REPLENISHMENT_REQUEST, from: 'draft', action: 'delete', to: '(deleted)', roles: [RoleKey.LEADER_OUTLET, RoleKey.SUPERVISOR], reasonRequired: false, offlineEligible: true, note: '§5.1 row 2' }),
  rule({ documentType: ApprovalDocumentType.REPLENISHMENT_REQUEST, from: 'submitted', action: 'approve', to: 'awaiting_approval', roles: [RoleKey.SUPERVISOR], reasonRequired: 'on_amend', offlineEligible: true, note: '§5.1 row 3 — provisional (§7.6)' }),
  rule({ documentType: ApprovalDocumentType.REPLENISHMENT_REQUEST, from: 'submitted', action: 'reject', to: 'rejected', roles: [RoleKey.SUPERVISOR], reasonRequired: true, offlineEligible: false, note: '§5.1 row 4' }),
  rule({ documentType: ApprovalDocumentType.REPLENISHMENT_REQUEST, from: 'awaiting_approval', action: 'approve', to: 'approved', roles: [RoleKey.KEPALA_GUDANG], reasonRequired: 'on_amend', offlineEligible: false, note: '§5.1 row 5' }),
  rule({ documentType: ApprovalDocumentType.REPLENISHMENT_REQUEST, from: 'awaiting_approval', action: 'reject', to: 'rejected', roles: [RoleKey.KEPALA_GUDANG], reasonRequired: true, offlineEligible: false, note: '§5.1 row 6' }),
  rule({ documentType: ApprovalDocumentType.REPLENISHMENT_REQUEST, from: 'approved', action: 'process', to: 'processing', roles: [RoleKey.KEPALA_GUDANG], reasonRequired: false, offlineEligible: false, note: '§5.1 row 7' }),
  rule({ documentType: ApprovalDocumentType.REPLENISHMENT_REQUEST, from: 'processing', action: 'dispatch', to: 'shipped', roles: [RoleKey.KEPALA_GUDANG], reasonRequired: false, offlineEligible: false, note: '§5.1 row 8' }),
  rule({ documentType: ApprovalDocumentType.REPLENISHMENT_REQUEST, from: 'shipped', action: 'receive', to: 'received', roles: [RoleKey.LEADER_OUTLET, RoleKey.SUPERVISOR], reasonRequired: 'on_amend', offlineEligible: true, note: '§5.1 row 9 — receiving is a fact' }),
  rule({ documentType: ApprovalDocumentType.REPLENISHMENT_REQUEST, from: 'received', action: 'auto_complete', to: 'completed', roles: [SYSTEM_ACTOR], reasonRequired: false, offlineEligible: false, note: '§5.1 row 10' }),

  // ── §5.2 Void / refund (chain: SPV → MGR above threshold) ─────────────────
  rule({ documentType: ApprovalDocumentType.VOID_REFUND, from: NONE_STATE, action: 'request', to: 'pending', roles: [RoleKey.KASIR], reasonRequired: true, offlineEligible: true, note: '§5.2 row 1' }),
  rule({ documentType: ApprovalDocumentType.VOID_REFUND, from: 'pending', action: 'approve', to: 'approved', roles: [RoleKey.SUPERVISOR], reasonRequired: false, offlineEligible: true, note: '§5.2 row 2 — provisional; MGR step above threshold via rank override' }),
  rule({ documentType: ApprovalDocumentType.VOID_REFUND, from: 'pending', action: 'reject', to: 'rejected', roles: [RoleKey.SUPERVISOR], reasonRequired: true, offlineEligible: false, note: '§5.2 row 3' }),

  // ── §5.3 Purchase request → purchase order ─────────────────────────────────
  rule({ documentType: ApprovalDocumentType.PURCHASE_REQUEST, from: 'draft', action: 'submit', to: 'submitted', roles: [RoleKey.KEPALA_GUDANG, RoleKey.SUPERVISOR], reasonRequired: false, offlineEligible: false, note: '§5.3 row 1' }),
  rule({ documentType: ApprovalDocumentType.PURCHASE_REQUEST, from: 'submitted', action: 'approve', to: 'approved', roles: [RoleKey.MANAGER], reasonRequired: false, offlineEligible: false, note: '§5.3 row 2' }),
  rule({ documentType: ApprovalDocumentType.PURCHASE_REQUEST, from: 'submitted', action: 'reject', to: 'rejected', roles: [RoleKey.MANAGER], reasonRequired: true, offlineEligible: false, note: '§5.3 row 3' }),
  rule({ documentType: ApprovalDocumentType.PURCHASE_REQUEST, from: 'approved', action: 'convert', to: 'converted', roles: [RoleKey.KEPALA_GUDANG, RoleKey.MANAGER], reasonRequired: false, offlineEligible: false, note: '§5.3 row 4' }),

  rule({ documentType: ApprovalDocumentType.PURCHASE_ORDER, from: 'draft', action: 'submit', to: 'pending_approval', roles: [RoleKey.KEPALA_GUDANG, RoleKey.MANAGER], reasonRequired: false, offlineEligible: false, note: '§5.3 row 5' }),
  rule({ documentType: ApprovalDocumentType.PURCHASE_ORDER, from: 'pending_approval', action: 'approve', to: 'approved', roles: [RoleKey.MANAGER], reasonRequired: false, offlineEligible: false, note: '§5.3 rows 6-7 — OWN step above threshold via rank override' }),
  rule({ documentType: ApprovalDocumentType.PURCHASE_ORDER, from: 'pending_approval', action: 'reject', to: 'draft', roles: [RoleKey.MANAGER], reasonRequired: true, offlineEligible: false, note: '§5.3 row 8 — back to editable draft' }),
  rule({ documentType: ApprovalDocumentType.PURCHASE_ORDER, from: 'approved', action: 'issue', to: 'issued', roles: [RoleKey.KEPALA_GUDANG, RoleKey.MANAGER], reasonRequired: false, offlineEligible: false, note: '§5.3 row 9' }),
  rule({ documentType: ApprovalDocumentType.PURCHASE_ORDER, from: 'issued', action: 'receive', to: 'partially_received', roles: [RoleKey.KEPALA_GUDANG, RoleKey.LEADER_OUTLET], reasonRequired: 'on_amend', offlineEligible: false, note: '§5.3 row 10 (partial)' }),
  rule({ documentType: ApprovalDocumentType.PURCHASE_ORDER, from: 'partially_received', action: 'receive', to: 'partially_received', roles: [RoleKey.KEPALA_GUDANG, RoleKey.LEADER_OUTLET], reasonRequired: 'on_amend', offlineEligible: false, note: '§5.3 row 10 (further partial delivery)' }),
  rule({ documentType: ApprovalDocumentType.PURCHASE_ORDER, from: 'partially_received', action: 'receive_complete', to: 'received', roles: [RoleKey.KEPALA_GUDANG, RoleKey.LEADER_OUTLET], reasonRequired: 'on_amend', offlineEligible: false, note: '§5.3 row 10 (all lines full)' }),
  rule({ documentType: ApprovalDocumentType.PURCHASE_ORDER, from: 'received', action: 'close', to: 'closed', roles: [RoleKey.FINANCE], reasonRequired: false, offlineEligible: false, note: '§5.3 row 11' }),
  ...(['draft', 'pending_approval', 'approved', 'issued', 'partially_received'] as const).map((from) =>
    rule({ documentType: ApprovalDocumentType.PURCHASE_ORDER, from, action: 'cancel', to: 'cancelled', roles: [RoleKey.MANAGER], reasonRequired: true, offlineEligible: false, note: '§5.3 row 12' }),
  ),

  // ── §5.4 Stock opname adjustment (chain: SPV [outlet] / KGD [warehouse] → MGR above threshold) ──
  rule({ documentType: ApprovalDocumentType.STOCK_OPNAME, from: 'counting', action: 'submit', to: 'submitted', roles: [RoleKey.LEADER_OUTLET, RoleKey.SUPERVISOR, RoleKey.KEPALA_GUDANG], reasonRequired: false, offlineEligible: true, note: '§5.4 row 2 — queued' }),
  rule({ documentType: ApprovalDocumentType.STOCK_OPNAME, from: 'submitted', action: 'approve', to: 'adjusted', roles: [RoleKey.SUPERVISOR, RoleKey.KEPALA_GUDANG], reasonRequired: false, offlineEligible: false, note: '§5.4 rows 3-4 — adjudication is online-only; MGR step above threshold via rank override' }),
  rule({ documentType: ApprovalDocumentType.STOCK_OPNAME, from: 'submitted', action: 'reject', to: 'rejected', roles: [RoleKey.SUPERVISOR, RoleKey.KEPALA_GUDANG], reasonRequired: true, offlineEligible: false, note: '§5.4 row 5' }),
  rule({ documentType: ApprovalDocumentType.STOCK_OPNAME, from: 'draft', action: 'cancel', to: 'cancelled', roles: [RoleKey.LEADER_OUTLET, RoleKey.SUPERVISOR, RoleKey.KEPALA_GUDANG], reasonRequired: false, offlineEligible: true, note: '§5.4 row 6' }),
  rule({ documentType: ApprovalDocumentType.STOCK_OPNAME, from: 'counting', action: 'cancel', to: 'cancelled', roles: [RoleKey.LEADER_OUTLET, RoleKey.SUPERVISOR, RoleKey.KEPALA_GUDANG], reasonRequired: false, offlineEligible: true, note: '§5.4 row 6' }),

  // ── §5.5 Retur outlet → gudang ──────────────────────────────────────────────
  rule({ documentType: ApprovalDocumentType.RETURN, variant: ReturnDirection.OUTLET_TO_WAREHOUSE, from: 'draft', action: 'submit', to: 'submitted', roles: [RoleKey.LEADER_OUTLET, RoleKey.SUPERVISOR], reasonRequired: false, offlineEligible: true, note: '§5.5 row 1' }),
  rule({ documentType: ApprovalDocumentType.RETURN, variant: ReturnDirection.OUTLET_TO_WAREHOUSE, from: 'submitted', action: 'approve', to: 'approved', roles: [RoleKey.SUPERVISOR], reasonRequired: false, offlineEligible: false, note: '§5.5 row 2' }),
  rule({ documentType: ApprovalDocumentType.RETURN, variant: ReturnDirection.OUTLET_TO_WAREHOUSE, from: 'submitted', action: 'reject', to: 'rejected', roles: [RoleKey.SUPERVISOR], reasonRequired: true, offlineEligible: false, note: '§5.5 row 3' }),
  rule({ documentType: ApprovalDocumentType.RETURN, variant: ReturnDirection.OUTLET_TO_WAREHOUSE, from: 'approved', action: 'ship', to: 'in_transit', roles: [RoleKey.LEADER_OUTLET, RoleKey.SUPERVISOR], reasonRequired: false, offlineEligible: true, note: '§5.5 row 4' }),
  rule({ documentType: ApprovalDocumentType.RETURN, variant: ReturnDirection.OUTLET_TO_WAREHOUSE, from: 'in_transit', action: 'receive', to: 'received', roles: [RoleKey.KEPALA_GUDANG], reasonRequired: 'on_amend', offlineEligible: false, note: '§5.5 row 5' }),
  rule({ documentType: ApprovalDocumentType.RETURN, variant: ReturnDirection.OUTLET_TO_WAREHOUSE, from: 'received', action: 'complete', to: 'completed', roles: [RoleKey.KEPALA_GUDANG, RoleKey.MANAGER], reasonRequired: false, offlineEligible: false, note: '§5.5 row 6' }),

  // ── §5.6 Retur gudang → supplier (class X — online only) ───────────────────
  rule({ documentType: ApprovalDocumentType.RETURN, variant: ReturnDirection.WAREHOUSE_TO_SUPPLIER, from: 'draft', action: 'submit', to: 'submitted', roles: [RoleKey.KEPALA_GUDANG], reasonRequired: false, offlineEligible: false, note: '§5.6 row 1' }),
  rule({ documentType: ApprovalDocumentType.RETURN, variant: ReturnDirection.WAREHOUSE_TO_SUPPLIER, from: 'submitted', action: 'approve', to: 'approved', roles: [RoleKey.KEPALA_GUDANG, RoleKey.MANAGER], reasonRequired: false, offlineEligible: false, note: '§5.6 row 2' }),
  rule({ documentType: ApprovalDocumentType.RETURN, variant: ReturnDirection.WAREHOUSE_TO_SUPPLIER, from: 'submitted', action: 'reject', to: 'rejected', roles: [RoleKey.KEPALA_GUDANG, RoleKey.MANAGER], reasonRequired: true, offlineEligible: false, note: '§5.6 row 3' }),
  rule({ documentType: ApprovalDocumentType.RETURN, variant: ReturnDirection.WAREHOUSE_TO_SUPPLIER, from: 'approved', action: 'ship', to: 'in_transit', roles: [RoleKey.KEPALA_GUDANG], reasonRequired: false, offlineEligible: false, note: '§5.6 row 4' }),
  rule({ documentType: ApprovalDocumentType.RETURN, variant: ReturnDirection.WAREHOUSE_TO_SUPPLIER, from: 'in_transit', action: 'complete', to: 'completed', roles: [RoleKey.KEPALA_GUDANG], reasonRequired: false, offlineEligible: false, note: '§5.6 row 5' }),

  // ── §5.7 Payroll run (chain: FIN → OWN; never offline) ─────────────────────
  rule({ documentType: ApprovalDocumentType.PAYROLL_RUN, from: 'draft', action: 'calculate', to: 'calculated', roles: [RoleKey.HR_ADMIN], reasonRequired: false, offlineEligible: false, note: '§5.7 row 1' }),
  rule({ documentType: ApprovalDocumentType.PAYROLL_RUN, from: 'calculated', action: 'edit_line', to: 'calculated', roles: [RoleKey.HR_ADMIN], reasonRequired: true, offlineEligible: false, note: '§5.7 row 2' }),
  rule({ documentType: ApprovalDocumentType.PAYROLL_RUN, from: 'calculated', action: 'submit', to: 'pending_approval', roles: [RoleKey.HR_ADMIN], reasonRequired: false, offlineEligible: false, note: '§5.7 row 3' }),
  rule({ documentType: ApprovalDocumentType.PAYROLL_RUN, from: 'pending_approval', action: 'approve', to: 'approved', roles: [RoleKey.FINANCE], reasonRequired: false, offlineEligible: false, note: '§5.7 rows 4-5 — OWN step 2 via rank override' }),
  rule({ documentType: ApprovalDocumentType.PAYROLL_RUN, from: 'pending_approval', action: 'reject', to: 'calculated', roles: [RoleKey.FINANCE], reasonRequired: true, offlineEligible: false, note: '§5.7 row 6' }),
  rule({ documentType: ApprovalDocumentType.PAYROLL_RUN, from: 'approved', action: 'pay', to: 'paid', roles: [RoleKey.FINANCE], reasonRequired: false, offlineEligible: false, note: '§5.7 row 7' }),
  rule({ documentType: ApprovalDocumentType.PAYROLL_RUN, from: 'draft', action: 'cancel', to: 'cancelled', roles: [RoleKey.HR_ADMIN], reasonRequired: true, offlineEligible: false, note: '§5.7 row 8' }),
  rule({ documentType: ApprovalDocumentType.PAYROLL_RUN, from: 'calculated', action: 'cancel', to: 'cancelled', roles: [RoleKey.HR_ADMIN], reasonRequired: true, offlineEligible: false, note: '§5.7 row 8' }),

  // ── §5.8 Payment verification (never offline) ──────────────────────────────
  rule({ documentType: ApprovalDocumentType.PAYMENT_VERIFICATION, from: NONE_STATE, action: 'create', to: 'pending', roles: [SYSTEM_ACTOR], reasonRequired: false, offlineEligible: false, note: '§5.8 row 1' }),
  rule({ documentType: ApprovalDocumentType.PAYMENT_VERIFICATION, from: 'pending', action: 'verify', to: 'verified', roles: [RoleKey.FINANCE], reasonRequired: false, offlineEligible: false, note: '§5.8 row 3' }),
  rule({ documentType: ApprovalDocumentType.PAYMENT_VERIFICATION, from: 'pending', action: 'reject', to: 'rejected', roles: [RoleKey.FINANCE], reasonRequired: true, offlineEligible: false, note: '§5.8 row 4' }),
  rule({ documentType: ApprovalDocumentType.PAYMENT_VERIFICATION, from: 'verified', action: 'pay', to: 'paid', roles: [RoleKey.FINANCE], reasonRequired: false, offlineEligible: false, note: '§5.8 row 5 — OWN step above threshold via rank override' }),
  rule({ documentType: ApprovalDocumentType.PAYMENT_VERIFICATION, from: 'verified', action: 'reject', to: 'rejected', roles: [RoleKey.FINANCE], reasonRequired: true, offlineEligible: false, note: '§5.8 row 6' }),

  // ── §5.9 Cash variance proposal (D-19 / Amendment 2 — NOT offline-eligible) ─
  rule({ documentType: ApprovalDocumentType.CASH_VARIANCE_PROPOSAL, from: NONE_STATE, action: 'auto_create', to: 'pending', roles: [SYSTEM_ACTOR], reasonRequired: false, offlineEligible: false, note: '§5.9 row 1' }),
  rule({ documentType: ApprovalDocumentType.CASH_VARIANCE_PROPOSAL, from: 'pending', action: 'approve', to: 'approved', roles: [RoleKey.SUPERVISOR], reasonRequired: true, offlineEligible: false, note: '§5.9 row 2 — reason REQUIRED on approve too; excluded from D-17 (SYNC-PROTOCOL §7.6)' }),
  rule({ documentType: ApprovalDocumentType.CASH_VARIANCE_PROPOSAL, from: 'pending', action: 'reject', to: 'rejected', roles: [RoleKey.SUPERVISOR], reasonRequired: true, offlineEligible: false, note: '§5.9 row 3' }),
  rule({ documentType: ApprovalDocumentType.CASH_VARIANCE_PROPOSAL, from: 'pending', action: 'cancel', to: 'cancelled', roles: [RoleKey.MANAGER], reasonRequired: true, offlineEligible: false, note: '§5.9 row 4' }),

  // ── §5.10 Minor chains ──────────────────────────────────────────────────────
  rule({ documentType: ApprovalDocumentType.LEAVE_REQUEST, from: 'pending', action: 'approve', to: 'approved', roles: [RoleKey.SUPERVISOR, RoleKey.HR_ADMIN], reasonRequired: false, offlineEligible: false, note: '§5.10 leave' }),
  rule({ documentType: ApprovalDocumentType.LEAVE_REQUEST, from: 'pending', action: 'reject', to: 'rejected', roles: [RoleKey.SUPERVISOR, RoleKey.HR_ADMIN], reasonRequired: true, offlineEligible: false, note: '§5.10 leave' }),
  rule({ documentType: ApprovalDocumentType.LEAVE_REQUEST, from: 'pending', action: 'cancel', to: 'cancelled', roles: ALL_ROLES, reasonRequired: false, offlineEligible: false, note: '§5.10 leave — own request only (ownership check is the caller\'s job, not RBAC)' }),

  rule({ documentType: ApprovalDocumentType.EMPLOYEE_LOAN, from: 'pending', action: 'approve', to: 'active', roles: [RoleKey.FINANCE], reasonRequired: false, offlineEligible: false, note: '§5.10 loan' }),
  rule({ documentType: ApprovalDocumentType.EMPLOYEE_LOAN, from: 'pending', action: 'reject', to: 'rejected', roles: [RoleKey.FINANCE], reasonRequired: true, offlineEligible: false, note: '§5.10 loan' }),

  // Waste (§5.10) — two variants: outlet step (offline-eligible) and warehouse step (online-only).
  rule({ documentType: ApprovalDocumentType.WASTE, variant: 'outlet', from: 'pending', action: 'approve', to: 'approved', roles: [RoleKey.SUPERVISOR], reasonRequired: false, offlineEligible: true, note: '§5.10 waste — outlet step, offline-provisional (§7.6, scope cap waste.approve.max_idr)' }),
  rule({ documentType: ApprovalDocumentType.WASTE, variant: 'warehouse', from: 'pending', action: 'approve', to: 'approved', roles: [RoleKey.KEPALA_GUDANG], reasonRequired: false, offlineEligible: false, note: '§5.10 waste — gudang step, online only' }),
  rule({ documentType: ApprovalDocumentType.WASTE, from: 'pending', action: 'reject', to: 'rejected', roles: [RoleKey.SUPERVISOR, RoleKey.KEPALA_GUDANG], reasonRequired: true, offlineEligible: false, note: '§5.10 waste — either variant' }),
];

/** The `(documentType, variant?, currentState, action)` coordinates that select one rule — the shape every lookup helper below shares with `TransitionRequest`. */
export type RuleLookup = Pick<
  TransitionRequest,
  'documentType' | 'variant' | 'currentState' | 'action'
>;

/**
 * Resolves the single `ApprovalTransitionRule` matching `lookup`, or
 * `undefined` if none exists. This is the ONE rule-resolution
 * implementation — `transition()` calls it internally, and it is exported so
 * a consumer can inspect a rule's `roles`/`reasonRequired`/`offlineEligible`
 * (e.g. to render UI affordances, or to pre-filter which actions are even
 * possible from a state) without going through the full `transition()` side
 * effects (which require also supplying `reasonProvided`/`isAmendment`).
 *
 * Variant resolution: prefers an exact variant match when both a
 * variant-specific and a variant-agnostic rule matched the same lookup (e.g.
 * waste's shared reject rule applies regardless of `'outlet'`/`'warehouse'`).
 */
export function findApplicableRule(lookup: RuleLookup): ApprovalTransitionRule | undefined {
  const candidates = APPROVAL_TRANSITIONS.filter(
    (r) =>
      r.documentType === lookup.documentType &&
      (r.variant === undefined || lookup.variant === undefined || r.variant === lookup.variant) &&
      r.from === lookup.currentState &&
      r.action === lookup.action,
  );
  if (candidates.length === 0) return undefined;
  return (
    candidates.find((r) => r.variant === lookup.variant) ??
    candidates.find((r) => r.variant === undefined) ??
    candidates[0]
  );
}

/**
 * Pre-filter helper: would `actorRole` be authorized to perform this action
 * from this state, ignoring reason/offline requirements? Combines
 * `findApplicableRule` + `isRoleAuthorized` so a consumer deciding "should
 * this user see an approve button" doesn't need its own copy of either
 * lookup. Returns `false` (not a rejection code) for a nonexistent
 * transition — this is a yes/no pre-check, not `transition()` itself.
 */
export function isActorEligibleForAction(lookup: RuleLookup & { actorRole: Actor }): boolean {
  const rule = findApplicableRule(lookup);
  return rule !== undefined && isRoleAuthorized(rule.roles, lookup.actorRole);
}

/**
 * Pre-filter helper: every actor (explicit role or rank-override-qualified
 * OWNER/MANAGER) who could perform this action from this state. Useful for
 * building a candidate-approver list or a notification fan-out BEFORE any
 * document reaches that state — e.g. "who should be notified as an eligible
 * approver for this replenishment request once it's submitted". Returns `[]`
 * for a nonexistent transition.
 */
export function eligibleActorsForAction(lookup: RuleLookup): readonly Actor[] {
  const rule = findApplicableRule(lookup);
  if (!rule) return [];
  return ALL_ACTORS.filter((actor) => isRoleAuthorized(rule.roles, actor));
}

/**
 * The pure transition executor. Looks up the single matching rule for
 * `(documentType, variant, currentState, action)`, then enforces role
 * authorization (with the role-rank override), offline eligibility, and the
 * reason requirement, in that order — matching the precedence a human reading
 * §5 would apply (find the rule, check who may act, check how, check what
 * they must supply).
 */
export function transition(request: TransitionRequest): TransitionResult {
  const rule = findApplicableRule(request);

  if (!rule) {
    return {
      ok: false,
      code: ERR_APPROVAL_INVALID_TRANSITION,
      message: `No transition for ${request.documentType}/${request.currentState} --${request.action}-->`,
    };
  }

  if (!isRoleAuthorized(rule.roles, request.actorRole)) {
    return {
      ok: false,
      code: ERR_APPROVAL_STEP_ROLE,
      message: `Role ${request.actorRole} may not perform ${request.action} on ${request.documentType}/${request.currentState}`,
    };
  }

  if (request.offlineAttempt && !rule.offlineEligible) {
    return {
      ok: false,
      code: ERR_OFFLINE_NOT_ELIGIBLE,
      message: `${request.documentType}.${request.action} is not offline-eligible (SYNC-PROTOCOL §7.6)`,
    };
  }

  const reasonNeeded =
    rule.reasonRequired === true ||
    (rule.reasonRequired === 'on_amend' && Boolean(request.isAmendment));
  if (reasonNeeded && !request.reasonProvided) {
    return {
      ok: false,
      code: ERR_REASON_REQUIRED,
      message: 'A reason is required for this transition',
    };
  }

  return {
    ok: true,
    nextState: rule.to,
    reasonRequired: reasonNeeded,
    offlineEligible: rule.offlineEligible,
  };
}

/** Every distinct state reachable as a `to` for a given (documentType, variant) — used by the "no unreachable states" property test. */
export function reachableStates(
  documentType: TransitionDocumentType,
  variant?: TransitionVariant,
): Set<string> {
  const states = new Set<string>();
  for (const r of APPROVAL_TRANSITIONS) {
    if (r.documentType !== documentType) continue;
    if (r.variant !== undefined && variant !== undefined && r.variant !== variant) continue;
    states.add(r.to);
  }
  return states;
}
