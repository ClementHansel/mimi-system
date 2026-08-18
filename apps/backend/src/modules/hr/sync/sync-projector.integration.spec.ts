import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { ConfigService } from '@nestjs/config';
import { LeaveType, RoleKey, SyncOriginType } from '@mimi/shared';
import { formatUuidV7, type SyncEventEnvelope, type SyncPushBatch } from '@mimi/sync-protocol';
import { SyncEventsRepository } from '../../../kernel/sync/sync-events.repository';
import { SyncConflictsRepository } from '../../../kernel/sync/sync-conflicts.repository';
import { OfflineCredentialsRepository } from '../../../kernel/sync/offline-credentials.repository';
import { ConflictDetectorService } from '../../../kernel/sync/conflict-detector.service';
import { OfflineAuthService } from '../../../kernel/sync/offline-auth.service';
import { ReconciliationService } from '../../../kernel/sync/reconciliation.service';
import { RegistryRepository } from '../../../kernel/sync/registry.repository';
import { SyncIngestService } from '../../../kernel/sync/sync-ingest.service';
import { SyncProjectorRegistry } from '../../../kernel/sync/sync-projector-registry.service';
import { StorageService } from '../../../kernel/storage/storage.service';
import { AttendanceService } from '../attendance/attendance.service';
import { LeavesService } from '../leaves/leaves.service';
import { ApprovalService } from '../../../kernel/approvals/approvals.service';
import { ApprovalsRepository } from '../../../kernel/approvals/approvals.repository';
import { SyncEmitService } from '../../../kernel/sync/sync-emit.service';
import { AttendanceSyncProjector } from './attendance-sync-projector.service';
import { LeaveSyncProjector } from './leave-sync-projector.service';
import {
  deleteAttendanceForDate,
  loadHrFixtures,
  restoreAttendanceRow,
  type HrFixtures,
} from '../test-support/live-db';

/**
 * Real-ingest proof of the coordinator's requirement: an offline-originated
 * `attendance.checked_in`/`.checked_out` (and `leave_requests.submitted`)
 * fact, pushed through the ACTUAL `SyncIngestService` pipeline (envelope
 * validation, conflict detection, `sync_events` insert, THEN this module's
 * registered projector — the exact path a real device push takes), lands as
 * a real domain row — with `time_suspect`/`time_disputed`/`defensibleAt`
 * tagging derived identically to the online REST endpoint (not by writing
 * `occurredAt` verbatim), and idempotently (a replayed batch produces
 * exactly one row).
 *
 * Mirrors `kernel/sync/sync-projector-registry.integration.test.ts`'s real
 * wiring, but registers THIS module's real projectors instead of a fake one.
 */
const fakeConfig = { get: (_key: string, def?: string) => def } as unknown as ConfigService;

function fakeStorageConfig() {
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

function batchOf(events: SyncEventEnvelope[]): SyncPushBatch {
  return { batchId: randomUUID(), sentAt: new Date().toISOString(), events };
}

describe('AttendanceSyncProjector / LeaveSyncProjector (integration, real ingest, live Postgres)', () => {
  let fixtures: HrFixtures;
  let dbAvailable = true;
  let ingest: SyncIngestService;
  let ownerPool: Pool;
  const createdOrigins: string[] = [];

  function freshOrigin(): string {
    const id = randomUUID();
    createdOrigins.push(id);
    return id;
  }

  async function resolveLocation(originDeviceId: string): Promise<string | undefined> {
    return createdOrigins.includes(originDeviceId) ? fixtures.outletId : undefined;
  }

  beforeAll(async () => {
    try {
      fixtures = await loadHrFixtures();
      const employee =
        fixtures.usersByRole[RoleKey.KASIR] ?? fixtures.usersByRole[RoleKey.LEADER_OUTLET];
      if (!employee) {
        dbAvailable = false;
        return;
      }

      const appPool = new Pool({
        connectionString:
          process.env.DATABASE_URL ??
          `postgres://mimi_app:${process.env.DB_APP_PASSWORD ?? 'mimi_app_secret'}@localhost:${process.env.POSTGRES_PORT ?? '55433'}/${process.env.POSTGRES_DB ?? 'mimi'}`,
      });
      await appPool.query('SELECT 1');
      ownerPool = new Pool({
        connectionString:
          process.env.DATABASE_MIGRATION_URL ??
          `postgres://${process.env.POSTGRES_USER ?? 'mimi'}:${process.env.POSTGRES_PASSWORD ?? 'mimi_secret'}@localhost:${process.env.POSTGRES_PORT ?? '55433'}/${process.env.POSTGRES_DB ?? 'mimi'}`,
      });

      const eventsRepo = new SyncEventsRepository(appPool);
      const conflictsRepo = new SyncConflictsRepository();
      const conflictDetector = new ConflictDetectorService(eventsRepo, conflictsRepo);
      const offlineAuth = new OfflineAuthService(
        new OfflineCredentialsRepository(),
        conflictsRepo,
        fakeConfig,
      );
      const reconciliation = new ReconciliationService(
        appPool,
        eventsRepo,
        conflictsRepo,
        new RegistryRepository(appPool),
      );
      const projectors = new SyncProjectorRegistry();

      const attendanceService = new AttendanceService(
        new StorageService(fakeStorageConfig(), ownerPool),
      );
      const attendanceProjector = new AttendanceSyncProjector(attendanceService);
      projectors.register(attendanceProjector);

      const syncEmit = new SyncEmitService(eventsRepo, conflictDetector);
      const leavesService = new LeavesService(
        new ApprovalService(new ApprovalsRepository()),
        syncEmit,
      );
      const leaveProjector = new LeaveSyncProjector(leavesService);
      projectors.register(leaveProjector);

      ingest = new SyncIngestService(
        eventsRepo,
        conflictDetector,
        offlineAuth,
        reconciliation,
        projectors,
      );
    } catch {
      dbAvailable = false;
    }
  });

  afterEach(async () => {
    if (!dbAvailable) return;
    for (const originId of createdOrigins) {
      await ownerPool.query(
        `DELETE FROM sync_conflicts WHERE loser_event_id IN (SELECT event_id FROM sync_events WHERE origin_device_id = $1) OR winner_event_id IN (SELECT event_id FROM sync_events WHERE origin_device_id = $1)`,
        [originId],
      );
      await ownerPool.query(`DELETE FROM sync_events WHERE origin_device_id = $1`, [originId]);
      await ownerPool.query(`DELETE FROM sync_batches WHERE origin_device_id = $1`, [originId]);
      await ownerPool.query(`DELETE FROM sync_cursors WHERE subscriber_id = $1`, [originId]);
    }
    createdOrigins.length = 0;
  });

  afterAll(async () => {
    await ownerPool?.end().catch(() => {});
  });

  function checkedInEvent(
    originDeviceId: string,
    actorUserId: string,
    occurredAt: string,
    clientId = randomUUID(),
  ): SyncEventEnvelope {
    return {
      eventId: formatUuidV7(Date.now(), randomBytes(16)),
      originTier: SyncOriginType.DEVICE,
      originDeviceId,
      locationId: fixtures.outletId,
      entity: 'attendance',
      entityId: randomUUID(),
      op: 'checked_in',
      payload: {
        v: 1,
        data: {
          clientId,
          locationId: fixtures.outletId,
          lat: String(fixtures.outletLat),
          lng: String(fixtures.outletLng),
          accuracyM: 8,
          selfieAttachmentId: fixtures.attachmentId,
          at: occurredAt,
        },
        meta: { actorUserId, actorRole: 'kasir', appVersion: '1.0.0' },
      },
      clientSeq: 1n,
      occurredAt,
      actorUserId,
      schemaV: 1,
    };
  }

  async function cleanAttendance(employeeId: string, clientId: string): Promise<void> {
    await ownerPool.query(
      'DELETE FROM attendance WHERE employee_id = $1 AND (client_id = $2 OR check_out_client_id = $2)',
      [employeeId, clientId],
    );
  }

  function todayWita(): string {
    return new Date(Date.now() + 8 * 60 * 60_000).toISOString().slice(0, 10);
  }
  function yesterdayWita(): string {
    return new Date(Date.now() + 8 * 60 * 60_000 - 24 * 60 * 60_000).toISOString().slice(0, 10);
  }

  /**
   * Seed data carries a REAL, already-committed attendance row for most
   * employees on most recent days (same fact `attendance.integration.spec
   * .ts`'s `withCleanSlate` works around) — `applyCheckIn` would otherwise
   * throw "already checked in today" against that pre-existing seed row,
   * not anything this test itself created. Clears it (owner pool, a real
   * commit — `SyncIngestService.ingestBatch` commits for real too, unlike
   * the OTHER spec files' rolled-back-transaction harness) for the
   * duration of the callback and restores it after, regardless of outcome.
   * A §6.4 `defensibleAt`-clamped claim can land on TODAY or YESTERDAY
   * depending on wall-clock time — clearing both keeps this deterministic.
   */
  async function withCleanSlate<T>(employeeId: string, fn: () => Promise<T>): Promise<T> {
    const dates = [todayWita(), yesterdayWita()];
    const existing = await Promise.all(dates.map((d) => deleteAttendanceForDate(employeeId, d)));
    try {
      return await fn();
    } finally {
      // QA-ATTENDANCE-LEAK: each `it()` here already calls `cleanAttendance` (by client_id) in its
      // OWN `finally` before this outer one runs, so in practice this is defense in depth — but
      // unconditionally clearing (employeeId, date) here too, rather than only when `existing[i]`
      // was non-null, means this harness no longer depends on every future test remembering that
      // inner cleanup. See `attendance.integration.spec.ts`'s `withCleanSlate` for the full story of
      // what happens when that assumption is skipped.
      for (const date of dates) await deleteAttendanceForDate(employeeId, date);
      for (const row of existing) if (row) await restoreAttendanceRow(row);
    }
  }

  it('a real offline check-in event, through real ingest, projects into a real attendance row with geofence + lateness derived', async () => {
    if (!dbAvailable) return;
    const employee =
      fixtures.usersByRole[RoleKey.KASIR] ?? fixtures.usersByRole[RoleKey.LEADER_OUTLET]!;
    const clientId = randomUUID();

    await withCleanSlate(employee.employeeId, async () => {
      const origin = freshOrigin();
      // A recent, honest occurredAt — well inside the offline window, not in the future.
      const occurredAt = new Date(Date.now() - 30 * 60_000).toISOString();
      const event = checkedInEvent(origin, employee.userId, occurredAt, clientId);

      try {
        const ack = await ingest.ingestBatch(batchOf([event]), resolveLocation);
        expect(ack.rejected).toEqual([]);
        expect(ack.acceptedThrough[origin]).toBe(1);

        const row = await ownerPool.query(
          `SELECT check_in_at, geofence_ok, check_in_distance_m, time_suspect, time_disputed, client_id FROM attendance WHERE employee_id = $1 AND client_id = $2`,
          [employee.employeeId, clientId],
        );
        expect(row.rows).toHaveLength(1);
        expect(row.rows[0].geofence_ok).toBe(true);
        expect(row.rows[0].time_suspect).toBe(false);
        expect(row.rows[0].time_disputed).toBe(false);
        expect(typeof row.rows[0].check_in_distance_m).toBe('number');
      } finally {
        await cleanAttendance(employee.employeeId, clientId);
      }
    });
  });

  it('a skewed-clock offline check-in (occurredAt far in the past) projects with time_suspect/time_disputed tagging, per SYNC-PROTOCOL §6.3/§6.4 — the same rule the online endpoint applies', async () => {
    if (!dbAvailable) return;
    const employee =
      fixtures.usersByRole[RoleKey.KASIR] ?? fixtures.usersByRole[RoleKey.LEADER_OUTLET]!;
    const clientId = randomUUID();

    await withCleanSlate(employee.employeeId, async () => {
      const origin = freshOrigin();
      // A device that has been offline for 3 days — an honest-but-very-late sync OR an adversarial
      // clock; either way §6.3's |offset| > 24h rule tags it, and §6.4 clamps the trusted instant.
      const occurredAt = new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString();
      const event = checkedInEvent(origin, employee.userId, occurredAt, clientId);

      try {
        const ack = await ingest.ingestBatch(batchOf([event]), resolveLocation);
        expect(ack.rejected).toEqual([]);

        const row = await ownerPool.query(
          `SELECT time_suspect, time_disputed, to_char(date, 'YYYY-MM-DD') AS date_text FROM attendance WHERE employee_id = $1 AND client_id = $2`,
          [employee.employeeId, clientId],
        );
        expect(row.rows).toHaveLength(1);
        expect(row.rows[0].time_suspect).toBe(true);
        expect(row.rows[0].time_disputed).toBe(true);
        // The projected business date is clamped near "now" — never the claimed 3-days-ago date, so
        // the row doesn't silently land somewhere a payroll operator would never look for it.
        expect(row.rows[0].date_text).not.toBe(occurredAt.slice(0, 10));
      } finally {
        await cleanAttendance(employee.employeeId, clientId);
      }
    });
  });

  it('replaying the identical batch does not double-project — exactly one attendance row', async () => {
    if (!dbAvailable) return;
    const employee =
      fixtures.usersByRole[RoleKey.KASIR] ?? fixtures.usersByRole[RoleKey.LEADER_OUTLET]!;
    const clientId = randomUUID();

    await withCleanSlate(employee.employeeId, async () => {
      const origin = freshOrigin();
      const occurredAt = new Date(Date.now() - 20 * 60_000).toISOString();
      const event = checkedInEvent(origin, employee.userId, occurredAt, clientId);

      try {
        await ingest.ingestBatch(batchOf([event]), resolveLocation);
        // Replay the IDENTICAL batch — `sync-ingest.service.ts` dedupes on `eventId` before ever
        // reaching the projector again (SyncProjectorRegistry's own idempotency guarantee), and
        // `applyCheckIn`'s `client_id` dedup is a second, independent line of defense.
        await ingest.ingestBatch(batchOf([event]), resolveLocation);

        const rows = await ownerPool.query(
          'SELECT id FROM attendance WHERE employee_id = $1 AND client_id = $2',
          [employee.employeeId, clientId],
        );
        expect(rows.rows).toHaveLength(1);
      } finally {
        await cleanAttendance(employee.employeeId, clientId);
      }
    });
  });

  it('an offline leave_requests.submitted fact, through real ingest, creates a real leave_requests row keyed by the DEVICE-minted entityId', async () => {
    if (!dbAvailable) return;
    const employee =
      fixtures.usersByRole[RoleKey.KASIR] ?? fixtures.usersByRole[RoleKey.LEADER_OUTLET]!;
    const origin = freshOrigin();
    const entityId = randomUUID();
    const clientId = randomUUID();

    const event: SyncEventEnvelope = {
      eventId: formatUuidV7(Date.now(), randomBytes(16)),
      originTier: SyncOriginType.DEVICE,
      originDeviceId: origin,
      locationId: fixtures.outletId,
      entity: 'leave_requests',
      entityId,
      op: 'submitted',
      payload: {
        v: 1,
        data: {
          clientId,
          type: LeaveType.PERMISSION,
          startDate: '2029-01-10',
          endDate: '2029-01-10',
          reason: 'Test offline',
        },
        meta: { actorUserId: employee.userId, actorRole: 'kasir', appVersion: '1.0.0' },
      },
      clientSeq: 1n,
      occurredAt: new Date().toISOString(),
      actorUserId: employee.userId,
      schemaV: 1,
    };

    try {
      const ack = await ingest.ingestBatch(batchOf([event]), resolveLocation);
      expect(ack.rejected).toEqual([]);

      const row = await ownerPool.query(
        'SELECT id, status, client_id FROM leave_requests WHERE id = $1',
        [entityId],
      );
      expect(row.rows).toHaveLength(1);
      expect(row.rows[0].status).toBe('pending');
      expect(row.rows[0].client_id).toBe(clientId);
    } finally {
      // Child-first: `leave_requests.approval_id` FKs to `approvals(id)` with NO cascade, so the
      // leave row must go before its approval — deleting `approvals` first (as this block originally
      // did) throws "violates foreign key constraint" instead of cleaning up. `approval_steps` DOES
      // cascade from `approvals` (CONTRACTS.md block 001-009), so no separate delete is needed for it.
      await ownerPool.query('DELETE FROM leave_requests WHERE id = $1', [entityId]);
      await ownerPool.query('DELETE FROM approvals WHERE document_id = $1', [entityId]);
    }
  });
});
