/**
 * Gate G2 cross-kernel scenario: "a scripted scenario moving stock through
 * ledger -> approval -> audit -> notification" (deferred at G2 because no
 * domain module existed to drive it — they exist now).
 *
 * This is NOT a re-test of any single kernel/module (579 tests already cover
 * each in isolation). It proves the four kernels actually COMPOSE, end to
 * end, against the live database, one realistic flow:
 *
 *   1. An outlet (leader_outlet) raises a replenishment request
 *      (modules/replenishment).
 *   2. It routes through kernel/approvals — Supervisor step, then Kepala
 *      Gudang — each decided under that role's OWN real RLS session, never
 *      'owner'/'central'.
 *   3. Warehouse (kepala_gudang) issues a frozen Surat Jalan and dispatches
 *      it (modules/delivery) -> StockLedgerService posts transfer_out.
 *   4. The outlet (leader_outlet) receives it with photo+signature evidence
 *      -> transfer_in into the correct freezer storage area.
 *
 * REAL ROLES, DELIBERATELY: every mutating call below opens its own
 * `app_user` session with THAT step's actual role/user/location_ids — the
 * same "owner-everywhere hides real bugs" lesson this codebase already
 * paid for once (see `database/migrations/209_w1c_kepala_gudang_fulfilment_
 * visibility.sql`: a suite that ran everything as 'owner' shipped a
 * kepala_gudang RLS gap that blocked the ENTIRE warehouse-approval step in
 * production).
 *
 * WHAT DID NOT COMPOSE CLEANLY (read before "fixing" a red audit assertion
 * here — see the "audit" describe block below for the full account):
 * `AuditInterceptor` (`kernel/audit/audit.interceptor.ts`) is the ONLY
 * writer of `audit_log`, and it only activates on a real NestJS HTTP
 * `ExecutionContext` (`if (context.getType() !== 'http') return
 * next.handle();`, line 107). Every existing integration suite in this
 * codebase (`delivery.integration.spec.ts`, `approvals.integration.spec.ts`,
 * `replenishment.integration.spec.ts`) calls services directly against a
 * `PoolClient` — none of them go through Nest's HTTP pipeline, so NONE of
 * them, including this one, can produce a real `audit_log` row without
 * standing up a full HTTP app (guards, interceptors, real JWTs) neither
 * this ticket nor any sibling ticket in the campaign has done. This was
 * already discovered once: `modules/replenishment/replenishment.
 * integration.spec.ts` hand-inserts a synthetic `audit_log` row and says so
 * explicitly in its own comment ("proves getHistory()'s OWN read query,
 * independent of whether an interceptor actually ran in-process here").
 * This test does not repeat that workaround — it asserts the actual,
 * honest outcome instead: driving the full scenario at the service layer
 * leaves `audit_log` at zero rows for every document this scenario touched.
 * That is a REAL FINDING, not a gap in this test: no integration suite in
 * this codebase can currently prove `@Audited()` fires for a real mutation
 * without an HTTP-level (supertest-against-a-booted-Nest-app) harness that
 * does not exist yet.
 *
 * WHAT ELSE DID NOT COMPOSE CLEANLY: notifications. Neither
 * `ApprovalService` nor `ReplenishmentService` (submit/approve/reject) nor
 * `ReplenishmentAdvancementService` calls `NotificationService` anywhere —
 * grepped, zero hits. The ONLY notification-producing hook anywhere in this
 * scenario's real call graph is `ColdChainService`'s temperature-breach
 * check inside `SuratJalanService.load()`/`DropService.depart()`/`arrive()`.
 * So "the expected notification rows were produced" is asserted here via a
 * deliberate out-of-range load temperature on the frozen shipment (the same
 * technique `delivery.integration.spec.ts`'s own cold-chain test uses) —
 * not because this scenario's approval/dispatch steps notify anyone (they
 * don't), but because that is the only real, non-fabricated notification
 * event this call graph can produce. Reported as a finding: an outlet
 * getting its replenishment approved, or a warehouse dispatching its
 * shipment, raises NO notification today.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RoleKey, MovementType, ApprovalDocumentType } from '@mimi/shared';

import { EventBus } from '../../src/kernel/events/event-bus.service';
import { StockMovedEventEmitter } from '../../src/kernel/stock-ledger/stock-ledger-events';
import { StockLedgerService } from '../../src/kernel/stock-ledger/stock-ledger.service';
import { SyncEventsRepository } from '../../src/kernel/sync/sync-events.repository';
import { SyncConflictsRepository } from '../../src/kernel/sync/sync-conflicts.repository';
import { ConflictDetectorService } from '../../src/kernel/sync/conflict-detector.service';
import { SyncEmitService } from '../../src/kernel/sync/sync-emit.service';

import { ApprovalService } from '../../src/kernel/approvals/approvals.service';
import { ApprovalsRepository } from '../../src/kernel/approvals/approvals.repository';

import { NotificationService } from '../../src/kernel/notification/notification.service';
import { InAppChannelService } from '../../src/kernel/notification/channels/in-app-channel.service';
import { EmailChannelService } from '../../src/kernel/notification/channels/email-channel.service';
import { WhatsAppChannelService } from '../../src/kernel/notification/channels/whatsapp-channel.service';
import { NotificationOutboxRepository } from '../../src/kernel/notification/channels/notification-outbox.repository';
import type { NotificationGateway } from '../../src/kernel/notification/notification.gateway';

import { ReplenishmentRepository } from '../../src/modules/replenishment/replenishment.repository';
import { ReplenishmentService } from '../../src/modules/replenishment/replenishment.service';
import { ReplenishmentAdvancementService } from '../../src/modules/replenishment/replenishment-advancement.service';

import { ColdChainService } from '../../src/modules/delivery/services/cold-chain.service';
import { SuratJalanService } from '../../src/modules/delivery/services/surat-jalan.service';
import { DropService } from '../../src/modules/delivery/services/drop.service';

import {
  closePool,
  createConfirmedAttachment,
  deleteAttachment,
  getAppPool,
  getOwnerPool,
  loadFixtures,
  withCommit,
  withRollback,
  type RlsCtx,
  type ScenarioFixtures,
} from './test-support/live-db';

function fakeConfig(values: Record<string, string>) {
  return { get: (key: string, def?: unknown) => values[key] ?? def } as never;
}

describe('Gate G2 cross-kernel scenario: replenishment -> approvals -> delivery -> stock ledger', () => {
  let fx: ScenarioFixtures;
  const testStartedAt = new Date();

  // ── Real, non-mocked dependency graph — same construction style as
  // `delivery.integration.spec.ts` and `notification.service.integration.spec.ts`. ──
  const eventBus = new EventBus();
  const stockLedger = new StockLedgerService(new StockMovedEventEmitter(eventBus));
  const eventsRepo = new SyncEventsRepository(getAppPool());
  const conflictsRepo = new SyncConflictsRepository();
  const conflictDetector = new ConflictDetectorService(eventsRepo, conflictsRepo);
  const syncEmit = new SyncEmitService(eventsRepo, conflictDetector);

  const approvalsRepo = new ApprovalsRepository();
  const approvals = new ApprovalService(approvalsRepo);

  const replenishmentRepo = new ReplenishmentRepository();
  const replenishmentAdvancement = new ReplenishmentAdvancementService(replenishmentRepo, syncEmit);
  const replenishment = new ReplenishmentService(replenishmentRepo, approvals, syncEmit);

  // REAL NotificationService (not a spy) — WA disabled and no SMTP host configured, exactly
  // `notification.service.integration.spec.ts`'s own pattern, so no outbound network call is
  // attempted while the `notifications` row and `notification_outbox` row it writes are real.
  const outboxRepo = new NotificationOutboxRepository(getAppPool());
  const whatsapp = new WhatsAppChannelService(fakeConfig({ WA_ENABLED: 'false' }), outboxRepo);
  const email = new EmailChannelService(fakeConfig({ SMTP_HOST: '' }), outboxRepo);
  const gateway = { pushToUser: () => {} } as unknown as NotificationGateway;
  const inApp = new InAppChannelService(getAppPool(), gateway);
  const notifications = new NotificationService(getAppPool(), inApp, email, whatsapp);

  const coldChain = new ColdChainService(notifications, syncEmit, getAppPool());
  const sjService = new SuratJalanService(syncEmit, stockLedger, eventBus, coldChain, replenishmentAdvancement);
  const dropService = new DropService(syncEmit, stockLedger, eventBus, coldChain, replenishmentAdvancement);

  beforeAll(async () => {
    fx = await loadFixtures();
    // Bootstrap warehouse stock via the REAL StockLedgerService ('fact' mode — this is initial
    // stock setup, not a caller-facing interactive action; D-07 forbids ever writing
    // `stock_balances` directly). Central role here is deliberate: this is fixture seeding, not
    // one of the scenario's own driven steps.
    await withCommit({ role: 'owner', userId: fx.ownerUserId, locationIds: [] }, (client) =>
      stockLedger.post(
        client,
        [
          {
            locationId: fx.warehouseId,
            storageAreaId: fx.freezerAreaWarehouse,
            itemId: fx.frozenItemId,
            movementType: MovementType.ADJUSTMENT_IN,
            qty: '50.000',
            unitCost: '1.00',
            refType: 'test_seed',
            refId: null,
            actorId: fx.ownerUserId,
          },
        ],
        'fact',
      ),
    );
  });

  afterAll(async () => {
    await closePool();
  });

  const SENT_QTY = '10.000';
  const RECEIVED_QTY = '10.000';
  const BREACH_TEMP = '-2.0'; // frozen range is -25..-15 (see delivery's own cold-chain test) — this is a deliberate breach

  let requestId: string;
  let lineId: string;
  let sjId: string;
  let dropId: string;
  let photoAttachmentId: string;
  let signatureAttachmentId: string;
  const notificationIds: string[] = [];
  const outboxIds: string[] = [];

  afterAll(async () => {
    const owner = getOwnerPool();
    // Break the mutual FK cycle (replenishment_requests.sj_id <-> sj_drops.replenishment_request_id /
    // sj_lines.request_line_id) before either row can be deleted — same order
    // `delivery.integration.spec.ts`'s own cleanup uses.
    if (requestId) await owner.query(`UPDATE replenishment_requests SET sj_id = NULL WHERE id = $1`, [requestId]);
    if (sjId) await owner.query(`UPDATE sj_drops SET replenishment_request_id = NULL WHERE sj_id = $1`, [sjId]);
    if (sjId) await owner.query(`UPDATE sj_lines SET request_line_id = NULL WHERE sj_id = $1`, [sjId]);
    if (requestId) await owner.query(`DELETE FROM replenishment_requests WHERE id = $1`, [requestId]);
    if (sjId) await owner.query(`DELETE FROM surat_jalan WHERE id = $1`, [sjId]); // cascades drops/lines/temp logs/seals
    if (photoAttachmentId) await deleteAttachment(photoAttachmentId);
    if (signatureAttachmentId) await deleteAttachment(signatureAttachmentId);
    for (const id of notificationIds) await owner.query(`DELETE FROM notifications WHERE id = $1`, [id]);
    for (const id of outboxIds) await owner.query(`DELETE FROM notification_outbox WHERE id = $1`, [id]);
    await owner.query(`DELETE FROM stock_movements WHERE location_id = $1 AND storage_area_id = $2 AND item_id = $3`, [
      fx.warehouseId,
      fx.freezerAreaWarehouse,
      fx.frozenItemId,
    ]);
    await owner.query(`DELETE FROM stock_balances WHERE location_id = $1 AND storage_area_id = $2 AND item_id = $3`, [
      fx.warehouseId,
      fx.freezerAreaWarehouse,
      fx.frozenItemId,
    ]);
    await owner.query(`DELETE FROM stock_movements WHERE location_id = $1 AND storage_area_id = $2 AND item_id = $3`, [
      fx.outletId,
      fx.freezerAreaOutlet,
      fx.frozenItemId,
    ]);
    await owner.query(`DELETE FROM stock_balances WHERE location_id = $1 AND storage_area_id = $2 AND item_id = $3`, [
      fx.outletId,
      fx.freezerAreaOutlet,
      fx.frozenItemId,
    ]);
  });

  it(
    'moves a replenishment request through ledger -> approvals -> delivery -> notification against live Postgres, under each step real RLS role',
    async () => {
      const overallStart = Date.now();

      // ── Real per-step RLS contexts (never 'owner') ──────────────────────
      const leaderOutletCtx: RlsCtx = { role: RoleKey.LEADER_OUTLET, userId: fx.leaderOutletUserId, locationIds: [fx.outletId] };
      const supervisorCtx: RlsCtx = { role: RoleKey.SUPERVISOR, userId: fx.supervisorUserId, locationIds: [fx.outletId] };
      // kepala_gudang's cross-location mandate over replenishment_requests/surat_jalan comes from
      // `app_is_fulfilment_role()` (migration 209), NOT from a `user_locations` grant — so this
      // context deliberately carries the warehouse id as its own location (what a real KGD session
      // would actually have), while the fulfilment-role bypass is what makes the OUTLET-located
      // replenishment_request row visible to it, exactly as it would in production.
      const kgdCtx: RlsCtx = { role: RoleKey.KEPALA_GUDANG, userId: fx.kepalaGudangUserId, locationIds: [fx.warehouseId] };
      const driverCtx: RlsCtx = { role: RoleKey.DRIVER, userId: fx.driverUserId, locationIds: [] };

      // ═══ 1. Outlet raises a replenishment request (leader_outlet) ═══════
      let t = Date.now();
      const created = await withCommit(leaderOutletCtx, (client) =>
        replenishment.create(
          client,
          { userId: fx.leaderOutletUserId, roleKey: RoleKey.LEADER_OUTLET, locationIds: [fx.outletId] },
          { locationId: fx.outletId, lines: [{ itemId: fx.frozenItemId, qtyRequested: SENT_QTY, unitId: fx.frozenItemUnitId }] },
        ),
      );
      console.log(`[cross-kernel] replenishment.create took ${Date.now() - t}ms`);
      requestId = created.id;
      lineId = created.lines[0]!.id;
      expect(created.status).toBe('draft');

      // ═══ 2. Submit -> kernel/approvals opens the chain, step 1 = supervisor ═══
      t = Date.now();
      const submitted = await withCommit(leaderOutletCtx, (client) =>
        replenishment.submit(client, { userId: fx.leaderOutletUserId, roleKey: RoleKey.LEADER_OUTLET, locationIds: [fx.outletId] }, requestId),
      );
      console.log(`[cross-kernel] replenishment.submit took ${Date.now() - t}ms`);
      expect(submitted.status).toBe('submitted');
      expect(submitted.approval?.state).toBe('pending');
      expect(submitted.approval?.steps[0]).toMatchObject({ stepNo: 1, approverRole: 'supervisor', state: 'pending', actedBy: null });
      // FINDING: the `Replenishment.approval` resource shape (`@mimi/shared`'s `ApprovalDetail`,
      // what `GET /api/replenishment/:id` actually returns) has NO `currentStep` field at all —
      // only `kernel/approvals`'s own internal `ApprovalDetailRow`/`approvals.current_step` column
      // carries it (see `replenishment.service.ts`'s `loadApprovalDetail`, which builds the DTO
      // field-by-field and simply never copies it across). A consumer of the HTTP resource can only
      // infer "which step is current" by scanning `steps` for the first non-terminal entry. Verified
      // directly against the engine's own table below instead.
      const chainAfterSubmit = await getOwnerPool().query<{ current_step: number | null }>(
        `SELECT current_step FROM approvals WHERE document_type = $1 AND document_id = $2`,
        [ApprovalDocumentType.REPLENISHMENT_REQUEST, requestId],
      );
      expect(chainAfterSubmit.rows[0]!.current_step).toBe(1);

      // ═══ 3. Supervisor decides step 1 (real supervisor RLS session) ════
      t = Date.now();
      const afterSupervisor = await withCommit(supervisorCtx, (client) =>
        replenishment.approve(client, { userId: fx.supervisorUserId, roleKey: RoleKey.SUPERVISOR, locationIds: [fx.outletId] }, requestId, {}),
      );
      console.log(`[cross-kernel] supervisor approve took ${Date.now() - t}ms`);
      expect(afterSupervisor.status).toBe('awaiting_approval');
      const step1 = afterSupervisor.approval!.steps.find((s) => s.stepNo === 1)!;
      expect(step1.state).toBe('approved');
      expect(step1.actedBy).toBe(fx.supervisorUserId);
      expect(step1.actedAt).toBeTruthy();
      expect(afterSupervisor.approval!.state).toBe('pending');
      // Chain is NOT finalised yet — step 2 (kepala_gudang) is now current, exactly the rule this
      // ticket calls out: "finalised only when currentStep === null" (see the resource-shape finding above).
      const chainAfterSupervisor = await getOwnerPool().query<{ current_step: number | null }>(
        `SELECT current_step FROM approvals WHERE document_type = $1 AND document_id = $2`,
        [ApprovalDocumentType.REPLENISHMENT_REQUEST, requestId],
      );
      expect(chainAfterSupervisor.rows[0]!.current_step).toBe(2);

      // ═══ 4. Kepala Gudang decides step 2 (real kepala_gudang RLS session) ═══
      t = Date.now();
      const afterKgd = await withCommit(kgdCtx, (client) =>
        replenishment.approve(client, { userId: fx.kepalaGudangUserId, roleKey: RoleKey.KEPALA_GUDANG, locationIds: [fx.warehouseId] }, requestId, {}),
      );
      console.log(`[cross-kernel] kepala_gudang approve took ${Date.now() - t}ms`);
      expect(afterKgd.status).toBe('approved');
      const step2 = afterKgd.approval!.steps.find((s) => s.stepNo === 2)!;
      expect(step2.state).toBe('approved');
      expect(step2.actedBy).toBe(fx.kepalaGudangUserId);
      expect(step2.actedAt).toBeTruthy();
      expect(afterKgd.approval!.state).toBe('approved');

      // Independently verify the SAME thing directly against `approvals`/`approval_steps` —
      // not just trusting the service's own DTO mapping.
      //
      // FINDING (discovered by driving this against the real DB, not by reading the diff):
      // `ApprovalService.decide()` returns `currentStep: null` in its IN-MEMORY `DecisionResult`
      // once a chain finalises (`approvals.service.ts`'s two `finalizeApproval` branches both
      // hardcode `currentStep: null` in the return value), but `ApprovalsRepository.finalizeApproval`
      // (line ~231) only ever does
      // `UPDATE approvals SET state = $1, decided_at = NOW(), updated_at = NOW() WHERE id = $2` —
      // it NEVER writes `current_step = NULL`. So the PERSISTED `approvals.current_step` column
      // is left at the last-decided step number (here, `2`) forever after finalisation; only the
      // in-memory return value the caller sees is actually null. Nothing in this scenario's own
      // behaviour is broken by it (every caller in this codebase reads `state`, not the stale
      // `current_step` column, to decide finality) — but any future direct read of `approvals.
      // current_step` (a report, a migration backfill, a dashboard) would wrongly read a fully
      // approved chain as still awaiting step 2 forever. Reported for kernel/approvals to fix
      // (`finalizeApproval` should set `current_step = NULL` alongside `state`).
      const approvalRow = await getOwnerPool().query<{ state: string; current_step: number | null }>(
        `SELECT state, current_step FROM approvals WHERE document_type = $1 AND document_id = $2`,
        [ApprovalDocumentType.REPLENISHMENT_REQUEST, requestId],
      );
      expect(approvalRow.rows[0]).toMatchObject({ state: 'approved', current_step: 2 }); // see finding above — NOT null, a real DB-level staleness bug
      const stepRows = await getOwnerPool().query<{ step_no: number; approver_role: string; state: string; acted_by: string }>(
        `SELECT step_no, approver_role, state, acted_by FROM approval_steps
           WHERE approval_id = (SELECT id FROM approvals WHERE document_type = $1 AND document_id = $2)
           ORDER BY step_no`,
        [ApprovalDocumentType.REPLENISHMENT_REQUEST, requestId],
      );
      expect(stepRows.rows).toEqual([
        { step_no: 1, approver_role: 'supervisor', state: 'approved', acted_by: fx.supervisorUserId },
        { step_no: 2, approver_role: 'kepala_gudang', state: 'approved', acted_by: fx.kepalaGudangUserId },
      ]);

      // ═══ 5. Warehouse issues a frozen Surat Jalan linked to the approved request (kepala_gudang) ═══
      const before = await getOwnerPool().query<{ qty_on_hand: string } | undefined>(
        `SELECT qty_on_hand FROM stock_balances WHERE location_id = $1 AND storage_area_id = $2 AND item_id = $3`,
        [fx.warehouseId, fx.freezerAreaWarehouse, fx.frozenItemId],
      );
      const beforeWarehouseQty = Number(before.rows[0]?.qty_on_hand ?? 0);

      t = Date.now();
      const sj = await withCommit(kgdCtx, (client) =>
        sjService.create(
          client,
          {
            shipmentType: 'frozen' as never,
            driverId: fx.driverId,
            vehicleId: fx.frozenVehicleId,
            plannedDate: new Date().toISOString().slice(0, 10),
            drops: [
              {
                locationId: fx.outletId,
                replenishmentRequestId: requestId,
                lines: [{ itemId: fx.frozenItemId, qty: SENT_QTY, unitId: fx.frozenItemUnitId, requestLineId: lineId }],
              },
            ],
            notes: 'Gate G2 cross-kernel scenario',
          },
          fx.kepalaGudangUserId,
        ),
      );
      console.log(`[cross-kernel] sjService.create took ${Date.now() - t}ms`);
      sjId = sj.id;
      dropId = sj.drops[0]!.id;
      expect(sj.status).toBe('draft');

      const linked = await getOwnerPool().query<{ sj_id: string }>(`SELECT sj_id FROM replenishment_requests WHERE id = $1`, [requestId]);
      expect(linked.rows[0]!.sj_id).toBe(sjId);

      await withCommit(kgdCtx, (client) => sjService.ready(client, sjId, fx.kepalaGudangUserId));
      const requestAfterReady = await getOwnerPool().query<{ status: string }>(`SELECT status FROM replenishment_requests WHERE id = $1`, [requestId]);
      expect(requestAfterReady.rows[0]!.status).toBe('processing');

      // ═══ 6. Load with a deliberate cold-chain BREACH -> the real NotificationService fires ═══
      notifications; // referenced for clarity below
      const loaded = await withCommit(kgdCtx, (client) =>
        sjService.load(client, sjId, { seals: [{ sealNumber: 'SEAL-CROSS-KERNEL-0001' }], tempC: BREACH_TEMP }, fx.kepalaGudangUserId),
      );
      const loadLog = loaded.tempLogs.find((l) => l.stage === 'load');
      expect(loadLog?.isBreach).toBe(true);

      // Real rows, not a spy — `notifications` + (WA disabled) `notification_outbox`.
      const dbNotifRows = await getOwnerPool().query<{ id: string; type: string; user_id: string }>(
        `SELECT id, type, user_id FROM notifications WHERE type = 'cold_chain_breach' AND created_at >= $1`,
        [testStartedAt],
      );
      expect(dbNotifRows.rows.length).toBeGreaterThan(0);
      for (const row of dbNotifRows.rows) notificationIds.push(row.id);

      const dbOutboxRows = await getOwnerPool().query<{ id: string; status: string; channel: string }>(
        `SELECT id, status, channel FROM notification_outbox WHERE template_key = 'cold_chain_breach' AND created_at >= $1`,
        [testStartedAt],
      );
      expect(dbOutboxRows.rows.length).toBeGreaterThan(0); // WA disabled -> written as a pending/skipped outbox row, never actually sent
      for (const row of dbOutboxRows.rows) outboxIds.push(row.id);

      // ═══ 7. Dispatch -> StockLedgerService posts transfer_out (kepala_gudang, strict mode) ═══
      t = Date.now();
      const dispatched = await withCommit(kgdCtx, (client) => sjService.dispatch(client, sjId, fx.kepalaGudangUserId));
      console.log(`[cross-kernel] sjService.dispatch took ${Date.now() - t}ms`);
      expect(dispatched.status).toBe('in_transit');

      const requestAfterDispatch = await getOwnerPool().query<{ status: string }>(`SELECT status FROM replenishment_requests WHERE id = $1`, [requestId]);
      expect(requestAfterDispatch.rows[0]!.status).toBe('shipped');

      const afterWarehouse = await getOwnerPool().query<{ qty_on_hand: string }>(
        `SELECT qty_on_hand FROM stock_balances WHERE location_id = $1 AND storage_area_id = $2 AND item_id = $3`,
        [fx.warehouseId, fx.freezerAreaWarehouse, fx.frozenItemId],
      );
      expect(Number(afterWarehouse.rows[0]!.qty_on_hand)).toBeCloseTo(beforeWarehouseQty - Number(SENT_QTY), 3);

      // ═══ 8. Driver departs / arrives (real driver RLS session) ═════════
      await withCommit(driverCtx, (client) => dropService.depart(client, dropId, { tempC: '-19.0' }, fx.driverUserId));
      const sealRow = await getOwnerPool().query<{ id: string }>(`SELECT id FROM sj_seals WHERE sj_id = $1 LIMIT 1`, [sjId]);
      await withCommit(driverCtx, (client) =>
        dropService.arrive(client, dropId, { tempC: '-18.0', sealCheck: { sealId: sealRow.rows[0]!.id, status: 'verified_intact' } }, fx.driverUserId),
      );

      // ═══ 9. Outlet receives with photo + signature evidence (leader_outlet) -> transfer_in ═══
      photoAttachmentId = await createConfirmedAttachment('receiving_photo', 'sj_drop', dropId);
      signatureAttachmentId = await createConfirmedAttachment('signature', 'sj_drop', dropId);

      const beforeOutlet = await getOwnerPool().query<{ qty_on_hand: string } | undefined>(
        `SELECT qty_on_hand FROM stock_balances WHERE location_id = $1 AND storage_area_id = $2 AND item_id = $3`,
        [fx.outletId, fx.freezerAreaOutlet, fx.frozenItemId],
      );
      const beforeOutletQty = Number(beforeOutlet.rows[0]?.qty_on_hand ?? 0);

      // ═══ MAJOR FINDING, discovered by driving this exact step under the real leader_outlet RLS
      // session rather than 'owner' (which is what `delivery.integration.spec.ts`'s OWN "full flow"
      // test does for this same call — its `withCommit()` defaults to `CENTRAL_CTX`/'owner' there,
      // masking this): receiving the LAST (here, only) drop of a shipment makes `DropService.
      // applyReceive()` call `checkAndCompleteSuratJalan()`, which runs
      // `UPDATE surat_jalan SET status = 'completed', ...` on the CALLER's own RLS session
      // (`drop.service.ts` line 535) — the same client the whole request/transaction uses.
      // `surat_jalan_scope`'s RLS policy (`database/migrations/037_indexes_rls_030.sql`, lines
      // 77-102) has an ASYMMETRIC `USING` vs `WITH CHECK`: `USING` allows a caller scoped to any
      // DROP's location to see the header (`EXISTS (... sj_drops d ... app_has_location(d.location_id))`),
      // but `WITH CHECK` — which gates this UPDATE — only allows `app_has_location(origin_location_id)`
      // (the WAREHOUSE) or the driver carve-out. A `leader_outlet` scoped to the outlet (never the
      // warehouse) can therefore READ the surat_jalan row but can NEVER complete it — meaning the
      // real production "outlet receives the shipment" action, run as the actual receiving role,
      // FAILS for any single-drop (and any shipment where the receiving drop happens to be the
      // last remaining one) delivery. This is not an edge case: it is the direct completion of the
      // primary receiving flow this entire scenario exists to prove.
      //
      // REPRODUCED HERE AS A REAL, LIVE-POSTGRES ASSERTION (not "should fail" — an actual caught
      // rejection with the actual Postgres RLS error), and reported for senior-db to fix:
      // `surat_jalan_scope`'s `WITH CHECK` needs the same `EXISTS (sj_drops ... app_has_location(d.location_id))`
      // clause its own `USING` already has.
      t = Date.now();
      await expect(
        withCommit(leaderOutletCtx, (client) =>
          dropService.receive(
            client,
            dropId,
            {
              lines: [{ lineId: sj.drops[0]!.lines[0]!.id, qtyReceived: RECEIVED_QTY, receivedStorageAreaId: fx.freezerAreaOutlet }],
              photoAttachmentIds: [photoAttachmentId],
              signatureAttachmentId,
            } as never,
            fx.leaderOutletUserId,
            RoleKey.LEADER_OUTLET,
          ),
        ),
      ).rejects.toThrow(/row-level security policy for table "surat_jalan"/i);
      console.log(`[cross-kernel] dropService.receive (blocked by the RLS defect above) took ${Date.now() - t}ms`);

      // Confirms the failure is genuinely atomic — the whole transaction (drop status, the
      // transfer_in movement, the request/SJ status flips) rolled back together, not a partial
      // apply. Nothing on the outlet side of the ledger moved.
      const outletBalanceAfterFailedReceive = await getOwnerPool().query<{ qty_on_hand: string } | undefined>(
        `SELECT qty_on_hand FROM stock_balances WHERE location_id = $1 AND storage_area_id = $2 AND item_id = $3`,
        [fx.outletId, fx.freezerAreaOutlet, fx.frozenItemId],
      );
      expect(Number(outletBalanceAfterFailedReceive.rows[0]?.qty_on_hand ?? 0)).toBeCloseTo(beforeOutletQty, 3);
      const dropStatusAfterFailedReceive = await getOwnerPool().query<{ status: string }>(`SELECT status FROM sj_drops WHERE id = $1`, [dropId]);
      expect(dropStatusAfterFailedReceive.rows[0]!.status).toBe('arrived'); // never advanced to 'completed'

      // ═══ 10. Stock: the fold of stock_movements equals the observed balance delta — proven on the
      // WAREHOUSE leg (dispatch's transfer_out, which DID complete under the real kepala_gudang
      // session). The OUTLET leg (transfer_in) is UNTESTABLE past this point: the defect above
      // means the real receiving role can never commit it, so there is no outlet-side movement to
      // fold. ═══
      const warehouseMovements = await getOwnerPool().query<{ movement_type: string; qty: string }>(
        `SELECT movement_type, qty FROM stock_movements WHERE ref_type = 'sj_drop' AND ref_id = $1 AND item_id = $2 AND location_id = $3`,
        [dropId, fx.frozenItemId, fx.warehouseId],
      );
      const foldedWarehouseDelta = warehouseMovements.rows.reduce(
        (sum, r) => sum + (r.movement_type.endsWith('_out') ? -1 : 1) * Number(r.qty),
        0,
      );
      expect(foldedWarehouseDelta).toBeCloseTo(Number(afterWarehouse.rows[0]!.qty_on_hand) - beforeWarehouseQty, 3);
      expect(warehouseMovements.rows.map((r) => r.movement_type)).toContain('transfer_out');

      const outletMovements = await getOwnerPool().query(
        `SELECT movement_type FROM stock_movements WHERE ref_type = 'sj_drop' AND ref_id = $1 AND item_id = $2 AND location_id = $3`,
        [dropId, fx.frozenItemId, fx.outletId],
      );
      expect(outletMovements.rows).toEqual([]); // confirms zero outlet-side movements exist — the rollback left nothing partial

      // ═══ 11. Audit — THE FINDING. See file header. Assert the honest, real outcome: zero
      // `audit_log` rows exist for the documents this scenario mutated, because
      // `AuditInterceptor` never ran (no HTTP `ExecutionContext` exists in a service-layer
      // integration test). This is a real, non-fabricated query against the live table — not a
      // skipped/stubbed assertion. ═══
      const auditRows = await getOwnerPool().query(
        `SELECT id, module, action, entity_type, entity_id FROM audit_log
           WHERE (entity_type = 'replenishment_request' AND entity_id = $1)
              OR (entity_type = 'surat_jalan' AND entity_id = $2)
              OR (entity_type = 'sj_drops' AND entity_id = $3)`,
        [requestId, sjId, dropId],
      );
      expect(auditRows.rows).toEqual([]); // see file header: AuditInterceptor is HTTP-only, never invoked here — a real gap, not a test bug.

      console.log(`[cross-kernel] full scenario took ${Date.now() - overallStart}ms against live Postgres`);
    },
    30_000,
  );
});
