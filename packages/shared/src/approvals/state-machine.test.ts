import { describe, it, expect } from 'vitest';
import { ApprovalDocumentType, ReturnDirection, RoleKey } from '../enums';
import {
  transition,
  findApplicableRule,
  isActorEligibleForAction,
  eligibleActorsForAction,
  isRoleAuthorized,
  NONE_STATE,
  SYSTEM_ACTOR,
  APPROVAL_TRANSITIONS,
} from './state-machine';

describe('replenishment request (§5.1)', () => {
  it('walks the full happy path', () => {
    const submit = transition({
      documentType: ApprovalDocumentType.REPLENISHMENT_REQUEST,
      currentState: NONE_STATE,
      action: 'submit',
      actorRole: RoleKey.LEADER_OUTLET,
    });
    expect(submit).toMatchObject({ ok: true, nextState: 'submitted' });

    const spvApprove = transition({
      documentType: ApprovalDocumentType.REPLENISHMENT_REQUEST,
      currentState: 'submitted',
      action: 'approve',
      actorRole: RoleKey.SUPERVISOR,
      offlineAttempt: true,
    });
    expect(spvApprove).toMatchObject({ ok: true, nextState: 'awaiting_approval', offlineEligible: true });

    const kgdApprove = transition({
      documentType: ApprovalDocumentType.REPLENISHMENT_REQUEST,
      currentState: 'awaiting_approval',
      action: 'approve',
      actorRole: RoleKey.KEPALA_GUDANG,
    });
    expect(kgdApprove).toMatchObject({ ok: true, nextState: 'approved' });
  });

  it('requires a reason only when amending the approved quantity', () => {
    const noAmend = transition({
      documentType: ApprovalDocumentType.REPLENISHMENT_REQUEST,
      currentState: 'submitted',
      action: 'approve',
      actorRole: RoleKey.SUPERVISOR,
    });
    expect(noAmend).toMatchObject({ ok: true, reasonRequired: false });

    const amendNoReason = transition({
      documentType: ApprovalDocumentType.REPLENISHMENT_REQUEST,
      currentState: 'submitted',
      action: 'approve',
      actorRole: RoleKey.SUPERVISOR,
      isAmendment: true,
    });
    expect(amendNoReason).toMatchObject({ ok: false, code: 'ERR_REASON_REQUIRED' });

    const amendWithReason = transition({
      documentType: ApprovalDocumentType.REPLENISHMENT_REQUEST,
      currentState: 'submitted',
      action: 'approve',
      actorRole: RoleKey.SUPERVISOR,
      isAmendment: true,
      reasonProvided: true,
    });
    expect(amendWithReason).toMatchObject({ ok: true });
  });

  it('rejects a kasir attempting a supervisor-only step', () => {
    const result = transition({
      documentType: ApprovalDocumentType.REPLENISHMENT_REQUEST,
      currentState: 'submitted',
      action: 'approve',
      actorRole: RoleKey.KASIR,
    });
    expect(result).toMatchObject({ ok: false, code: 'ERR_APPROVAL_STEP_ROLE' });
  });

  it('warehouse approval step is never offline-eligible', () => {
    const result = transition({
      documentType: ApprovalDocumentType.REPLENISHMENT_REQUEST,
      currentState: 'awaiting_approval',
      action: 'approve',
      actorRole: RoleKey.KEPALA_GUDANG,
      offlineAttempt: true,
    });
    expect(result).toMatchObject({ ok: false, code: 'ERR_OFFLINE_NOT_ELIGIBLE' });
  });

  it('rejects reject without a reason', () => {
    const result = transition({
      documentType: ApprovalDocumentType.REPLENISHMENT_REQUEST,
      currentState: 'submitted',
      action: 'reject',
      actorRole: RoleKey.SUPERVISOR,
    });
    expect(result).toMatchObject({ ok: false, code: 'ERR_REASON_REQUIRED' });
  });

  it('an unknown transition is rejected as invalid, not a role failure', () => {
    const result = transition({
      documentType: ApprovalDocumentType.REPLENISHMENT_REQUEST,
      currentState: 'completed',
      action: 'approve',
      actorRole: RoleKey.OWNER,
    });
    expect(result).toMatchObject({ ok: false, code: 'ERR_APPROVAL_INVALID_TRANSITION' });
  });
});

describe('role-rank override (MGR/OWN act on any step at or below their level)', () => {
  it('owner can approve a supervisor-gated replenishment step', () => {
    const result = transition({
      documentType: ApprovalDocumentType.REPLENISHMENT_REQUEST,
      currentState: 'submitted',
      action: 'approve',
      actorRole: RoleKey.OWNER,
    });
    expect(result).toMatchObject({ ok: true });
  });

  it('manager can approve a finance-gated payment verification', () => {
    const result = transition({
      documentType: ApprovalDocumentType.PAYMENT_VERIFICATION,
      currentState: 'pending',
      action: 'verify',
      actorRole: RoleKey.MANAGER,
    });
    expect(result).toMatchObject({ ok: true });
  });

  it('a kepala gudang cannot use rank override to approve a payment (their rank does not exceed finance)', () => {
    const result = transition({
      documentType: ApprovalDocumentType.PAYMENT_VERIFICATION,
      currentState: 'pending',
      action: 'verify',
      actorRole: RoleKey.KEPALA_GUDANG,
    });
    expect(result).toMatchObject({ ok: false, code: 'ERR_APPROVAL_STEP_ROLE' });
  });

  it('no human role can perform a system-only auto-transition', () => {
    const result = transition({
      documentType: ApprovalDocumentType.CASH_VARIANCE_PROPOSAL,
      currentState: NONE_STATE,
      action: 'auto_create',
      actorRole: RoleKey.OWNER,
    });
    expect(result).toMatchObject({ ok: false, code: 'ERR_APPROVAL_STEP_ROLE' });

    const systemResult = transition({
      documentType: ApprovalDocumentType.CASH_VARIANCE_PROPOSAL,
      currentState: NONE_STATE,
      action: 'auto_create',
      actorRole: SYSTEM_ACTOR,
    });
    expect(systemResult).toMatchObject({ ok: true, nextState: 'pending' });
  });
});

describe('void / refund (§5.2, D-17 offline-eligible)', () => {
  it('supervisor approval is offline-eligible; reject is not', () => {
    expect(
      transition({
        documentType: ApprovalDocumentType.VOID_REFUND,
        currentState: 'pending',
        action: 'approve',
        actorRole: RoleKey.SUPERVISOR,
        offlineAttempt: true,
      }),
    ).toMatchObject({ ok: true, offlineEligible: true });

    expect(
      transition({
        documentType: ApprovalDocumentType.VOID_REFUND,
        currentState: 'pending',
        action: 'reject',
        actorRole: RoleKey.SUPERVISOR,
        offlineAttempt: true,
        reasonProvided: true,
      }),
    ).toMatchObject({ ok: false, code: 'ERR_OFFLINE_NOT_ELIGIBLE' });
  });
});

describe('cash variance proposal (§5.9, D-19 — reason required on approve AND reject, never offline)', () => {
  it('approve without a reason is rejected', () => {
    expect(
      transition({
        documentType: ApprovalDocumentType.CASH_VARIANCE_PROPOSAL,
        currentState: 'pending',
        action: 'approve',
        actorRole: RoleKey.SUPERVISOR,
      }),
    ).toMatchObject({ ok: false, code: 'ERR_REASON_REQUIRED' });
  });

  it('approve with a reason succeeds', () => {
    expect(
      transition({
        documentType: ApprovalDocumentType.CASH_VARIANCE_PROPOSAL,
        currentState: 'pending',
        action: 'approve',
        actorRole: RoleKey.SUPERVISOR,
        reasonProvided: true,
      }),
    ).toMatchObject({ ok: true, nextState: 'approved' });
  });

  it('is never offline-eligible, even for the supervisor step', () => {
    expect(
      transition({
        documentType: ApprovalDocumentType.CASH_VARIANCE_PROPOSAL,
        currentState: 'pending',
        action: 'approve',
        actorRole: RoleKey.SUPERVISOR,
        reasonProvided: true,
        offlineAttempt: true,
      }),
    ).toMatchObject({ ok: false, code: 'ERR_OFFLINE_NOT_ELIGIBLE' });
  });
});

describe('waste (§5.10) — variant-gated offline eligibility', () => {
  it('outlet step is offline-eligible; warehouse step is not', () => {
    expect(
      transition({
        documentType: ApprovalDocumentType.WASTE,
        variant: 'outlet',
        currentState: 'pending',
        action: 'approve',
        actorRole: RoleKey.SUPERVISOR,
        offlineAttempt: true,
      }),
    ).toMatchObject({ ok: true, offlineEligible: true });

    expect(
      transition({
        documentType: ApprovalDocumentType.WASTE,
        variant: 'warehouse',
        currentState: 'pending',
        action: 'approve',
        actorRole: RoleKey.KEPALA_GUDANG,
        offlineAttempt: true,
      }),
    ).toMatchObject({ ok: false, code: 'ERR_OFFLINE_NOT_ELIGIBLE' });
  });

  it('the shared reject rule applies regardless of variant', () => {
    expect(
      transition({
        documentType: ApprovalDocumentType.WASTE,
        variant: 'outlet',
        currentState: 'pending',
        action: 'reject',
        actorRole: RoleKey.SUPERVISOR,
        reasonProvided: true,
      }),
    ).toMatchObject({ ok: true, nextState: 'rejected' });
  });
});

describe('return (§5.5/§5.6) — direction-gated chains', () => {
  it('outlet→gudang leg lets the outlet supervisor ship', () => {
    expect(
      transition({
        documentType: ApprovalDocumentType.RETURN,
        variant: ReturnDirection.OUTLET_TO_WAREHOUSE,
        currentState: 'approved',
        action: 'ship',
        actorRole: RoleKey.SUPERVISOR,
      }),
    ).toMatchObject({ ok: true, nextState: 'in_transit' });
  });

  it('gudang→supplier leg does not accept the outlet supervisor', () => {
    expect(
      transition({
        documentType: ApprovalDocumentType.RETURN,
        variant: ReturnDirection.WAREHOUSE_TO_SUPPLIER,
        currentState: 'draft',
        action: 'submit',
        actorRole: RoleKey.SUPERVISOR,
      }),
    ).toMatchObject({ ok: false, code: 'ERR_APPROVAL_STEP_ROLE' });
  });
});

describe('no transition escapes the RBAC role matrix', () => {
  it('every rule role list contains only real roles or the system actor', () => {
    for (const rule of APPROVAL_TRANSITIONS) {
      for (const role of rule.roles) {
        expect(role === 'system' || Object.values(RoleKey).includes(role as RoleKey)).toBe(true);
      }
    }
  });
});

describe('findApplicableRule / isActorEligibleForAction / eligibleActorsForAction — the pre-filter surface', () => {
  it('findApplicableRule returns the exact rule transition() would use, without requiring reason/offline context', () => {
    const rule = findApplicableRule({
      documentType: ApprovalDocumentType.REPLENISHMENT_REQUEST,
      currentState: 'submitted',
      action: 'approve',
    });
    expect(rule).toMatchObject({ to: 'awaiting_approval', roles: [RoleKey.SUPERVISOR], offlineEligible: true });
  });

  it('findApplicableRule returns undefined for a nonexistent transition', () => {
    expect(findApplicableRule({ documentType: ApprovalDocumentType.REPLENISHMENT_REQUEST, currentState: 'completed', action: 'approve' })).toBeUndefined();
  });

  it('findApplicableRule prefers the variant-specific rule over a variant-agnostic one sharing the same lookup', () => {
    const outlet = findApplicableRule({ documentType: ApprovalDocumentType.WASTE, variant: 'outlet', currentState: 'pending', action: 'approve' });
    const warehouse = findApplicableRule({ documentType: ApprovalDocumentType.WASTE, variant: 'warehouse', currentState: 'pending', action: 'approve' });
    expect(outlet?.roles).toEqual([RoleKey.SUPERVISOR]);
    expect(warehouse?.roles).toEqual([RoleKey.KEPALA_GUDANG]);
  });

  it('isActorEligibleForAction is a pure yes/no pre-check matching isRoleAuthorized against the resolved rule', () => {
    const lookup = { documentType: ApprovalDocumentType.REPLENISHMENT_REQUEST, currentState: 'submitted', action: 'approve' } as const;
    expect(isActorEligibleForAction({ ...lookup, actorRole: RoleKey.SUPERVISOR })).toBe(true);
    expect(isActorEligibleForAction({ ...lookup, actorRole: RoleKey.KASIR })).toBe(false);
    // Rank override applies here too: OWNER isn't listed but outranks SUPERVISOR.
    expect(isActorEligibleForAction({ ...lookup, actorRole: RoleKey.OWNER })).toBe(true);
  });

  it('isActorEligibleForAction is false for a nonexistent transition regardless of role', () => {
    expect(
      isActorEligibleForAction({ documentType: ApprovalDocumentType.REPLENISHMENT_REQUEST, currentState: 'completed', action: 'approve', actorRole: RoleKey.OWNER }),
    ).toBe(false);
  });

  it('eligibleActorsForAction returns the explicit role plus every rank-qualified override, and nothing else', () => {
    const actors = eligibleActorsForAction({ documentType: ApprovalDocumentType.REPLENISHMENT_REQUEST, currentState: 'submitted', action: 'approve' });
    expect(actors).toContain(RoleKey.SUPERVISOR); // explicitly listed
    expect(actors).toContain(RoleKey.MANAGER); // rank override
    expect(actors).toContain(RoleKey.OWNER); // rank override
    expect(actors).not.toContain(RoleKey.KASIR);
    expect(actors).not.toContain(RoleKey.KEPALA_GUDANG); // same-ish rank as supervisor's step, not listed, no override rule for KGD
    expect(actors).not.toContain(SYSTEM_ACTOR);
  });

  it('eligibleActorsForAction returns exactly [system] for a system-only transition', () => {
    const actors = eligibleActorsForAction({ documentType: ApprovalDocumentType.CASH_VARIANCE_PROPOSAL, currentState: NONE_STATE, action: 'auto_create' });
    expect(actors).toEqual([SYSTEM_ACTOR]);
  });

  it('eligibleActorsForAction returns [] for a nonexistent transition', () => {
    expect(eligibleActorsForAction({ documentType: ApprovalDocumentType.REPLENISHMENT_REQUEST, currentState: 'completed', action: 'approve' })).toEqual([]);
  });

  it('eligibleActorsForAction agrees with isRoleAuthorized for every actor, for every real rule', () => {
    for (const rule of APPROVAL_TRANSITIONS) {
      const actors = eligibleActorsForAction({ documentType: rule.documentType, variant: rule.variant, currentState: rule.from, action: rule.action });
      for (const actor of [...Object.values(RoleKey), SYSTEM_ACTOR]) {
        expect(actors.includes(actor)).toBe(isRoleAuthorized(rule.roles, actor));
      }
    }
  });
});
