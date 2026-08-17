import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { RoleKey } from '@mimi/shared';
import { SyncEmitService } from '../../../kernel/sync/sync-emit.service';
import { SyncEventsRepository } from '../../../kernel/sync/sync-events.repository';
import { ConflictDetectorService } from '../../../kernel/sync/conflict-detector.service';
import { SyncConflictsRepository } from '../../../kernel/sync/sync-conflicts.repository';
import { ShiftsService } from './shifts.service';
import type { CreateShiftDto, UpsertRosterDto } from '../dto/shift.dto';
import { asRequest, closePool, deleteWorkShift, loadHrFixtures, type HrFixtures } from '../test-support/live-db';

/**
 * Integration proof for `ShiftsService` (FR-HR-02, M14) — this module had
 * no live-DB suite before BE-TXN-ROLLBACK. Real Postgres, real RLS session
 * (`asRequest`, see `test-support/live-db.ts`'s doc comment).
 *
 * BE-TXN-ROLLBACK: `ShiftsService.createShift`/`updateShift`/`upsertRoster`
 * now call `withWrite` (a REAL `BEGIN...COMMIT`) — each mutating call below
 * opens its OWN `asRequest` connection, and every verifying read is a
 * SEPARATE connection too, exactly the shape that catches a service that
 * silently never commits.
 */
describe('ShiftsService (integration, live Postgres)', () => {
  let fixtures: HrFixtures;
  let service: ShiftsService;
  let dbAvailable = true;

  beforeAll(async () => {
    try {
      fixtures = await loadHrFixtures();
      if (!fixtures.usersByRole[RoleKey.SUPERVISOR] && !fixtures.usersByRole[RoleKey.HR_ADMIN] && !fixtures.usersByRole[RoleKey.KASIR]) {
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
      const conflictDetector = new ConflictDetectorService(eventsRepo, new SyncConflictsRepository(pool));
      service = new ShiftsService(new SyncEmitService(eventsRepo, conflictDetector));
    } catch {
      dbAvailable = false;
    }
  });

  afterAll(async () => {
    await closePool();
  });

  // Central roles bypass `app_has_location()` regardless of `locationIds`; a scoped fallback
  // (Supervisor/Kasir) needs its own real `user_locations` scope, matching that role's seed row.
  function actorRls() {
    const spv = fixtures.usersByRole[RoleKey.SUPERVISOR];
    const hrAdmin = fixtures.usersByRole[RoleKey.HR_ADMIN];
    if (hrAdmin) return { userId: hrAdmin.userId, roleKey: RoleKey.HR_ADMIN, locationIds: [] as string[] };
    if (spv) return { userId: spv.userId, roleKey: RoleKey.SUPERVISOR, locationIds: [spv.locationId] };
    const kasir = fixtures.usersByRole[RoleKey.KASIR]!;
    return { userId: kasir.userId, roleKey: RoleKey.KASIR, locationIds: [kasir.locationId] };
  }

  describe('write-then-read-back across SEPARATE connections (each simulating one real HTTP request)', () => {
    it('createShift persists past its own request — a later listShifts (new connection) finds it', async () => {
      if (!dbAvailable) return;
      const rls = actorRls();
      const dto: CreateShiftDto = { locationId: fixtures.outletId, name: 'BE-TXN-ROLLBACK Test Shift', startTime: '07:00', endTime: '15:00', breakMinutes: 30 };

      let shiftId: string | undefined;
      try {
        const created = await asRequest(rls, (client) => service.createShift(client, rls.userId, dto));
        shiftId = created.id;
        expect(created.name).toBe(dto.name);

        // A GENUINELY separate connection — never sees `createShift`'s connection's uncommitted
        // state, only what it actually COMMITted. If `createShift` had never called `withWrite`
        // (the original bug), this list would come back empty.
        const list = await asRequest(rls, (client) => service.listShifts(client, fixtures.outletId));
        expect(list.some((s) => s.id === created.id)).toBe(true);
      } finally {
        if (shiftId) await deleteWorkShift(shiftId);
      }
    });

    it('updateShift persists past its own request — a later listShifts (new connection) sees the new name', async () => {
      if (!dbAvailable) return;
      const rls = actorRls();
      const dto: CreateShiftDto = { locationId: fixtures.outletId, name: 'BE-TXN-ROLLBACK Update Target', startTime: '08:00', endTime: '16:00', breakMinutes: 30 };

      let shiftId: string | undefined;
      try {
        const created = await asRequest(rls, (client) => service.createShift(client, rls.userId, dto));
        shiftId = created.id;

        // Separate connection from `createShift` above — its `withWrite` already committed for real.
        const updated = await asRequest(rls, (client) => service.updateShift(client, rls.userId, created.id, { name: 'BE-TXN-ROLLBACK Renamed' }));
        expect(updated.name).toBe('BE-TXN-ROLLBACK Renamed');

        // A THIRD, still-different connection.
        const list = await asRequest(rls, (client) => service.listShifts(client, fixtures.outletId));
        const found = list.find((s) => s.id === created.id);
        expect(found?.name).toBe('BE-TXN-ROLLBACK Renamed');
      } finally {
        if (shiftId) await deleteWorkShift(shiftId);
      }
    });

    it('upsertRoster persists past its own request — a later getRoster (new connection) sees the assignment', async () => {
      if (!dbAvailable) return;
      const rls = actorRls();
      const employeeId = fixtures.usersByRole[RoleKey.KASIR]?.employeeId ?? fixtures.usersByRole[RoleKey.LEADER_OUTLET]?.employeeId;
      if (!employeeId) return; // seed has no rosterable employee at this outlet — nothing to prove

      const shiftDto: CreateShiftDto = { locationId: fixtures.outletId, name: 'BE-TXN-ROLLBACK Roster Shift', startTime: '09:00', endTime: '17:00', breakMinutes: 30 };
      let shiftId: string | undefined;
      try {
        const shift = await asRequest(rls, (client) => service.createShift(client, rls.userId, shiftDto));
        shiftId = shift.id;

        // A far-future, randomized-day date — avoids colliding with any real roster row a
        // concurrent test run might also be writing for this employee.
        const day = String(1 + Math.floor(Math.random() * 27)).padStart(2, '0');
        const date = `2099-01-${day}`;
        const rosterDto: UpsertRosterDto = { locationId: fixtures.outletId, assignments: [{ employeeId, workShiftId: shift.id, date }] };
        // Separate connection from `createShift` above.
        const result = await asRequest(rls, (client) => service.upsertRoster(client, rls.userId, rosterDto));
        expect(result.updated).toBe(1);

        // A THIRD, still-different connection — proves the roster write genuinely committed.
        const roster = await asRequest(rls, (client) => service.getRoster(client, fixtures.outletId, date, date, employeeId));
        const row = roster.find((r) => r.employeeId === employeeId);
        expect(row?.days.some((d) => d.date === date && d.workShiftId === shift.id)).toBe(true);
      } finally {
        if (shiftId) await deleteWorkShift(shiftId); // also removes the shift_assignments row via FK cleanup in deleteWorkShift
      }
    });
  });
});
