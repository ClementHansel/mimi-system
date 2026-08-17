import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { RoleKey } from '../enums';
import { APPROVAL_TRANSITIONS, transition, isRoleAuthorized, SYSTEM_ACTOR, type Actor } from './state-machine';

const ALL_ACTORS: readonly Actor[] = [...Object.values(RoleKey), SYSTEM_ACTOR];

describe('property: no unreachable states (per document type + variant)', () => {
  it('every state used as `from` is reachable as some rule\'s `to` within the same (documentType, variant) chain, or is an entry pseudo-state', () => {
    const byChain = new Map<string, typeof APPROVAL_TRANSITIONS>();
    for (const rule of APPROVAL_TRANSITIONS) {
      const chainKey = `${rule.documentType}::${rule.variant ?? ''}`;
      const list = byChain.get(chainKey) ?? [];
      list.push(rule);
      byChain.set(chainKey, list);
    }

    for (const [chainKey, rules] of byChain) {
      // Also fold in variant-agnostic rules of the same documentType (e.g. waste's shared reject).
      const documentType = chainKey.split('::')[0];
      const allRelevant = APPROVAL_TRANSITIONS.filter((r) => r.documentType === documentType);
      const reachableTargets = new Set(allRelevant.map((r) => r.to));
      // 'pending' is also a valid entry state for the minor chains (leave, loan, cash-variance's
      // human decisions): the document is created 'pending' directly by its owning module — only
      // the DECISION half of its lifecycle runs through this approval engine (§5.9/§5.10).
      const entryStates = new Set(['(none)', 'draft', 'counting', 'pending']);

      for (const rule of rules) {
        if (entryStates.has(rule.from)) continue; // entry pseudo-states need no predecessor
        const hasPredecessor = reachableTargets.has(rule.from);
        expect(
          hasPredecessor,
          `${chainKey}: state "${rule.from}" (used by action "${rule.action}") is never produced as a \`to\` by any rule of the same document type`,
        ).toBe(true);
      }
    }
  });

  it('every `to` state (except terminal-looking ones) is either terminal or has at least one outgoing rule', () => {
    const terminalStates = new Set([
      'completed',
      'rejected',
      'cancelled',
      'closed',
      'paid',
      'active',
      'adjusted',
      'approved', // some chains end here (e.g. purchase_request.approved -> convert exists, but leave/loan end at approved/active)
      'converted', // purchase_request's terminal state once it becomes a purchase_order
      '(deleted)',
    ]);
    for (const rule of APPROVAL_TRANSITIONS) {
      if (terminalStates.has(rule.to)) continue;
      const hasOutgoing = APPROVAL_TRANSITIONS.some(
        (r) => r.documentType === rule.documentType && r.from === rule.to,
      );
      expect(hasOutgoing, `${rule.documentType}: state "${rule.to}" has no outgoing transition and is not marked terminal`).toBe(true);
    }
  });
});

describe('property: transition() never grants an action to a role outside the rule\'s authorized set', () => {
  it('ok:true only when the actor is explicitly listed OR a rank-eligible OWNER/MANAGER override applies', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...APPROVAL_TRANSITIONS),
        fc.constantFrom(...ALL_ACTORS),
        fc.boolean(),
        fc.boolean(),
        (rule, actor, reasonProvided, isAmendment) => {
          const result = transition({
            documentType: rule.documentType,
            variant: rule.variant,
            currentState: rule.from,
            action: rule.action,
            actorRole: actor,
            reasonProvided,
            isAmendment,
          });

          if (result.ok) {
            const explicitlyListed = rule.roles.includes(actor);
            const isOverride =
              !explicitlyListed &&
              actor !== SYSTEM_ACTOR &&
              (actor === RoleKey.OWNER || actor === RoleKey.MANAGER) &&
              rule.roles.some((r) => r !== SYSTEM_ACTOR); // a system-only rule has no human override
            expect(explicitlyListed || isOverride).toBe(true);
          } else {
            // A rejection must never be because of a role NOT in the matrix at all — every actor is a real role or 'system'.
            expect(ALL_ACTORS).toContain(actor);
          }
        },
      ),
    );
  });

  it('a role never listed for a rule, and ranked below every listed role, is always denied', () => {
    fc.assert(
      fc.property(fc.constantFrom(...APPROVAL_TRANSITIONS), (rule) => {
        // KASIR and DRIVER are the lowest-ranked roles; if neither is listed nor a system-only rule, they must be denied.
        for (const lowActor of [RoleKey.KASIR, RoleKey.DRIVER] as const) {
          if (rule.roles.includes(lowActor)) continue;
          const result = transition({
            documentType: rule.documentType,
            variant: rule.variant,
            currentState: rule.from,
            action: rule.action,
            actorRole: lowActor,
            reasonProvided: true,
            isAmendment: true,
          });
          expect(result.ok).toBe(false);
        }
      }),
    );
  });
});

describe('property: the exported isRoleAuthorized() can never disagree with transition()\'s internal role check', () => {
  it('for every rule and every actor, isRoleAuthorized(rule.roles, actor) predicts exactly whether transition() rejects with ERR_APPROVAL_STEP_ROLE', () => {
    // This is the guarantee the coordinator asked to pin down: W2-B's approval
    // engine now calls the SAME exported function transition() uses internally
    // (there is textually one implementation), so this property is really
    // "isRoleAuthorized agrees with itself" — but it is written against the
    // public API (transition()) rather than reaching into the module's
    // internals, so it would also catch a future refactor that accidentally
    // forked the two call sites back apart.
    fc.assert(
      fc.property(fc.constantFrom(...APPROVAL_TRANSITIONS), fc.constantFrom(...ALL_ACTORS), (rule, actor) => {
        const authorized = isRoleAuthorized(rule.roles, actor);
        // reasonProvided/isAmendment are set so the ONLY possible rejection
        // reason left, if any, is the role check itself (never ERR_REASON_REQUIRED),
        // and offlineAttempt is left false so ERR_OFFLINE_NOT_ELIGIBLE can't fire either.
        const result = transition({
          documentType: rule.documentType,
          variant: rule.variant,
          currentState: rule.from,
          action: rule.action,
          actorRole: actor,
          reasonProvided: true,
          isAmendment: true,
        });

        if (!authorized) {
          expect(result).toMatchObject({ ok: false, code: 'ERR_APPROVAL_STEP_ROLE' });
        } else {
          expect(result.ok).toBe(true);
        }
      }),
    );
  });
});
