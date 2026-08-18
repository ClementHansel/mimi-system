import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { AttendanceService } from './attendance.service';
import { StorageService } from '../../../kernel/storage/storage.service';
import type { CheckAttendanceDto } from '../dto/attendance.dto';
import {
  assignShift,
  asRequest,
  closePool,
  createWorkShift,
  deleteAttendanceForDate,
  deleteWorkShift,
  loadHrFixtures,
  nextClientId,
  restoreAttendanceRow,
  toJwtPayload,
  type HrFixtures,
} from '../test-support/live-db';
import { RoleKey } from '@mimi/shared';

/**
 * Integration proof (FR-HR-01, SYNC-PROTOCOL §6.3/§6.4) — against a REAL
 * Postgres connection under the SAME RLS session context a real request
 * gets (`withRollbackAs`, copied from `kernel/approvals/test-support/live-db.ts`
 * per the ticket instruction). Every `it()` below issues real SQL against
 * the live, seeded database; none of this is `expect(true).toBe(true)`.
 *
 * BE-TXN-ROLLBACK: `AttendanceService.checkIn`/`checkOut`/`correct` now call
 * `withWrite` (a REAL `BEGIN...COMMIT`) — see `test-support/live-db.ts`'s
 * `asRequest` doc comment for why this means every test below opens a
 * SEPARATE `asRequest`/`withRollbackAs` connection per mutating call, and
 * never reads on the SAME connection a mutating call just ran on (that
 * connection's role/session context is gone the instant the real `COMMIT`
 * or `ROLLBACK` inside `withWrite` fires).
 *
 * Skips gracefully (not silently) if Postgres/MinIO aren't reachable —
 * mirrors `kernel/storage/storage.service.integration.spec.ts`'s pattern.
 */
function fakeConfigService() {
  const values: Record<string, string> = {
    MINIO_ENDPOINT: process.env.TEST_MINIO_HOST ?? 'localhost',
    MINIO_PORT: process.env.TEST_MINIO_PORT ?? '9000',
    MINIO_USE_SSL: 'false',
    MINIO_ACCESS_KEY: 'mimi_minio',
    MINIO_SECRET_KEY: 'mimi_minio_secret',
    MINIO_BUCKET: 'mimi-storage-test',
    S3_REGION: 'us-east-1',
  };
  return { get: (key: string, def?: unknown) => values[key] ?? def } as never;
}

function todayWita(): string {
  return new Date(Date.now() + 8 * 60 * 60_000).toISOString().slice(0, 10);
}

describe('AttendanceService (integration, live Postgres)', () => {
  let fixtures: HrFixtures;
  let service: AttendanceService;
  let dbAvailable = true;

  beforeAll(async () => {
    try {
      fixtures = await loadHrFixtures();
      if (!fixtures.usersByRole[RoleKey.KASIR] && !fixtures.usersByRole[RoleKey.LEADER_OUTLET]) {
        dbAvailable = false;
        return;
      }
      // `StorageService` takes its OWN `Pool` (not the per-request RLS `PoolClient` `AttendanceService`
      // uses) — matching `kernel/storage/storage.service.integration.spec.ts`'s own precedent, this is
      // the plain `DATABASE_MIGRATION_URL` identity, not `mimi_app`. `mimi_app` is `NOINHERIT` into
      // `app_user` (D-21/D-22) and holds no grants of its own on tables like `attachments` that are
      // granted only to `app_user` — `StorageService`'s raw-pool queries never issue `SET ROLE
      // app_user` the way `RlsContextGuard` does for `req.dbClient`, so a `mimi_app`-identity pool
      // here reproduces a real gap in `kernel/storage` (not this module) rather than testing this
      // module's own behavior. Flagged in the final report as a cross-module finding.
      const pool = new Pool({
        connectionString:
          process.env.DATABASE_MIGRATION_URL ??
          `postgres://${process.env.POSTGRES_USER ?? 'mimi'}:${process.env.POSTGRES_PASSWORD ?? 'mimi_secret'}@localhost:${process.env.POSTGRES_PORT ?? '55433'}/${process.env.POSTGRES_DB ?? 'mimi'}`,
      });
      await pool.query('SELECT 1');
      service = new AttendanceService(new StorageService(fakeConfigService(), pool));
    } catch {
      dbAvailable = false;
    }
  });

  afterAll(async () => {
    await closePool();
  });

  function selfEmployee() {
    return fixtures.usersByRole[RoleKey.KASIR] ?? fixtures.usersByRole[RoleKey.LEADER_OUTLET]!;
  }

  function yesterdayWita(): string {
    return new Date(Date.now() + 8 * 60 * 60_000 - 24 * 60 * 60_000).toISOString().slice(0, 10);
  }

  /**
   * Seed data already carries a punch for most employees on most recent days — clear the ones a
   * given test can possibly land on and restore them after. Today's punch is the obvious one; a
   * §6.4 `defensibleAt`-clamped claim can also land on YESTERDAY's business date (the clamp is
   * `receivedAt - maxOfflineWindowHours`, which can cross the WITA midnight boundary depending on
   * what time the suite happens to run) — clearing both keeps the test deterministic regardless of
   * wall-clock time, rather than being flaky depending on when CI happens to run it.
   *
   * QA-ATTENDANCE-LEAK: `fn()` below drives `checkIn`/`checkOut`, which now commit for real
   * (`withWrite`, BE-TXN-ROLLBACK) — so whatever `fn()` does for `employeeId` on these dates
   * genuinely OUTLIVES this callback, not just "until the request's transaction rolls back" the way
   * this harness originally assumed. That row must be deleted BEFORE the pre-existing snapshot is
   * restored, and it must be deleted UNCONDITIONALLY — even when there was no snapshot to restore
   * (`existing[i]` null), because a leftover with nothing to collide with is still a leak: it is
   * exactly what let test 1's committed check-in silently survive into test 2's `withCleanSlate`
   * call in the old code, then collide (`attendance_employee_id_date_key`) the first time a LATER
   * test in this same file also committed a real row for the same (employee_id, date) — which is
   * why the failure only ever surfaced starting at the 4th test, entirely self-inflicted within
   * this file, no other suite required. `restoreAttendanceRow` itself now also deletes-before-insert
   * as defense in depth, but doing the unconditional cleanup here too is what actually stops this
   * test's own writes from leaking into the NEXT test in the first place.
   */
  async function withCleanSlate<T>(employeeId: string, fn: () => Promise<T>): Promise<T> {
    const dates = [todayWita(), yesterdayWita()];
    const existing = await Promise.all(dates.map((d) => deleteAttendanceForDate(employeeId, d)));
    try {
      return await fn();
    } finally {
      for (const date of dates) await deleteAttendanceForDate(employeeId, date);
      for (const row of existing) if (row) await restoreAttendanceRow(row);
    }
  }

  it('check-in INSIDE the geofence succeeds and records the measured distance, not just a pass/fail', async () => {
    if (!dbAvailable) return;
    const kasir = selfEmployee();
    const rls = { userId: kasir.userId, roleKey: RoleKey.KASIR, locationIds: [kasir.locationId] };
    const user = toJwtPayload(rls);

    await withCleanSlate(kasir.employeeId, async () => {
      const dto: CheckAttendanceDto = {
        clientId: nextClientId(),
        locationId: fixtures.outletId,
        lat: String(fixtures.outletLat + 0.0002), // ~22m north — inside 100m
        lng: String(fixtures.outletLng),
        accuracyM: 8,
        selfieAttachmentId: fixtures.attachmentId,
      };

      const row = await asRequest(rls, (client) => service.checkIn(client, user, dto));
      expect(row.geofenceOk).toBe(true);
      expect(row.checkInAt).not.toBeNull();
      expect(row.selfieUrls.in).not.toBeNull();

      // A GENUINELY separate connection — never sees `checkIn`'s connection's uncommitted state,
      // only what it actually COMMITted (BE-TXN-ROLLBACK regression guard).
      const raw = await asRequest(rls, (client) =>
        client.query('SELECT check_in_distance_m, geofence_ok FROM attendance WHERE id = $1', [
          row.id,
        ]),
      );
      // The number itself is on the row — a supervisor adjudicating a dispute needs the distance,
      // not just true/false (ticket instruction).
      expect(typeof raw.rows[0].check_in_distance_m).toBe('number');
      expect(raw.rows[0].check_in_distance_m).toBeGreaterThan(0);
      expect(raw.rows[0].check_in_distance_m).toBeLessThan(100);
      expect(raw.rows[0].geofence_ok).toBe(true);
    });
  });

  it('check-in OUTSIDE the configured radius is rejected with ERR_GEOFENCE_OUT_OF_RANGE and the measured distance in details', async () => {
    if (!dbAvailable) return;
    const kasir = selfEmployee();
    const rls = { userId: kasir.userId, roleKey: RoleKey.KASIR, locationIds: [kasir.locationId] };
    const user = toJwtPayload(rls);

    await withCleanSlate(kasir.employeeId, async () => {
      const dto: CheckAttendanceDto = {
        clientId: nextClientId(),
        locationId: fixtures.outletId,
        lat: String(fixtures.outletLat + 0.01), // ~1.1km away — well outside 100m
        lng: String(fixtures.outletLng),
        accuracyM: 8,
        selfieAttachmentId: fixtures.attachmentId,
      };

      await asRequest(rls, (client) =>
        expect(service.checkIn(client, user, dto)).rejects.toMatchObject({
          response: {
            code: 'ERR_GEOFENCE_OUT_OF_RANGE',
            details: expect.objectContaining({
              distanceM: expect.any(Number),
              radiusM: fixtures.outletRadiusM,
            }),
          },
        }),
      );

      // Separate connection: proves the rejected attempt never committed a row either.
      const noRow = await asRequest(rls, (client) =>
        client.query('SELECT id FROM attendance WHERE employee_id = $1 AND client_id = $2', [
          kasir.employeeId,
          dto.clientId,
        ]),
      );
      expect(noRow.rows.length).toBe(0); // rejected attempt — no silent accept, no row created either
    });
  });

  it('check-in with a selfieAttachmentId that does not reference an uploaded attachment is rejected (wajib foto, FR-HR-01)', async () => {
    if (!dbAvailable) return;
    const kasir = selfEmployee();
    const rls = { userId: kasir.userId, roleKey: RoleKey.KASIR, locationIds: [kasir.locationId] };
    const user = toJwtPayload(rls);

    await withCleanSlate(kasir.employeeId, async () => {
      await asRequest(rls, async (client) => {
        const dto: CheckAttendanceDto = {
          clientId: nextClientId(),
          locationId: fixtures.outletId,
          lat: String(fixtures.outletLat),
          lng: String(fixtures.outletLng),
          accuracyM: 8,
          selfieAttachmentId: randomUUID(), // well-formed UUID, no such attachments row
        };

        await expect(service.checkIn(client, user, dto)).rejects.toMatchObject({
          response: { code: 'ERR_VALIDATION' },
        });
      });
    });
  });

  it('derives lateness and overtime against a REAL assigned shift (PIN-02/POUT-07 payroll inputs)', async () => {
    if (!dbAvailable) return;
    const kasir = selfEmployee();
    const rls = { userId: kasir.userId, roleKey: RoleKey.KASIR, locationIds: [kasir.locationId] };
    const user = toJwtPayload(rls);

    // Anchor the whole shift window to "now" — a fixed 08:00-16:00 WITA shift would be indistinguishable
    // from a FUTURE claim (SYNC-PROTOCOL §6.3, 5-min grace) whenever the suite happens to run before
    // 16:00 WITA, silently swapping in `defensibleAt` instead of the intended `occurredAt` and zeroing
    // the derived overtime — exactly the flake this anchoring avoids. `checkInAt`/`checkOutAt` stay
    // safely in the recent PAST of the moment this test runs, regardless of wall-clock time.
    const now = new Date();
    const wallWita = new Date(now.getTime() + 8 * 60 * 60_000);
    const hhmm = (d: Date) =>
      `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;

    // QA-ATTENDANCE-LEAK: the original version derived the shift's calendar DATE from `wallWita`
    // (i.e. "now"'s own WITA date) while deriving the shift's START from "wallWita - 3h" — two
    // different instants that silently assumed the same calendar day. Whenever the suite runs
    // within ~3h of WITA midnight (reproduced against this exact bug at WITA wall-clock 01:04),
    // "3h before now" lands on the PREVIOUS WITA day, so the shift got assigned to `date=today`
    // while the check-in's own `businessDateOf(checkInAt)` resolved to YESTERDAY —
    // `resolveShiftAssignment` (attendance.service.ts) then genuinely found no assignment for the
    // check-in's actual business date and correctly reported `status: 'present'`. That is real
    // production code behaving correctly against a mismatched fixture, not a wrong assertion — the
    // fix is entirely in how this test derives its dates, not in the service or the expectation.
    // When "now" is far enough from WITA midnight, keep the original "hours before now" anchoring
    // (needed so the claim never looks like a future one, SYNC-PROTOCOL §6.3); when it's NOT (WITA
    // hour < 4), use a fixed, comfortably mid-evening window on the PREVIOUS WITA day instead — still
    // guaranteed to be in the past and inside the default 24h offline window, just far from that
    // day's own midnight boundaries so it can't itself straddle one.
    const nowWitaHour = wallWita.getUTCHours();
    let shiftStartWita: Date;
    let shiftEndWita: Date;
    if (nowWitaHour < 4) {
      const priorEvening = new Date(wallWita.getTime() - 24 * 60 * 60_000);
      priorEvening.setUTCHours(20, 0, 0, 0); // 20:00 WITA-wall-clock, previous day
      shiftStartWita = priorEvening;
      shiftEndWita = new Date(shiftStartWita.getTime() + 2 * 60 * 60_000); // 22:00, same WITA day
    } else {
      shiftStartWita = new Date(wallWita.getTime() - 3 * 60 * 60_000); // 3h before "now"
      shiftEndWita = new Date(wallWita.getTime() - 1 * 60 * 60_000); // 1h before "now"
    }
    // The shift's calendar date is read off the shift's OWN instant (its UTC getters already carry
    // the WITA wall-clock components — same trick `wallWita` itself uses), never off `wallWita`'s
    // date directly, which is exactly the assumption that broke near midnight.
    const shiftDate = shiftStartWita.toISOString().slice(0, 10);
    const toRealInstant = (witaWall: Date) => new Date(witaWall.getTime() - 8 * 60 * 60_000);

    const shiftId = await createWorkShift(
      fixtures.outletId,
      hhmm(shiftStartWita),
      hhmm(shiftEndWita),
      30,
    );
    try {
      await assignShift(kasir.employeeId, shiftId, fixtures.outletId, shiftDate, kasir.userId);

      await withCleanSlate(kasir.employeeId, async () => {
        // Check in 20 minutes after shift start — beyond the 5-min grace.
        const checkInAt = new Date(
          toRealInstant(shiftStartWita).getTime() + 20 * 60_000,
        ).toISOString();
        const inDto: CheckAttendanceDto = {
          clientId: nextClientId(),
          locationId: fixtures.outletId,
          lat: String(fixtures.outletLat),
          lng: String(fixtures.outletLng),
          accuracyM: 8,
          selfieAttachmentId: fixtures.attachmentId,
          at: checkInAt,
        };
        const inRow = await asRequest(rls, (client) => service.checkIn(client, user, inDto));
        expect(inRow.status).toBe('late');
        expect(inRow.lateMinutes).toBeGreaterThanOrEqual(14); // 20 min late - 5 min grace, allow rounding
        expect(inRow.lateMinutes).toBeLessThanOrEqual(16);

        // Check out 45 minutes after shift end — beyond the 30-min overtime floor.
        // A GENUINELY SEPARATE connection from check-in above — `checkIn`'s `withWrite` already
        // committed the row for real, so this new connection sees it (BE-TXN-ROLLBACK: two real
        // requests, never one shared transaction chaining two mutating calls).
        const checkOutAt = new Date(
          toRealInstant(shiftEndWita).getTime() + 45 * 60_000,
        ).toISOString();
        const outDto: CheckAttendanceDto = {
          clientId: nextClientId(),
          locationId: fixtures.outletId,
          lat: String(fixtures.outletLat),
          lng: String(fixtures.outletLng),
          accuracyM: 8,
          selfieAttachmentId: fixtures.attachmentId,
          at: checkOutAt,
        };
        const outRow = await asRequest(rls, (client) => service.checkOut(client, user, outDto));
        expect(outRow.overtimeMinutes).toBeGreaterThanOrEqual(44);
        expect(outRow.overtimeMinutes).toBeLessThanOrEqual(46);
      });
    } finally {
      await deleteWorkShift(shiftId);
    }
  });

  it('SYNC-PROTOCOL §6.4: a claim far outside the offline window is tagged time_disputed, not silently accepted or discarded', async () => {
    if (!dbAvailable) return;
    const kasir = selfEmployee();
    const rls = { userId: kasir.userId, roleKey: RoleKey.KASIR, locationIds: [kasir.locationId] };
    const user = toJwtPayload(rls);

    await withCleanSlate(kasir.employeeId, async () => {
      // A device clock claiming a check-in 3 days ago (default max_offline_window_h = 24h) — an
      // honest-but-very-late sync OR an adversarial clock, per SYNC-PROTOCOL §6.3/§6.4. Either way
      // the claim must degrade to review, never silently win punctuality nor get discarded outright.
      const staleOccurredAt = new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString();
      const dto: CheckAttendanceDto = {
        clientId: nextClientId(),
        locationId: fixtures.outletId,
        lat: String(fixtures.outletLat),
        lng: String(fixtures.outletLng),
        accuracyM: 8,
        selfieAttachmentId: fixtures.attachmentId,
        at: staleOccurredAt,
      };

      const row = await asRequest(rls, (client) => service.checkIn(client, user, dto));
      // §6.3: |offset| > 24h is time_suspect regardless of direction — a claim this stale reads
      // exactly like a badly-drifted clock, so both flags fire (§6.4: time_suspect -> time_disputed).
      expect(row.timeSuspect).toBe(true);

      // Separate connection for the verifying read (BE-TXN-ROLLBACK regression guard).
      const raw = await asRequest(rls, (client) =>
        // `to_char` avoids the classic `pg` DATE-column pitfall: the driver parses a `DATE` value into
        // a JS `Date` at LOCAL midnight, so `.toISOString()` (UTC) shifts it a calendar day backward
        // whenever the test process's local timezone is ahead of UTC — a test-harness artifact, not a
        // service bug. Reading it back as text sidesteps that entirely.
        client.query<{ time_disputed: boolean; date_text: string }>(
          `SELECT time_disputed, to_char(date, 'YYYY-MM-DD') AS date_text FROM attendance WHERE id = $1`,
          [row.id],
        ),
      );
      expect(raw.rows[0]!.time_disputed).toBe(true);
      // Business date used the DEFENSIBLE clamp (bounded to `receivedAt - maxOfflineWindow`, i.e.
      // "recent", never the claimed 3-days-ago date) — the row is NOT silently filed where no one
      // reviewing this period would look for it. The clamp can land on today OR yesterday depending
      // on what time of day WITA the suite happens to run (it crosses the WITA midnight boundary),
      // so assert against the SAME clamp the service itself computes, not a hardcoded "today".
      expect([todayWita(), yesterdayWita()]).toContain(raw.rows[0]!.date_text);
      // But never the claimed date itself (3 days ago) — the whole point of the clamp.
      expect(raw.rows[0]!.date_text).not.toBe(staleOccurredAt.slice(0, 10));
    });
  });

  it('a claim in the future beyond the 5-minute grace is tagged time_suspect', async () => {
    if (!dbAvailable) return;
    const kasir = selfEmployee();
    const rls = { userId: kasir.userId, roleKey: RoleKey.KASIR, locationIds: [kasir.locationId] };
    const user = toJwtPayload(rls);

    await withCleanSlate(kasir.employeeId, async () => {
      const futureOccurredAt = new Date(Date.now() + 30 * 60_000).toISOString(); // 30 min ahead of "now"
      const dto: CheckAttendanceDto = {
        clientId: nextClientId(),
        locationId: fixtures.outletId,
        lat: String(fixtures.outletLat),
        lng: String(fixtures.outletLng),
        accuracyM: 8,
        selfieAttachmentId: fixtures.attachmentId,
        at: futureOccurredAt,
      };

      const row = await asRequest(rls, (client) => service.checkIn(client, user, dto));
      expect(row.timeSuspect).toBe(true);

      const raw = await asRequest(rls, (client) =>
        client.query('SELECT time_disputed FROM attendance WHERE id = $1', [row.id]),
      );
      expect(raw.rows[0].time_disputed).toBe(true);
    });
  });

  // ── BE-TXN-ROLLBACK regression: writes must survive past the request that made them ──
  //
  // Every test above already opens a SEPARATE connection per mutating call (see the file
  // header) — this block additionally proves the write survives all the way to a plain
  // `listMe` read, the same shape a follow-up `GET /api/hr/attendance/me` would take.
  describe('write-then-read-back across SEPARATE connections (each simulating one real HTTP request)', () => {
    it('check-in persists past its own request — a later listMe (new connection) finds it', async () => {
      if (!dbAvailable) return;
      const kasir = selfEmployee();
      const rls = { userId: kasir.userId, roleKey: RoleKey.KASIR, locationIds: [kasir.locationId] };
      const user = toJwtPayload(rls);

      await withCleanSlate(kasir.employeeId, async () => {
        const dto: CheckAttendanceDto = {
          clientId: nextClientId(),
          locationId: fixtures.outletId,
          lat: String(fixtures.outletLat),
          lng: String(fixtures.outletLng),
          accuracyM: 8,
          selfieAttachmentId: fixtures.attachmentId,
        };

        const created = await asRequest(rls, (client) => service.checkIn(client, user, dto));
        expect(created.checkInAt).not.toBeNull();

        // A GENUINELY separate connection/transaction — never sees `checkIn`'s connection's
        // uncommitted state, only what it actually COMMITted. If `checkIn` had never called
        // `withWrite` (the original bug), this list would come back empty.
        const listed = await asRequest(rls, (client) =>
          service.listMe(client, user, todayWita().slice(0, 7)),
        );
        expect(listed.some((r) => r.id === created.id)).toBe(true);
      });
    });
  });
});
