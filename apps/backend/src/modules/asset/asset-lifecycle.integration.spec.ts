import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import type { ConfigService } from '@nestjs/config';
import { AssetCondition, RoleKey } from '@mimi/shared';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';
import { SyncEventsRepository } from '../../kernel/sync/sync-events.repository';
import { ConflictDetectorService } from '../../kernel/sync/conflict-detector.service';
import { SyncConflictsRepository } from '../../kernel/sync/sync-conflicts.repository';
import { StorageService } from '../../kernel/storage/storage.service';
import { NotificationService } from '../../kernel/notification/notification.service';
import { NotificationGateway } from '../../kernel/notification/notification.gateway';
import { InAppChannelService } from '../../kernel/notification/channels/in-app-channel.service';
import { EmailChannelService } from '../../kernel/notification/channels/email-channel.service';
import { WhatsAppChannelService } from '../../kernel/notification/channels/whatsapp-channel.service';
import { NotificationOutboxRepository } from '../../kernel/notification/channels/notification-outbox.repository';
import { TokenService } from '../../common/jwt/token.service';
import { EventBus } from '../../kernel/events/event-bus.service';
import { PaymentVerificationsService } from '../accounting/payment-verifications.service';
import { AssetsService } from './assets.service';
import { pgDateToIso } from './pg-date.util';
import { SchedulesService } from './schedules.service';
import { JobsService } from './jobs.service';
import { MaintenanceDueSweepService } from './maintenance-due-sweep.service';
import {
  appConnectionString,
  closePool,
  createAsset,
  createAttachment,
  deleteAsset,
  deleteAttachment,
  deletePaymentVerificationsForRef,
  loadFixtures,
  serverToday,
  withRollbackAs,
  type Fixtures,
} from './test-support/live-db';

/** Minimal `ConfigService` stand-in — every constructor below only calls `.get(key, default)`; no NestJS DI container is spun up (matches `modules/hr/leaves/leaves.integration.spec.ts`'s manual-construction pattern). */
const stubConfig = {
  get: (key: string, def?: unknown) => process.env[key] ?? def,
} as unknown as ConfigService;

/**
 * Full asset lifecycle proof against the LIVE database (this ticket's
 * explicit deliverable): create asset -> create schedule -> sweep creates a
 * due job -> complete the job with proof -> service_history appended ->
 * verify the job.
 *
 * DURABLE COMMITS, DELIBERATELY (not `withRollback`'s usual isolation): the
 * sweep step (`MaintenanceDueSweepService.runSweep()`) opens its OWN pool
 * connection (`withSystemContext`, exactly as production does — it has no
 * request to borrow a client from). A different Postgres backend cannot see
 * another backend's UNCOMMITTED writes, so the schedule created in an
 * earlier step must be genuinely committed before the sweep can find it.
 * Every service call below still runs `withRollbackAs` — but each mutating
 * service method (`create`/`update`/`complete`/...) calls `withWrite()`
 * internally, which COMMITs the whole transaction on that shared client
 * (the same "nested BEGIN, one real COMMIT" mechanism `RlsCleanupInterceptor`
 * documents for production) — so the point isn't lost, it's absorbed into
 * the existing pattern. Every row this test creates is deleted in `afterAll`
 * via the owner pool (matching `createWasteRecord`-style fixture cleanup).
 */
describe('asset lifecycle (integration, live Postgres)', () => {
  let fixtures: Fixtures;
  let dbAvailable = true;

  let assetsService: AssetsService;
  let schedulesService: SchedulesService;
  let jobsService: JobsService;
  let sweep: MaintenanceDueSweepService;

  let assetId: string | null = null;
  let attachmentIds: string[] = [];
  let scheduleId: string | null = null;
  let jobId: string | null = null;

  beforeAll(async () => {
    try {
      fixtures = await loadFixtures();
      if (!fixtures.usersByRole[RoleKey.SUPERVISOR] || !fixtures.usersByRole[RoleKey.OWNER]) {
        dbAvailable = false;
        return;
      }

      const pool = new Pool({ connectionString: appConnectionString() });
      await pool.query('SELECT 1');

      const eventsRepo = new SyncEventsRepository(pool);
      const conflictDetector = new ConflictDetectorService(
        eventsRepo,
        new SyncConflictsRepository(),
      );
      const syncEmit = new SyncEmitService(eventsRepo, conflictDetector);

      const outbox = new NotificationOutboxRepository(pool);
      const gateway = new NotificationGateway(new TokenService(stubConfig));
      const inApp = new InAppChannelService(pool, gateway);
      const email = new EmailChannelService(stubConfig, outbox);
      const whatsapp = new WhatsAppChannelService(stubConfig, outbox);
      const notifications = new NotificationService(pool, inApp, email, whatsapp);

      const storage = new StorageService(stubConfig); // onModuleInit never called — no MinIO bucket check needed for presign-only use in this suite.
      const paymentVerifications = new PaymentVerificationsService(syncEmit, new EventBus());

      assetsService = new AssetsService(storage, syncEmit);
      schedulesService = new SchedulesService(syncEmit);
      jobsService = new JobsService(storage, syncEmit, paymentVerifications);
      sweep = new MaintenanceDueSweepService(pool, syncEmit, notifications);

      assetId = await createAsset(fixtures.outletId);
    } catch {
      dbAvailable = false;
    }
  });

  afterAll(async () => {
    // Order matters: `maintenance_jobs.payment_verification_id` FK-references `payment_verifications`
    // (`fk_mj_pv`) — the job row (deleted by `deleteAsset`'s cascade) must go first, or deleting the
    // PV row alone 409s on that FK.
    for (const id of attachmentIds) await deleteAttachment(id);
    if (assetId) await deleteAsset(assetId);
    if (jobId) await deletePaymentVerificationsForRef(jobId);
    await closePool();
  });

  it('FR-PMS-01/FR-PMS-02/FR-PMS-03 — runs the full asset -> schedule -> due job -> complete -> verify chain', async () => {
    if (!dbAvailable || !assetId) return;
    const supervisor = fixtures.usersByRole[RoleKey.SUPERVISOR]!;
    const owner = fixtures.usersByRole[RoleKey.OWNER]!;
    const spvCtx = {
      role: RoleKey.SUPERVISOR,
      userId: supervisor,
      locationIds: [fixtures.outletId],
    };
    const ownerCtx = { role: RoleKey.OWNER, userId: owner, locationIds: [] };
    const today = await serverToday(); // anchor to the DB's own CURRENT_DATE — see `serverToday()`'s doc comment.

    // ── 1. create schedule ──────────────────────────────────────────────
    const schedule = await withRollbackAs(spvCtx, (client) =>
      schedulesService.create(
        client,
        supervisor,
        fixtures.outletId,
        assetId!,
        {
          name: 'Ganti Oli',
          intervalType: 'days',
          intervalValue: 90,
          nextDueAt: today,
          reminderDaysBefore: 7,
        },
        {
          sub: supervisor,
          username: 'spv',
          roleKey: RoleKey.SUPERVISOR,
          locationIds: [fixtures.outletId],
        },
        [fixtures.outletId],
      ),
    );
    scheduleId = schedule.id;
    expect(schedule.nextDueAt).toBe(today);
    expect(schedule.lastDoneAt).toBeNull();

    // ── 2. sweep creates the due job + notifies ─────────────────────────
    await sweep.runSweep();

    const jobRow = await withRollbackAs(ownerCtx, (client) =>
      client.query<{ id: string; status: string; type: string }>(
        `SELECT id, status, type FROM maintenance_jobs WHERE schedule_id = $1`,
        [scheduleId],
      ),
    );
    expect(jobRow.rows.length).toBe(1);
    expect(jobRow.rows[0]!.status).toBe('due');
    expect(jobRow.rows[0]!.type).toBe('scheduled');
    jobId = jobRow.rows[0]!.id;

    // Re-running the sweep must NOT create a second job for the same cycle (idempotent).
    await sweep.runSweep();
    const jobRowAfterSecondSweep = await withRollbackAs(ownerCtx, (client) =>
      client.query<{ id: string }>(`SELECT id FROM maintenance_jobs WHERE schedule_id = $1`, [
        scheduleId,
      ]),
    );
    expect(jobRowAfterSecondSweep.rows.length).toBe(1);

    // ── 3. start the job ────────────────────────────────────────────────
    const started = await withRollbackAs(spvCtx, (client) =>
      jobsService.start(
        client,
        jobId!,
        {
          sub: supervisor,
          username: 'spv',
          roleKey: RoleKey.SUPERVISOR,
          locationIds: [fixtures.outletId],
        },
        [fixtures.outletId],
      ),
    );
    expect(started.status).toBe('in_progress');

    // ── 4. complete with proof (>=1 attachment, FR-PMS-04) ──────────────
    const att1 = await createAttachment(supervisor);
    const att2 = await createAttachment(supervisor);
    attachmentIds = [att1, att2];

    const completed = await withRollbackAs(spvCtx, (client) =>
      jobsService.complete(
        client,
        supervisor,
        jobId!,
        {
          proofAttachmentIds: [att1, att2],
          cost: '150000.00',
          vendor: 'PT Servis Motor',
          conditionAfter: AssetCondition.GOOD,
          notes: 'Ganti oli selesai',
        },
        {
          sub: supervisor,
          username: 'spv',
          roleKey: RoleKey.SUPERVISOR,
          locationIds: [fixtures.outletId],
        },
        [fixtures.outletId],
      ),
    );
    expect(completed.status).toBe('done');
    expect(completed.cost).toBe('150000.00');
    expect(completed.proofUrls.length).toBe(2);

    // schedule rolled forward: last_done_at = today, next_due_at = old next_due_at + 90 days
    const scheduleAfter = await withRollbackAs(ownerCtx, (client) =>
      client.query<{ last_done_at: Date; next_due_at: Date }>(
        `SELECT last_done_at, next_due_at FROM maintenance_schedules WHERE id = $1`,
        [scheduleId],
      ),
    );
    const expectedNextDue = new Date(`${today}T00:00:00.000Z`);
    expectedNextDue.setUTCDate(expectedNextDue.getUTCDate() + 90);
    expect(pgDateToIso(scheduleAfter.rows[0]!.last_done_at)).toBe(today);
    expect(pgDateToIso(scheduleAfter.rows[0]!.next_due_at)).toBe(
      expectedNextDue.toISOString().slice(0, 10),
    );

    // service_history appended
    const historyRes = await withRollbackAs(ownerCtx, (client) =>
      jobsService.history(
        client,
        fixtures.outletId,
        assetId!,
        1,
        10,
        { sub: owner, username: 'owner', roleKey: RoleKey.OWNER, locationIds: [] },
        null,
      ),
    );
    expect(historyRes.total).toBe(1);
    expect(historyRes.rows[0]!.vendor).toBe('PT Servis Motor');
    expect(historyRes.rows[0]!.cost).toBe('150000.00');
    expect(historyRes.rows[0]!.conditionAfter).toBe('good');
    expect(historyRes.rows[0]!.proofUrls.length).toBe(2);

    // cost > 0 opened a pending payment_verifications row (FR-ACCT-04)
    const pvRes = await withRollbackAs(ownerCtx, (client) =>
      client.query<{ status: string; ref_type: string; amount: string }>(
        `SELECT status, ref_type, amount FROM payment_verifications WHERE ref_id = $1`,
        [jobId],
      ),
    );
    expect(pvRes.rows.length).toBe(1);
    expect(pvRes.rows[0]!.status).toBe('pending');
    expect(pvRes.rows[0]!.ref_type).toBe('maintenance_job');
    expect(pvRes.rows[0]!.amount).toBe('150000.00');

    // ── 5. verify ────────────────────────────────────────────────────────
    const verified = await withRollbackAs(ownerCtx, (client) =>
      jobsService.verify(
        client,
        owner,
        jobId!,
        { note: 'Sudah dicek' },
        { sub: owner, username: 'owner', roleKey: RoleKey.OWNER, locationIds: [] },
        [],
      ),
    );
    expect(verified.status).toBe('verified');

    // ── 6. asset detail reflects the outcome: condition synced, no open jobs left, schedule visible ──
    const detail = await withRollbackAs(ownerCtx, (client) =>
      assetsService.getById(
        client,
        assetId!,
        { sub: owner, username: 'owner', roleKey: RoleKey.OWNER, locationIds: [] },
        null,
      ),
    );
    expect(detail.condition).toBe('good'); // was seeded 'fair'; complete()'s conditionAfter synced it.
    expect(detail.openJobs.find((j) => j.id === jobId)).toBeUndefined(); // 'verified' is terminal, not open.
    expect(detail.schedules.some((s) => s.id === scheduleId)).toBe(true);
  });
});
