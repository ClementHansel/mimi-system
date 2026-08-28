/**
 * Employment contracts against the LIVE database (W7, migration 230).
 *
 * Three things here can only be proven against real Postgres, and each has a
 * way of being quietly wrong:
 *
 *  1. RLS self-scoping. A Kasir must see THEIR contract and nobody else's. A
 *     service-level `WHERE user_id = ...` would pass a mocked test and still be
 *     one forgotten clause away from leaking every salary in the company.
 *  2. The type↔term rule. `pkwtt` (permanent) must have no end date, every
 *     fixed-term type must have one. The service validates it AND a CHECK
 *     enforces it; a test that only exercised the service would not notice the
 *     constraint being dropped.
 *  3. The expiry window. `expiringWithinDays` is date arithmetic in WITA
 *     against `NOW()` — the kind of query that looks right and is off by a
 *     timezone.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RoleKey } from '@mimi/shared';

vi.setConfig({ testTimeout: 20_000 });

import { ContractsService } from './contracts.service';
import {
  closePool,
  loadHrFixtures,
  withRollbackAs,
  type HrFixtures,
} from '../test-support/live-db';
import { Pool } from 'pg';

const ownerPool = new Pool({
  connectionString:
    process.env.DATABASE_MIGRATION_URL ??
    `postgres://${process.env.POSTGRES_USER ?? 'mimi'}:${process.env.POSTGRES_PASSWORD ?? 'mimi_secret'}@localhost:${process.env.POSTGRES_PORT ?? '55433'}/${process.env.POSTGRES_DB ?? 'mimi'}`,
});

describe('Employment contracts (integration, live Postgres)', () => {
  let fixtures: HrFixtures;
  let service: ContractsService;
  const createdIds: string[] = [];

  beforeAll(async () => {
    fixtures = await loadHrFixtures();
    service = new ContractsService();
  });

  afterAll(async () => {
    // Mutating methods self-commit (`db-tx.ts`), so cleanup goes through the
    // owner pool — a rollback would be a no-op on an already-committed row.
    for (const id of createdIds)
      await ownerPool.query('DELETE FROM employment_contracts WHERE id = $1', [id]);
    await ownerPool.end();
    await closePool();
  });

  /** The employee behind a seeded role, for "is this MY contract" assertions. */
  async function employeeFor(role: RoleKey): Promise<{ userId: string; employeeId: string }> {
    const entry = fixtures.usersByRole[role];
    if (!entry?.employeeId) throw new Error(`seed has no employee for role ${role}`);
    return { userId: entry.userId, employeeId: entry.employeeId };
  }

  it('a Kasir reading /hr/contracts/me sees their own contract and nobody else’s', async () => {
    const kasir = await employeeFor(RoleKey.KASIR);
    const session = {
      userId: kasir.userId,
      roleKey: RoleKey.KASIR,
      locationIds: [fixtures.usersByRole[RoleKey.KASIR]!.locationId],
    };

    const own = await withRollbackAs(session, (client) => service.listOwn(client, kasir.userId));
    // The seed gives every employee exactly one contract, so this is a real
    // assertion rather than a vacuous pass on an empty list.
    expect(own.length).toBeGreaterThan(0);
    for (const c of own) expect(c.employeeId).toBe(kasir.employeeId);

    // And RLS, not the service, is what enforces it: a raw SELECT through the
    // same session must see nothing else either.
    await withRollbackAs(session, async (client) => {
      const all = await client.query<{ employee_id: string }>(
        'SELECT employee_id FROM employment_contracts',
      );
      expect(all.rows.length).toBeGreaterThan(0);
      for (const row of all.rows) expect(row.employee_id).toBe(kasir.employeeId);
    });
  });

  it('rejects a permanent contract with an end date, and a fixed-term one without', async () => {
    const hrAdmin = fixtures.usersByRole[RoleKey.HR_ADMIN] ?? fixtures.usersByRole[RoleKey.OWNER]!;
    const kasir = await employeeFor(RoleKey.KASIR);
    const session = { userId: hrAdmin.userId, roleKey: RoleKey.HR_ADMIN, locationIds: [] };

    await expect(
      withRollbackAs(session, (client) =>
        service.create(client, hrAdmin.userId, {
          employeeId: kasir.employeeId,
          contractType: 'pkwtt',
          position: 'Kasir',
          startDate: '2026-01-01',
          endDate: '2027-01-01', // a permanent contract cannot expire
        }),
      ),
    ).rejects.toMatchObject({ response: { code: 'ERR_VALIDATION' } });

    await expect(
      withRollbackAs(session, (client) =>
        service.create(client, hrAdmin.userId, {
          employeeId: kasir.employeeId,
          contractType: 'pkwt',
          position: 'Kasir',
          startDate: '2026-01-01',
          // ...and a fixed term must say when it ends
        }),
      ),
    ).rejects.toMatchObject({ response: { code: 'ERR_VALIDATION' } });
  });

  it('the CHECK constraint refuses a mismatched term even if the service is bypassed', async () => {
    // Defence in depth: the service validation above is a good error message,
    // this is the guarantee. A future code path that inserts directly still
    // cannot create a row that makes the expiry report lie.
    await expect(
      ownerPool.query(
        `INSERT INTO employment_contracts
           (contract_number, employee_id, contract_type, position, start_date, end_date)
         VALUES ($1, $2, 'pkwtt', 'Kasir', '2026-01-01', '2027-01-01')`,
        [`KONTRAK/TEST/${Date.now()}`, (await employeeFor(RoleKey.KASIR)).employeeId],
      ),
    ).rejects.toThrow(/contract_term_matches_type/);
  });

  it('creates a fixed-term contract as a draft, activates it once BOTH parties sign, finds it in the expiry window, and terminates it with a reason', async () => {
    const hrAdmin = fixtures.usersByRole[RoleKey.HR_ADMIN] ?? fixtures.usersByRole[RoleKey.OWNER]!;
    const kasir = await employeeFor(RoleKey.KASIR);
    const session = { userId: hrAdmin.userId, roleKey: RoleKey.HR_ADMIN, locationIds: [] };

    // Ends 30 days from today, in WITA — inside a 60-day window, outside a
    // 7-day one. Computing the date here rather than hardcoding it is what
    // keeps this test true next month.
    const in30Days = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

    const created = await withRollbackAs(session, (client) =>
      service.create(client, hrAdmin.userId, {
        employeeId: kasir.employeeId,
        contractType: 'pkwt',
        position: 'Kasir Senior',
        startDate: new Date().toISOString().slice(0, 10),
        endDate: in30Days,
        baseSalary: '4000000.00',
      }),
    );
    createdIds.push(created.id);
    // Migration 252: a brand-new contract is born unsigned, and the trigger
    // refuses `active` on INSERT unconditionally — `draft` is the only
    // honest default now.
    expect(created.status).toBe('draft');
    expect(created.employeeSigned).toBe(false);
    expect(created.companySignerCount).toBe(0);
    expect(created.fullySigned).toBe(false);
    expect(created.endDate).toBe(in30Days);

    // Trying to jump straight to `active` with nobody signed is refused by
    // the DB trigger, not just the service — this is the "even if the
    // service is bypassed" guarantee, proven the same way the type/term test
    // above proves 230's CHECK.
    await expect(
      withRollbackAs(session, (client) => service.update(client, created.id, { status: 'active' })),
    ).rejects.toThrow(/cannot go active/);

    // Only the employee has signed — still not enough.
    const afterEmployeeSigned = await withRollbackAs(session, (client) =>
      service.sign(client, created.id, hrAdmin.userId, {
        party: 'employee',
        method: 'wet_ink_scan',
      }),
    );
    expect(afterEmployeeSigned.employeeSigned).toBe(true);
    expect(afterEmployeeSigned.fullySigned).toBe(false);
    await expect(
      withRollbackAs(session, (client) => service.update(client, created.id, { status: 'active' })),
    ).rejects.toThrow(/cannot go active/);

    // A second employee signature is a conflict, not a second row.
    await expect(
      withRollbackAs(session, (client) =>
        service.sign(client, created.id, hrAdmin.userId, {
          party: 'employee',
          method: 'digital',
        }),
      ),
    ).rejects.toMatchObject({ response: { code: 'ERR_CONFLICT' } });

    // The company side signs too — now both required parties are in.
    const afterCompanySigned = await withRollbackAs(session, (client) =>
      service.sign(client, created.id, hrAdmin.userId, {
        party: 'company',
        method: 'wet_ink_scan',
      }),
    );
    expect(afterCompanySigned.companySignerCount).toBe(1);
    expect(afterCompanySigned.fullySigned).toBe(true);

    const signatures = await withRollbackAs(session, (client) =>
      service.listSignatures(client, created.id),
    );
    expect(signatures.map((s) => s.partyType).sort()).toEqual(['company', 'employee']);

    const active = await withRollbackAs(session, (client) =>
      service.update(client, created.id, { status: 'active' }),
    );
    expect(active.status).toBe('active');
    // Server-computed countdown — a day either way is fine, a timezone is not.
    expect(active.daysUntilExpiry).toBeGreaterThanOrEqual(29);
    expect(active.daysUntilExpiry).toBeLessThanOrEqual(31);

    const soon = await withRollbackAs(session, (client) =>
      service.list(client, { expiringWithinDays: 60, employeeId: kasir.employeeId }),
    );
    expect(soon.rows.map((c) => c.id)).toContain(created.id);

    const notSoon = await withRollbackAs(session, (client) =>
      service.list(client, { expiringWithinDays: 7, employeeId: kasir.employeeId }),
    );
    expect(notSoon.rows.map((c) => c.id)).not.toContain(created.id);

    const terminated = await withRollbackAs(session, (client) =>
      service.terminate(client, created.id, { reason: 'mengundurkan diri' }),
    );
    expect(terminated.status).toBe('terminated');
    expect(terminated.terminationReason).toBe('mengundurkan diri');
    // No countdown on a contract that is over — showing one would imply it runs.
    expect(terminated.daysUntilExpiry).toBeNull();

    // Terminating twice is a conflict, not a silent no-op.
    await expect(
      withRollbackAs(session, (client) =>
        service.terminate(client, created.id, { reason: 'again' }),
      ),
    ).rejects.toMatchObject({ response: { code: 'ERR_CONFLICT' } });
  });

  it('a draft with no signatures can be deleted; a signed/active/terminated one cannot', async () => {
    const hrAdmin = fixtures.usersByRole[RoleKey.HR_ADMIN] ?? fixtures.usersByRole[RoleKey.OWNER]!;
    const kasir = await employeeFor(RoleKey.KASIR);
    const session = { userId: hrAdmin.userId, roleKey: RoleKey.HR_ADMIN, locationIds: [] };

    const draft = await withRollbackAs(session, (client) =>
      service.create(client, hrAdmin.userId, {
        employeeId: kasir.employeeId,
        contractType: 'pkwtt',
        position: 'Kasir (percobaan penghapusan)',
        startDate: new Date().toISOString().slice(0, 10),
      }),
    );
    // An unsigned draft is exactly the "created by mistake" case this
    // ticket's CRUD audit found defensible to actually remove.
    await withRollbackAs(session, (client) => service.remove(client, draft.id));
    await expect(
      withRollbackAs(session, (client) => service.getById(client, draft.id)),
    ).rejects.toMatchObject({ response: { code: 'ERR_NOT_FOUND' } });

    const signedDraft = await withRollbackAs(session, (client) =>
      service.create(client, hrAdmin.userId, {
        employeeId: kasir.employeeId,
        contractType: 'pkwtt',
        position: 'Kasir (percobaan penghapusan 2)',
        startDate: new Date().toISOString().slice(0, 10),
      }),
    );
    createdIds.push(signedDraft.id);
    await withRollbackAs(session, (client) =>
      service.sign(client, signedDraft.id, hrAdmin.userId, {
        party: 'employee',
        method: 'wet_ink_scan',
      }),
    );
    // A signature is evidence something happened — a hard delete would erase
    // that, so a draft that already carries one is no longer removable.
    await expect(
      withRollbackAs(session, (client) => service.remove(client, signedDraft.id)),
    ).rejects.toMatchObject({ response: { code: 'ERR_CONFLICT' } });
  });

  it('a Kasir sees their own contract signatures via RLS and nobody else’s', async () => {
    const hrAdmin = fixtures.usersByRole[RoleKey.HR_ADMIN] ?? fixtures.usersByRole[RoleKey.OWNER]!;
    const hrSession = { userId: hrAdmin.userId, roleKey: RoleKey.HR_ADMIN, locationIds: [] };
    const kasir = await employeeFor(RoleKey.KASIR);

    const contract = await withRollbackAs(hrSession, (client) =>
      service.create(client, hrAdmin.userId, {
        employeeId: kasir.employeeId,
        contractType: 'pkwtt',
        position: 'Kasir (RLS signature test)',
        startDate: new Date().toISOString().slice(0, 10),
      }),
    );
    createdIds.push(contract.id);
    await withRollbackAs(hrSession, (client) =>
      service.sign(client, contract.id, hrAdmin.userId, { party: 'employee', method: 'digital' }),
    );
    await withRollbackAs(hrSession, (client) =>
      service.sign(client, contract.id, hrAdmin.userId, { party: 'company', method: 'digital' }),
    );

    const kasirSession = {
      userId: kasir.userId,
      roleKey: RoleKey.KASIR,
      locationIds: [fixtures.usersByRole[RoleKey.KASIR]!.locationId],
    };
    const own = await withRollbackAs(kasirSession, (client) =>
      service.listSignatures(client, contract.id),
    );
    expect(own.map((s) => s.partyType).sort()).toEqual(['company', 'employee']);

    // A raw SELECT through the same self-scoped session must see only
    // signatures on contracts BELONGING TO THIS EMPLOYEE (the seed/earlier
    // tests may have left this Kasir with more than one contract of their
    // own) and never another employee's — the guarantee is RLS's, not the
    // service's own WHERE clause.
    await withRollbackAs(kasirSession, async (client) => {
      const all = await client.query<{ employee_id: string }>(
        `SELECT c.employee_id
           FROM contract_signatures s
           JOIN employment_contracts c ON c.id = s.contract_id`,
      );
      expect(all.rows.length).toBeGreaterThan(0);
      for (const row of all.rows) expect(row.employee_id).toBe(kasir.employeeId);
    });
  });

  it('a Kasir cannot write a contract — reading their own is not authoring one', async () => {
    const kasir = await employeeFor(RoleKey.KASIR);
    const session = {
      userId: kasir.userId,
      roleKey: RoleKey.KASIR,
      locationIds: [fixtures.usersByRole[RoleKey.KASIR]!.locationId],
    };
    // The controller's `hr.contract.manage` gate never lets this through, and
    // RLS is the second lock: the policy's WITH CHECK is office-only, so even a
    // direct service call from a Kasir session fails at the database.
    await expect(
      withRollbackAs(session, (client) =>
        service.create(client, kasir.userId, {
          employeeId: kasir.employeeId,
          contractType: 'pkwtt',
          position: 'Manajer',
          startDate: '2026-01-01',
        }),
      ),
    ).rejects.toThrow(/row-level security|permission denied/i);
  });
});
