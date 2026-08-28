import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import {
  ApprovalDocumentType,
  isRoleAuthorized,
  LocationType,
  ReturnDirection,
  RoleKey,
} from '@mimi/shared';
import {
  resolveDocumentContext,
  resolveDocumentContextsBatch,
  resolveEligibleRoles,
} from './document-context.resolver';
import type { DocumentContext } from './types';

const ALL_ROLES = Object.values(RoleKey);

function makeClient(handlers: Record<string, unknown[]>) {
  return {
    query: vi.fn(async (sql: string) => {
      for (const [needle, rows] of Object.entries(handlers)) {
        if (sql.includes(needle)) return { rows };
      }
      return { rows: [] };
    }),
  };
}

describe('resolveDocumentContext', () => {
  it('resolves stock_opname at an outlet to variant "outlet"', async () => {
    const client = makeClient({ 'FROM stock_opname': [{ location_type: LocationType.OUTLET }] });
    const ctx = await resolveDocumentContext(
      client as never,
      ApprovalDocumentType.STOCK_OPNAME,
      'doc-1',
    );
    expect(ctx.variant).toBe('outlet');
  });

  it('resolves stock_opname at a warehouse to variant "warehouse"', async () => {
    const client = makeClient({ 'FROM stock_opname': [{ location_type: LocationType.WAREHOUSE }] });
    const ctx = await resolveDocumentContext(
      client as never,
      ApprovalDocumentType.STOCK_OPNAME,
      'doc-1',
    );
    expect(ctx.variant).toBe('warehouse');
  });

  it('resolves waste at a warehouse to variant "warehouse"', async () => {
    const client = makeClient({
      'FROM waste_records': [{ location_type: LocationType.WAREHOUSE }],
    });
    const ctx = await resolveDocumentContext(client as never, ApprovalDocumentType.WASTE, 'doc-1');
    expect(ctx.variant).toBe('warehouse');
  });

  it('resolves return direction verbatim from the returns table', async () => {
    const client = makeClient({
      'FROM returns': [{ direction: ReturnDirection.WAREHOUSE_TO_SUPPLIER }],
    });
    const ctx = await resolveDocumentContext(client as never, ApprovalDocumentType.RETURN, 'doc-1');
    expect(ctx.variant).toBe(ReturnDirection.WAREHOUSE_TO_SUPPLIER);
  });

  it('returns an empty context (no query) for document types with no irregular chain', async () => {
    const client = makeClient({});
    const ctx = await resolveDocumentContext(
      client as never,
      ApprovalDocumentType.PURCHASE_ORDER,
      'doc-1',
    );
    expect(ctx).toEqual({});
    expect(client.query).not.toHaveBeenCalled();
  });

  it('resolves to an undefined variant when the joined row is missing (document not found)', async () => {
    const client = makeClient({});
    const ctx = await resolveDocumentContext(
      client as never,
      ApprovalDocumentType.STOCK_OPNAME,
      'ghost',
    );
    expect(ctx.variant).toBeUndefined();
  });
});

describe('resolveDocumentContextsBatch', () => {
  it('batches stock_opname location types for many ids in one query', async () => {
    const client = makeClient({
      'FROM stock_opname': [
        { id: 'a', location_type: LocationType.OUTLET },
        { id: 'b', location_type: LocationType.WAREHOUSE },
      ],
    });
    const result = await resolveDocumentContextsBatch(
      client as never,
      ApprovalDocumentType.STOCK_OPNAME,
      ['a', 'b'],
    );
    expect(result.get('a')).toEqual({ variant: 'outlet' });
    expect(result.get('b')).toEqual({ variant: 'warehouse' });
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('returns an empty map without querying when there are no ids', async () => {
    const client = makeClient({});
    const result = await resolveDocumentContextsBatch(
      client as never,
      ApprovalDocumentType.STOCK_OPNAME,
      [],
    );
    expect(result.size).toBe(0);
    expect(client.query).not.toHaveBeenCalled();
  });

  it('maps every id to {} for regular document types without querying', async () => {
    const client = makeClient({});
    const result = await resolveDocumentContextsBatch(
      client as never,
      ApprovalDocumentType.PAYROLL_RUN,
      ['x', 'y'],
    );
    expect(result.get('x')).toEqual({});
    expect(result.get('y')).toEqual({});
    expect(client.query).not.toHaveBeenCalled();
  });
});

describe('resolveEligibleRoles — carried-forward item 2', () => {
  it('stock_opname step 1 narrows to Supervisor at an outlet', () => {
    const roles = resolveEligibleRoles(ApprovalDocumentType.STOCK_OPNAME, 1, RoleKey.SUPERVISOR, {
      variant: 'outlet',
    });
    expect(roles).toEqual([RoleKey.SUPERVISOR]);
  });

  it('stock_opname step 1 narrows to Kepala Gudang at a warehouse — the seeded row is only "supervisor"', () => {
    const roles = resolveEligibleRoles(ApprovalDocumentType.STOCK_OPNAME, 1, RoleKey.SUPERVISOR, {
      variant: 'warehouse',
    });
    expect(roles).toEqual([RoleKey.KEPALA_GUDANG]);
  });

  it('stock_opname step 2 (manager threshold) is unaffected by the override — passthrough', () => {
    const roles = resolveEligibleRoles(ApprovalDocumentType.STOCK_OPNAME, 2, RoleKey.MANAGER, {
      variant: 'warehouse',
    });
    expect(roles).toEqual([RoleKey.MANAGER]);
  });

  it('waste step 1 narrows by location type identically to opname', () => {
    expect(
      resolveEligibleRoles(ApprovalDocumentType.WASTE, 1, RoleKey.SUPERVISOR, {
        variant: 'outlet',
      }),
    ).toEqual([RoleKey.SUPERVISOR]);
    expect(
      resolveEligibleRoles(ApprovalDocumentType.WASTE, 1, RoleKey.SUPERVISOR, {
        variant: 'warehouse',
      }),
    ).toEqual([RoleKey.KEPALA_GUDANG]);
  });

  it('return step 1 narrows by direction — outlet_to_warehouse leg goes to Supervisor', () => {
    const roles = resolveEligibleRoles(ApprovalDocumentType.RETURN, 1, RoleKey.SUPERVISOR, {
      variant: ReturnDirection.OUTLET_TO_WAREHOUSE,
    });
    expect(roles).toEqual([RoleKey.SUPERVISOR]);
  });

  it('return step 1 narrows by direction — warehouse_to_supplier leg goes to Kepala Gudang', () => {
    const roles = resolveEligibleRoles(ApprovalDocumentType.RETURN, 1, RoleKey.SUPERVISOR, {
      variant: ReturnDirection.WAREHOUSE_TO_SUPPLIER,
    });
    expect(roles).toEqual([RoleKey.KEPALA_GUDANG]);
  });

  it('leave_request step 1 broadens to the any-of set regardless of context', () => {
    const roles = resolveEligibleRoles(
      ApprovalDocumentType.LEAVE_REQUEST,
      1,
      RoleKey.SUPERVISOR,
      {},
    );
    expect(roles).toEqual([RoleKey.SUPERVISOR, RoleKey.HR_ADMIN]);
  });

  it('every other document type is an untouched passthrough of the seeded role', () => {
    for (const dt of [
      ApprovalDocumentType.REPLENISHMENT_REQUEST,
      ApprovalDocumentType.VOID_REFUND,
      ApprovalDocumentType.PURCHASE_REQUEST,
      ApprovalDocumentType.PURCHASE_ORDER,
      ApprovalDocumentType.PAYROLL_RUN,
      ApprovalDocumentType.PAYMENT_VERIFICATION,
      ApprovalDocumentType.EMPLOYEE_LOAN,
      ApprovalDocumentType.CASH_VARIANCE_PROPOSAL,
    ]) {
      expect(resolveEligibleRoles(dt, 1, RoleKey.FINANCE, {})).toEqual([RoleKey.FINANCE]);
    }
  });
});

// The rank-override authorization rule itself (`isRoleAuthorized`) is
// `@mimi/shared`'s single source of truth (state-machine.ts), with its own
// test suite there, including a property test asserting agreement with
// `transition()`. This agent no longer keeps a duplicate implementation or a
// duplicate unit-test suite for that rule — only the property test below,
// which exercises THIS module's actual contribution: does
// `resolveEligibleRoles`'s output, fed through the shared
// `isRoleAuthorized`, land on the role set CONTRACTS.md §5 actually specifies
// for the 4 runtime-resolved chains.

/**
 * Property test (BUILD-PLAN W2-B "TESTING" §): "no transition escapes the
 * role matrix" — for the 4 runtime-resolved chains specifically (the ones
 * this agent had to solve), every one of the 9 roles is checked against
 * every context this resolver produces. The expected-eligible set below is
 * transcribed independently from CONTRACTS.md §5.4/§5.5/§5.6/§5.10 (not
 * derived from the resolver under test) so this test can actually catch a
 * regression in `ROLE_OVERRIDES`, not just echo it back.
 */
describe('property: no runtime-resolved role escapes the expected set', () => {
  const scenarios: Array<{
    label: string;
    documentType: ApprovalDocumentType;
    context: DocumentContext;
    expectedEligible: readonly RoleKey[];
  }> = [
    {
      label: 'opname @ outlet',
      documentType: ApprovalDocumentType.STOCK_OPNAME,
      context: { variant: 'outlet' },
      expectedEligible: [RoleKey.SUPERVISOR],
    },
    {
      label: 'opname @ warehouse',
      documentType: ApprovalDocumentType.STOCK_OPNAME,
      context: { variant: 'warehouse' },
      expectedEligible: [RoleKey.KEPALA_GUDANG],
    },
    {
      label: 'waste @ outlet',
      documentType: ApprovalDocumentType.WASTE,
      context: { variant: 'outlet' },
      expectedEligible: [RoleKey.SUPERVISOR],
    },
    {
      label: 'waste @ warehouse',
      documentType: ApprovalDocumentType.WASTE,
      context: { variant: 'warehouse' },
      expectedEligible: [RoleKey.KEPALA_GUDANG],
    },
    {
      label: 'return outlet_to_warehouse',
      documentType: ApprovalDocumentType.RETURN,
      context: { variant: ReturnDirection.OUTLET_TO_WAREHOUSE },
      expectedEligible: [RoleKey.SUPERVISOR],
    },
    {
      label: 'return warehouse_to_supplier',
      documentType: ApprovalDocumentType.RETURN,
      context: { variant: ReturnDirection.WAREHOUSE_TO_SUPPLIER },
      expectedEligible: [RoleKey.KEPALA_GUDANG],
    },
    {
      label: 'leave_request (any-of)',
      documentType: ApprovalDocumentType.LEAVE_REQUEST,
      context: {},
      expectedEligible: [RoleKey.SUPERVISOR, RoleKey.HR_ADMIN],
    },
  ];

  for (const scenario of scenarios) {
    it(`${scenario.label}: every role's eligibility matches the CONTRACTS-transcribed expectation, for any stored seed role`, () => {
      // Owner/Manager outrank every expected role in all 4 scenarios (Supervisor 40, Kepala Gudang 50, HR Admin 50 —
      // all below Manager's 90), so the role-rank override (§5 preamble) always qualifies them too.
      const expectedWithOverride = new Set<RoleKey>([
        ...scenario.expectedEligible,
        RoleKey.OWNER,
        RoleKey.MANAGER,
      ]);

      fc.assert(
        fc.property(
          fc.constantFrom(...ALL_ROLES),
          fc.constantFrom(...ALL_ROLES),
          (actorRole, seededRole) => {
            const eligible = resolveEligibleRoles(
              scenario.documentType,
              1,
              seededRole,
              scenario.context,
            );
            const satisfies = isRoleAuthorized(eligible, actorRole);
            expect(satisfies).toBe(expectedWithOverride.has(actorRole));
          },
        ),
        { numRuns: 200 },
      );
    });
  }
});
