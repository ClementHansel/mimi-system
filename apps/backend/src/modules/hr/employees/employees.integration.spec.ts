import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { EmploymentStatus, RoleKey } from '@mimi/shared';
import { SyncEmitService } from '../../../kernel/sync/sync-emit.service';
import { SyncEventsRepository } from '../../../kernel/sync/sync-events.repository';
import { ConflictDetectorService } from '../../../kernel/sync/conflict-detector.service';
import { SyncConflictsRepository } from '../../../kernel/sync/sync-conflicts.repository';
import { EmployeesService } from './employees.service';
import type { CreateEmployeeDto, UpdateEmployeeDto } from '../dto/employee.dto';
import {
  asRequest,
  closePool,
  deleteMintedUser,
  loadHrFixtures,
  mintUnlinkedUser,
  type HrFixtures,
} from '../test-support/live-db';

/**
 * Integration proof for `EmployeesService` (M14, CONTRACTS.md §1.7 block
 * 060) — this module had no live-DB suite before BE-TXN-ROLLBACK. Real
 * Postgres, real RLS session (`asRequest`, see `test-support/live-db.ts`'s
 * doc comment).
 *
 * BE-TXN-ROLLBACK: `EmployeesService.create`/`update` now call `withWrite`
 * (a REAL `BEGIN...COMMIT`) — each mutating call below opens its OWN
 * `asRequest` connection, and every verifying read is a SEPARATE connection
 * too, exactly the shape that catches a service that silently never commits.
 */
describe('EmployeesService (integration, live Postgres)', () => {
  let fixtures: HrFixtures;
  let service: EmployeesService;
  let dbAvailable = true;

  beforeAll(async () => {
    try {
      fixtures = await loadHrFixtures();
      if (
        !fixtures.usersByRole[RoleKey.HR_ADMIN] &&
        !fixtures.usersByRole[RoleKey.OWNER] &&
        !fixtures.usersByRole[RoleKey.KASIR]
      ) {
        dbAvailable = false;
        return;
      }
      const pool = new Pool({
        connectionString:
          process.env.DATABASE_URL ??
          `postgres://mimi_app:${process.env.DB_APP_PASSWORD ?? 'mimi_app_secret'}@localhost:${process.env.POSTGRES_PORT ?? '55433'}/${process.env.POSTGRES_DB ?? 'mimi'}`,
      });
      await pool.query('SELECT 1');
      const eventsRepo = new SyncEventsRepository(pool);
      const conflictDetector = new ConflictDetectorService(
        eventsRepo,
        new SyncConflictsRepository(),
      );
      service = new EmployeesService(new SyncEmitService(eventsRepo, conflictDetector));
    } catch {
      dbAvailable = false;
    }
  });

  afterAll(async () => {
    await closePool();
  });

  // Central roles (HR Admin/Owner) get an unrestricted scope (`app_has_location()` bypasses for
  // them regardless of `locationIds`); the Kasir fallback is NOT central, so it needs its own real
  // `user_locations` scope or `employees_scope`'s RLS would deny it outright.
  function actorRls() {
    const hrAdmin = fixtures.usersByRole[RoleKey.HR_ADMIN];
    const owner = fixtures.usersByRole[RoleKey.OWNER];
    if (hrAdmin)
      return { userId: hrAdmin.userId, roleKey: RoleKey.HR_ADMIN, locationIds: [] as string[] };
    if (owner) return { userId: owner.userId, roleKey: RoleKey.OWNER, locationIds: [] as string[] };
    const kasir = fixtures.usersByRole[RoleKey.KASIR]!;
    return { userId: kasir.userId, roleKey: RoleKey.KASIR, locationIds: [kasir.locationId] };
  }

  describe('write-then-read-back across SEPARATE connections (each simulating one real HTTP request)', () => {
    it('create persists past its own request — a later getById (new connection) finds it', async () => {
      if (!dbAvailable) return;
      const rls = actorRls();
      const dto: CreateEmployeeDto = {
        employeeNumber: `TEST-${randomUUID().slice(0, 8)}`,
        name: 'BE-TXN-ROLLBACK Test Employee',
        joinDate: '2026-01-01',
        position: 'Kasir',
        locationId: fixtures.outletId,
        baseSalary: '3000000.00',
      };

      const created = await asRequest(rls, (client) => service.create(client, rls.userId, dto));
      expect(created.employeeNumber).toBe(dto.employeeNumber);

      // A GENUINELY separate connection — never sees `create`'s connection's uncommitted state,
      // only what it actually COMMITted. If `create` had never called `withWrite` (the original
      // bug), this read would 404.
      const reread = await asRequest(rls, (client) => service.getById(client, created.id, true));
      expect(reread.id).toBe(created.id);
      expect(reread.name).toBe(dto.name);
      expect(reread.employments).toHaveLength(1);
      expect(reread.employments[0]!.position).toBe('Kasir');
    });

    it('update persists past its own request — appends a new employments row a later getById (new connection) sees', async () => {
      if (!dbAvailable) return;
      const rls = actorRls();
      const dto: CreateEmployeeDto = {
        employeeNumber: `TEST-${randomUUID().slice(0, 8)}`,
        name: 'BE-TXN-ROLLBACK Update Target',
        joinDate: '2026-01-01',
        position: 'Kasir',
        locationId: fixtures.outletId,
        baseSalary: '3000000.00',
      };
      const created = await asRequest(rls, (client) => service.create(client, rls.userId, dto));

      const update: UpdateEmployeeDto = {
        employmentStatus: EmploymentStatus.ACTIVE,
        employmentChange: {
          position: 'Supervisor',
          locationId: fixtures.outletId,
          baseSalary: '4500000.00',
          startDate: '2026-06-01',
        },
      };
      // Separate connection from `create` above — `create`'s `withWrite` already committed for real.
      const updated = await asRequest(rls, (client) =>
        service.update(client, rls.userId, created.id, update),
      );
      expect(updated.position).toBe('Supervisor');

      // A THIRD, still-different connection — proves `update`'s employments-history append (close
      // the old row, insert the new one) genuinely committed, not merely visible in its own
      // now-closed transaction.
      const reread = await asRequest(rls, (client) => service.getById(client, created.id, true));
      expect(reread.employments).toHaveLength(2);
      expect(reread.employments.some((e) => e.position === 'Supervisor')).toBe(true);
      expect(reread.employments.some((e) => e.position === 'Kasir' && e.endDate !== null)).toBe(
        true,
      );
    });
  });

  /**
   * LINKING AN EMPLOYEE TO A LOGIN, AFTER THE FACT.
   *
   * `employees.user_id` is the only thing that makes `/me` work — Absen, Slip
   * Gaji, Cuti, Pinjaman and Kontrak all resolve the employee behind the
   * caller's account. `CreateEmployeeDto` has always carried `userId`;
   * `UpdateEmployeeDto` never did, so the link was write-once and only at
   * creation, and the frontend form never sent it at all.
   *
   * What that cost, reported from production 2026-09-09: an account created
   * through Administrasi → Tambah Pengguna had a permanently empty Akun Saya,
   * and the empty screen's own advice — "Minta Admin SDM menghubungkan akun
   * Anda dengan data karyawan" — named a repair that no screen and no endpoint
   * could perform. 258 of 263 users on that box were linked ONLY because the
   * seed created the pair together; 37 employees had no login and could not be
   * given one either. `GET /hr/employees/me` answered
   * `404 ERR_NOT_FOUND "This account is not linked to an employee record"` with
   * no way out.
   *
   * The read-back goes through a SEPARATE connection on purpose (this file's
   * standing pattern): `update` is `withWrite`-wrapped, and a link that only
   * existed inside its own uncommitted transaction would pass a same-connection
   * assertion and still leave Akun Saya dead.
   */
  describe('userId — linking and unlinking a login', () => {
    it('links an existing employee to an existing login, and a separate connection sees it', async () => {
      if (!dbAvailable) return;
      const rls = actorRls();
      const spare = await mintUnlinkedUser(RoleKey.KASIR);
      try {
        const dto: CreateEmployeeDto = {
          employeeNumber: `LINK-${randomUUID().slice(0, 8)}`,
          name: 'Link Test Employee',
          joinDate: '2026-01-05',
          position: 'Kasir',
          locationId: fixtures.outletId,
          baseSalary: '3000000.00',
        };
        const created = await asRequest(rls, (client) => service.create(client, rls.userId, dto));
        expect(created.userId, 'a new employee should start with no login').toBeNull();

        const patch: UpdateEmployeeDto = { userId: spare.userId };
        await asRequest(rls, (client) => service.update(client, rls.userId, created.id, patch));

        const reread = await asRequest(rls, (client) => service.getById(client, created.id, true));
        expect(
          reread.userId,
          'the link did not survive its own request — Akun Saya stays dead',
        ).toBe(spare.userId);

        // And the reverse lookup `/me` actually uses.
        const byUser = await asRequest(rls, (client) => service.findByUserId(client, spare.userId));
        expect(byUser.id).toBe(created.id);
      } finally {
        await deleteMintedUser(spare.userId);
      }
    });

    it('refuses a login another employee already holds, naming that employee', async () => {
      if (!dbAvailable) return;
      const rls = actorRls();
      const spare = await mintUnlinkedUser(RoleKey.KASIR);
      try {
        const mk = (n: string): CreateEmployeeDto => ({
          employeeNumber: `LINK-${randomUUID().slice(0, 8)}`,
          name: n,
          joinDate: '2026-01-05',
          position: 'Kasir',
          locationId: fixtures.outletId,
          baseSalary: '3000000.00',
        });
        const first = await asRequest(rls, (client) =>
          service.create(client, rls.userId, mk('Link Holder')),
        );
        const second = await asRequest(rls, (client) =>
          service.create(client, rls.userId, mk('Link Contender')),
        );

        await asRequest(rls, (client) =>
          service.update(client, rls.userId, first.id, { userId: spare.userId }),
        );

        // `employees_user_id_key` would catch this anyway, but as a bare 23505 →
        // a generic "Data ini sudah ada", which does not tell an HR admin WHERE
        // the account went. The message has to carry the holder.
        await expect(
          asRequest(rls, (client) =>
            service.update(client, rls.userId, second.id, { userId: spare.userId }),
          ),
          'a login was quietly handed to a second employee',
        ).rejects.toMatchObject({ response: { code: 'ERR_DUPLICATE' } });

        await expect(
          asRequest(rls, (client) =>
            service.update(client, rls.userId, second.id, { userId: spare.userId }),
          ),
        ).rejects.toMatchObject({ response: { message: expect.stringContaining('Link Holder') } });
      } finally {
        await deleteMintedUser(spare.userId);
      }
    });

    it('unlinks on an explicit null, so a mis-link is fixable without SQL', async () => {
      if (!dbAvailable) return;
      const rls = actorRls();
      const spare = await mintUnlinkedUser(RoleKey.KASIR);
      try {
        const created = await asRequest(rls, (client) =>
          service.create(client, rls.userId, {
            employeeNumber: `LINK-${randomUUID().slice(0, 8)}`,
            name: 'Unlink Test Employee',
            joinDate: '2026-01-05',
            position: 'Kasir',
            locationId: fixtures.outletId,
            baseSalary: '3000000.00',
            userId: spare.userId,
          }),
        );
        expect(created.userId).toBe(spare.userId);

        await asRequest(rls, (client) =>
          service.update(client, rls.userId, created.id, { userId: null }),
        );

        const reread = await asRequest(rls, (client) => service.getById(client, created.id, true));
        expect(reread.userId, 'null must UNLINK, not be ignored as "no change"').toBeNull();
      } finally {
        await deleteMintedUser(spare.userId);
      }
    });

    it('leaves the link untouched when userId is omitted', async () => {
      if (!dbAvailable) return;
      const rls = actorRls();
      const spare = await mintUnlinkedUser(RoleKey.KASIR);
      try {
        const created = await asRequest(rls, (client) =>
          service.create(client, rls.userId, {
            employeeNumber: `LINK-${randomUUID().slice(0, 8)}`,
            name: 'Keep Link Employee',
            joinDate: '2026-01-05',
            position: 'Kasir',
            locationId: fixtures.outletId,
            baseSalary: '3000000.00',
            userId: spare.userId,
          }),
        );

        // An ordinary edit that says nothing about the account. `undefined` and
        // `null` mean different things here and this is the pair that proves it.
        await asRequest(rls, (client) =>
          service.update(client, rls.userId, created.id, { phone: '08123456789' }),
        );

        const reread = await asRequest(rls, (client) => service.getById(client, created.id, true));
        expect(reread.userId, 'an unrelated edit dropped the login link').toBe(spare.userId);
        expect(reread.phone).toBe('08123456789');
      } finally {
        await deleteMintedUser(spare.userId);
      }
    });
  });
});
