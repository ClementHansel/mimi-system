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
import { asRequest, closePool, loadHrFixtures, type HrFixtures } from '../test-support/live-db';

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
});
