/**
 * Integration suite for M10 `delivery` — genuinely hits Postgres (BUILD-PLAN
 * §8, and the campaign-wide standing instruction after a sibling module
 * shipped 27 "passing" tests that were all `expect(true).toBe(true)`). Every
 * service here is constructed with its REAL dependencies (`StockLedgerService`,
 * a REAL `SyncEmitService` wired to the live `sync_events` table, the REAL
 * `ReplenishmentAdvancementService` W3-06 built) — the only fake is
 * `NotificationService` (a spy), because verifying SMTP/WhatsApp channel
 * wiring is kernel/notification's own test territory, not this module's;
 * every notification CALL (template, params, recipients) is still asserted.
 *
 * Two-pool split (`test-support/live-db.ts`, mirroring
 * `kernel/approvals`'s): `getOwnerPool()` for fixture setup/teardown only,
 * `getAppPool()` (`mimi_app`) for every call under test, with the exact
 * `SET LOCAL ROLE app_user` + session-var sequence `RlsContextGuard` issues
 * for a real request. This suite requires a reachable, migrated + seeded
 * Postgres (`pnpm db:migrate && pnpm db:seed`) — it does not skip quietly;
 * a missing DB fails loudly, the same discipline the D-22 regression spec
 * established.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { ERR_VALIDATION, MovementType, RoleKey, SyncOriginType } from '@mimi/shared';
import { formatUuidV7, type SyncPushBatch } from '@mimi/sync-protocol';

// Measured, not assumed (docs/PROGRESS.md's "Test flakiness under load" class):
// isolated + repeated full-run timing showed every test in this file completing
// in well under 250ms (the three affected here: 83ms/142ms/217ms) — the
// `Test timed out in 5000ms` failures seen in a full 109-file run are contention
// on the ONE shared Postgres instance (this repo's own house rule: the DB is
// shared with other agents' concurrent backend suites too), not slow logic.
// Same precedent already used by a dozen sibling integration specs (grep
// `vi.setConfig({ testTimeout` across `src/modules/**`) — raising the ceiling
// here keeps the assertions themselves unchanged and meaningful; it does not
// paper over a real hang (nothing here loops or waits on an external system).
vi.setConfig({ testTimeout: 20_000 });

import { EventBus } from '../../kernel/events/event-bus.service';
import { StockMovedEventEmitter } from '../../kernel/stock-ledger/stock-ledger-events';
import { StockLedgerService } from '../../kernel/stock-ledger/stock-ledger.service';
import { SyncEventsRepository } from '../../kernel/sync/sync-events.repository';
import { SyncConflictsRepository } from '../../kernel/sync/sync-conflicts.repository';
import { OfflineCredentialsRepository } from '../../kernel/sync/offline-credentials.repository';
import { RegistryRepository } from '../../kernel/sync/registry.repository';
import { ConflictDetectorService } from '../../kernel/sync/conflict-detector.service';
import { OfflineAuthService } from '../../kernel/sync/offline-auth.service';
import { ReconciliationService } from '../../kernel/sync/reconciliation.service';
import { SyncIngestService } from '../../kernel/sync/sync-ingest.service';
import { SyncProjectorRegistry } from '../../kernel/sync/sync-projector-registry.service';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';
import type { NotificationService } from '../../kernel/notification/notification.service';

import { ReplenishmentRepository } from '../replenishment/replenishment.repository';
import { ReplenishmentAdvancementService } from '../replenishment/replenishment-advancement.service';

import { ColdChainService } from './services/cold-chain.service';
import { SuratJalanService } from './services/surat-jalan.service';
import { DropService } from './services/drop.service';
import { GoodsReceiptService } from './services/goods-receipt.service';
import { DeliverySyncProjector } from './services/delivery-sync-projector.service';
import { RouteService } from './services/route.service';

import {
  closePool,
  createConfirmedAttachment,
  createReplenishmentRequestFixture,
  deleteAttachment,
  deleteGoodsReceipt,
  deleteReplenishmentRequest,
  deleteSuratJalan,
  getAppPool,
  getOwnerPool,
  loadFixtures,
  readReplenishmentRequestStatus,
  resetStockKey,
  withCommit,
  withRollback,
  type Fixtures,
} from './test-support/live-db';

describe('M10 delivery — live-DB regression: mimi_app has zero direct table grants', () => {
  it('a bare app-pool client with NO SET LOCAL ROLE fails LOUDLY (permission denied) on the exact users/roles/user_locations query ColdChainService.resolveBreachRecipients issues — this is why that method exists as system-context.ts, not a bare this.pool.query()', async () => {
    const client = await getAppPool().connect();
    try {
      await expect(
        client.query(
          `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.key IN ('owner', 'manager')`,
        ),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      client.release();
    }
  });

  // Deliberately NO `closePool()` here — `getAppPool()`/`getOwnerPool()` are process-wide singletons
  // shared with the OTHER describe block below in this same file; ending them here would leave that
  // block's services holding a dead pool. Exactly one `afterAll(closePool)` exists in this file, at the
  // very end, after every describe that touches the database.
});

describe('M10 delivery — live DB integration', () => {
  let fixtures: Fixtures;

  const eventBus = new EventBus();
  const stockLedger = new StockLedgerService(new StockMovedEventEmitter(eventBus));
  const eventsRepo = new SyncEventsRepository(getAppPool());
  const conflictsRepo = new SyncConflictsRepository();
  const conflictDetector = new ConflictDetectorService(eventsRepo, conflictsRepo);
  const syncEmit = new SyncEmitService(eventsRepo, conflictDetector);

  const notifySpy = vi.fn().mockResolvedValue({ inApp: [], email: [], whatsapp: [] });
  const fakeNotifications = { notify: notifySpy } as unknown as NotificationService;

  const coldChain = new ColdChainService(fakeNotifications, syncEmit, getAppPool());
  const replenishmentRepo = new ReplenishmentRepository();
  const replenishment = new ReplenishmentAdvancementService(replenishmentRepo, syncEmit);

  const sjService = new SuratJalanService(
    syncEmit,
    stockLedger,
    eventBus,
    coldChain,
    replenishment,
  );
  const dropService = new DropService(syncEmit, stockLedger, eventBus, coldChain, replenishment);
  const goodsReceiptService = new GoodsReceiptService(stockLedger, syncEmit);
  const routeService = new RouteService();

  beforeAll(async () => {
    fixtures = await loadFixtures();
  });

  afterAll(async () => {
    await closePool();
  });

  /**
   * The live seed carries realistic (often ZERO) balances for any given
   * `(location, area, item)` key — `dispatch()`'s `transfer_out` is
   * deliberately `'strict'` mode (D-17a: an online/interactive caller must
   * never issue stock the warehouse doesn't have), so this suite seeds
   * enough warehouse stock via the REAL `StockLedgerService` (never a direct
   * `stock_balances` write — D-07) before any test that dispatches an SJ.
   * `'fact'` mode is used here only because this is bootstrap-style initial
   * stock, not a caller-facing interactive action.
   */
  async function seedWarehouseStock(itemId: string, areaId: string, qty: string): Promise<void> {
    await withCommit((client) =>
      stockLedger.post(
        client,
        [
          {
            locationId: fixtures.warehouseId,
            storageAreaId: areaId,
            itemId,
            movementType: MovementType.ADJUSTMENT_IN,
            qty,
            unitCost: '1.00',
            refType: 'test_seed',
            refId: null,
            actorId: fixtures.usersByRole[RoleKey.OWNER],
          },
        ],
        'fact',
      ),
    );
  }

  // ── FR-LOG-02: frozen vs dry separation ──────────────────────────────────

  describe('FR-LOG-02 frozen/dry separation', () => {
    /**
     * Fixed far-future date for the two DRY cases below, rather than
     * `new Date()` — for the reason `ROUTE_TEST_DATE` documents further down.
     *
     * Both assert the ITEM-TYPE rejection (`ERR_SHIPMENT_TYPE_MIX`) and the
     * date is incidental to it. On "today" they instead hit the
     * ONE-TRUCK-TYPE-PER-DAY rejection: `fixtures.driverId` holds a 'frozen'
     * route for today (the full-flow tests book one, and any earlier run of
     * this suite leaves one behind — it commits its SJs and never cleans them
     * up), so a 'dry' SJ for today never reached the mix check. The failure then
     * names the wrong rule, which is what makes it confusing rather than merely
     * red. The 'frozen' cases in this describe are unaffected and keep using
     * today, since a frozen SJ does not collide with a frozen one.
     */
    const MIX_TEST_DATE = '2031-05-05';

    it('rejects an SJ mixing a frozen item onto a "dry" shipment (ERR_SHIPMENT_TYPE_MIX)', async () => {
      await withRollback(async (client) => {
        await expect(
          sjService.create(
            client,
            {
              shipmentType: 'dry' as never,
              driverId: fixtures.driverId,
              vehicleId: fixtures.dryVehicleId,
              plannedDate: MIX_TEST_DATE,
              drops: [
                {
                  locationId: fixtures.outletId,
                  lines: [
                    {
                      itemId: fixtures.frozenItemId,
                      qty: '5.000',
                      unitId: fixtures.frozenItemUnitId,
                    },
                  ],
                },
              ],
            },
            fixtures.usersByRole[RoleKey.KEPALA_GUDANG],
          ),
          'a frozen item on a dry SJ must be rejected',
        ).rejects.toMatchObject({ response: { code: 'ERR_SHIPMENT_TYPE_MIX' } });
      });
    });

    it('rejects an SJ mixing a chilled item onto a "dry" shipment (ERR_SHIPMENT_TYPE_MIX) — the ambient truck never carries chilled goods', async () => {
      await withRollback(async (client) => {
        await expect(
          sjService.create(
            client,
            {
              shipmentType: 'dry' as never,
              driverId: fixtures.driverId,
              vehicleId: fixtures.dryVehicleId,
              plannedDate: MIX_TEST_DATE,
              drops: [
                {
                  locationId: fixtures.outletId,
                  lines: [
                    {
                      itemId: fixtures.chilledItemId,
                      qty: '5.000',
                      unitId: fixtures.chilledItemUnitId,
                    },
                  ],
                },
              ],
            },
            fixtures.usersByRole[RoleKey.KEPALA_GUDANG],
          ),
          'a chilled item on a dry SJ must be rejected',
        ).rejects.toMatchObject({ response: { code: 'ERR_SHIPMENT_TYPE_MIX' } });
      });
    });

    it('accepts a "frozen" SJ mixing frozen AND chilled items in one drop — the cold truck carries both (owner decision, 2026-08-17)', async () => {
      await withRollback(async (client) => {
        const sj = await sjService.create(
          client,
          {
            shipmentType: 'frozen' as never,
            driverId: fixtures.driverId,
            vehicleId: fixtures.frozenVehicleId,
            plannedDate: new Date().toISOString().slice(0, 10),
            drops: [
              {
                locationId: fixtures.outletId,
                lines: [
                  {
                    itemId: fixtures.frozenItemId,
                    qty: '3.000',
                    unitId: fixtures.frozenItemUnitId,
                  },
                  {
                    itemId: fixtures.chilledItemId,
                    qty: '3.000',
                    unitId: fixtures.chilledItemUnitId,
                  },
                ],
              },
            ],
          },
          fixtures.usersByRole[RoleKey.KEPALA_GUDANG],
        );
        expect(sj.drops[0]!.lines).toHaveLength(2);
      });
    });

    it('plannedDate round-trips exactly as submitted (DATE column, D-11 WITA day-shift regression)', async () => {
      // Fixed, non-today date — a day-shift regression can't hide behind "today happens not to expose it".
      const plannedDate = '2026-06-30';
      // `create()` self-commits (`db-tx.ts`'s `withWrite`), which drops the transaction-scoped `SET LOCAL
      // ROLE` on this connection — a follow-up read needs its OWN fresh context, exactly like the
      // full-flow describe block above (`withCommit` for the mutation, a separate `withRollback` for the
      // read), never the same `withRollback` block for both.
      const sj = await withCommit((client) =>
        sjService.create(
          client,
          {
            shipmentType: 'frozen' as never,
            driverId: fixtures.driverId,
            vehicleId: fixtures.frozenVehicleId,
            plannedDate,
            drops: [
              {
                locationId: fixtures.outletId,
                lines: [
                  {
                    itemId: fixtures.frozenItemId,
                    qty: '3.000',
                    unitId: fixtures.frozenItemUnitId,
                  },
                ],
              },
            ],
          },
          fixtures.usersByRole[RoleKey.KEPALA_GUDANG],
        ),
      );
      try {
        // Exact round-trip, not a loose date-shaped regex — a one-day-shifted value ("2026-06-29") would
        // still match `/^\d{4}-\d{2}-\d{2}$/` just as happily.
        expect(sj.plannedDate).toBe(plannedDate);

        const fetched = await withRollback((client) => sjService.getById(client, sj.id));
        expect(fetched.plannedDate).toBe(plannedDate);
      } finally {
        await deleteSuratJalan(sj.id);
      }
    });

    it('rejects a "frozen" SJ whose vehicle has no freezer', async () => {
      await withRollback(async (client) => {
        await expect(
          sjService.create(
            client,
            {
              shipmentType: 'frozen' as never,
              driverId: fixtures.driverId,
              vehicleId: fixtures.dryVehicleId, // no freezer
              plannedDate: new Date().toISOString().slice(0, 10),
              drops: [
                {
                  locationId: fixtures.outletId,
                  lines: [
                    {
                      itemId: fixtures.frozenItemId,
                      qty: '5.000',
                      unitId: fixtures.frozenItemUnitId,
                    },
                  ],
                },
              ],
            },
            fixtures.usersByRole[RoleKey.KEPALA_GUDANG],
          ),
        ).rejects.toThrow(/freezer/i);
      });
    });
  });

  // ── The end-to-end flow: warehouse -> SJ issued -> driver departs -> multi-drop
  // arrivals -> per-drop receipt (photo, signature, temp) -> stock adjusted per
  // area -> discrepancy recorded -> SJ completes -> replenishment advances. ────

  describe('full flow: create -> ready -> load -> dispatch -> depart -> arrive -> receive -> auto-complete', () => {
    let sjId: string;
    let dropId: string;
    let lineId: string;
    let requestId: string;
    let requestLineId: string;
    let photoAttachmentId: string;
    let signatureAttachmentId: string;
    const SENT_QTY = '10.000';
    const RECEIVED_QTY = '9.000'; // deliberate shortfall -> discrepancy path

    beforeAll(async () => {
      await seedWarehouseStock(fixtures.frozenItemId, fixtures.freezerAreaWarehouse, SENT_QTY);
      const req = await createReplenishmentRequestFixture(
        fixtures.outletId,
        await fixtures.outletAssignedUserId(RoleKey.LEADER_OUTLET),
        fixtures.frozenItemId,
        fixtures.frozenItemUnitId,
        SENT_QTY,
      );
      requestId = req.requestId;
      requestLineId = req.lineId;
    });

    afterAll(async () => {
      // `replenishment_requests.sj_id -> surat_jalan(id)` AND `sj_drops.replenishment_request_id ->
      // replenishment_requests(id)` point at EACH OTHER (both plain RESTRICT, no `ON DELETE` clause,
      // migrations 030/033/034) — neither table can be deleted first while the other still references it.
      // Break the cycle by nulling both link columns before deleting either row.
      if (requestId)
        await getOwnerPool().query(`UPDATE replenishment_requests SET sj_id = NULL WHERE id = $1`, [
          requestId,
        ]);
      if (sjId)
        await getOwnerPool().query(
          `UPDATE sj_drops SET replenishment_request_id = NULL WHERE sj_id = $1`,
          [sjId],
        );
      if (sjId)
        await getOwnerPool().query(`UPDATE sj_lines SET request_line_id = NULL WHERE sj_id = $1`, [
          sjId,
        ]);
      if (requestId) await deleteReplenishmentRequest(requestId);
      if (sjId) await deleteSuratJalan(sjId);
      if (photoAttachmentId) await deleteAttachment(photoAttachmentId);
      if (signatureAttachmentId) await deleteAttachment(signatureAttachmentId);
      await resetStockKey(
        fixtures.warehouseId,
        fixtures.freezerAreaWarehouse,
        fixtures.frozenItemId,
      );
      await resetStockKey(fixtures.outletId, fixtures.freezerAreaOutlet, fixtures.frozenItemId);
    });

    it('FR-LOG-01 — warehouse issues a numbered, multi-drop, frozen Surat Jalan linked to the replenishment request', async () => {
      const start = Date.now();
      const sj = await withCommit((client) =>
        sjService.create(
          client,
          {
            shipmentType: 'frozen' as never,
            driverId: fixtures.driverId,
            vehicleId: fixtures.frozenVehicleId,
            plannedDate: new Date().toISOString().slice(0, 10),
            drops: [
              {
                locationId: fixtures.outletId,
                replenishmentRequestId: requestId,
                lines: [
                  {
                    itemId: fixtures.frozenItemId,
                    qty: SENT_QTY,
                    unitId: fixtures.frozenItemUnitId,
                    requestLineId,
                  },
                ],
              },
            ],
            notes: 'W3-07 integration test',
          },
          fixtures.usersByRole[RoleKey.KEPALA_GUDANG],
        ),
      );
      console.log(
        `[delivery.integration] SJ create took ${Date.now() - start}ms against live Postgres`,
      );

      expect(sj.sjNumber).toMatch(/^SJ\/\d{6}\/\d{4}$/);
      expect(sj.status).toBe('draft');
      expect(sj.drops).toHaveLength(1);
      expect(sj.drops[0]!.lines).toHaveLength(1);
      sjId = sj.id;
      dropId = sj.drops[0]!.id;
      lineId = sj.drops[0]!.lines[0]!.id;

      // The sj_id fulfilment link really landed on the replenishment_requests row (not just in memory).
      const linked = await getOwnerPool().query<{ sj_id: string }>(
        `SELECT sj_id FROM replenishment_requests WHERE id = $1`,
        [requestId],
      );
      expect(linked.rows[0]!.sj_id).toBe(sjId);

      // A real `surat_jalan.issued` sync_events row was inserted — not merely returned in the response.
      const eventRow = await getOwnerPool().query(
        `SELECT entity, op, payload FROM sync_events WHERE entity = 'surat_jalan' AND op = 'issued' AND entity_id = $1`,
        [sjId],
      );
      expect(eventRow.rows).toHaveLength(1);
    });

    it('ready(): moves draft -> ready and advances the linked replenishment request to processing', async () => {
      const sj = await withCommit((client) =>
        sjService.ready(client, sjId, fixtures.usersByRole[RoleKey.KEPALA_GUDANG]),
      );
      expect(sj.status).toBe('ready');
      expect(await readReplenishmentRequestStatus(requestId)).toBe('processing');
    });

    it('load(): applies a seal and logs an in-range load temperature (no breach)', async () => {
      const sj = await withCommit((client) =>
        sjService.load(
          client,
          sjId,
          { seals: [{ sealNumber: 'SEAL-TEST-0001' }], tempC: '-20.0' },
          fixtures.usersByRole[RoleKey.KEPALA_GUDANG],
        ),
      );
      expect(sj.status).toBe('loading');
      expect(sj.seals.some((s) => s.sealNumber === 'SEAL-TEST-0001')).toBe(true);
      expect(sj.tempLogs.some((t) => t.stage === 'load' && !t.isBreach)).toBe(true);
      expect(notifySpy).not.toHaveBeenCalled(); // in-range reading raises nothing
    });

    it('FR-LOG-10 — dispatch(): posts transfer_out from the warehouse freezer (strict mode) and marks the request shipped', async () => {
      const before = await getOwnerPool().query<{ qty_on_hand: string } | undefined>(
        `SELECT qty_on_hand FROM stock_balances WHERE location_id = $1 AND storage_area_id = $2 AND item_id = $3`,
        [fixtures.warehouseId, fixtures.freezerAreaWarehouse, fixtures.frozenItemId],
      );
      const beforeQty = Number(before.rows[0]?.qty_on_hand ?? 0);

      const sj = await withCommit((client) =>
        sjService.dispatch(client, sjId, fixtures.usersByRole[RoleKey.KEPALA_GUDANG]),
      );
      expect(sj.status).toBe('in_transit');
      expect(sj.dispatchedAt).not.toBeNull();

      const after = await getOwnerPool().query<{ qty_on_hand: string }>(
        `SELECT qty_on_hand FROM stock_balances WHERE location_id = $1 AND storage_area_id = $2 AND item_id = $3`,
        [fixtures.warehouseId, fixtures.freezerAreaWarehouse, fixtures.frozenItemId],
      );
      expect(Number(after.rows[0]!.qty_on_hand)).toBeCloseTo(beforeQty - Number(SENT_QTY), 3);

      expect(await readReplenishmentRequestStatus(requestId)).toBe('shipped');

      const movement = await getOwnerPool().query(
        `SELECT movement_type FROM stock_movements WHERE ref_type = 'sj_drop' AND ref_id = $1 AND item_id = $2`,
        [dropId, fixtures.frozenItemId],
      );
      expect(movement.rows.map((r) => r.movement_type)).toContain('transfer_out');
    });

    it('depart(): requires a temperature reading for a frozen drop and records it', async () => {
      const drop = await withCommit((client) =>
        dropService.depart(client, dropId, { tempC: '-19.5' }, fixtures.driverUserId),
      );
      expect(drop.departedAt).not.toBeNull();
      expect(drop.status).toBe('en_route');
    });

    it('arrive(): logs the arrival temperature and verifies the seal', async () => {
      const sealRow = await getOwnerPool().query<{ id: string }>(
        `SELECT id FROM sj_seals WHERE sj_id = $1 LIMIT 1`,
        [sjId],
      );
      const sealId = sealRow.rows[0]!.id;

      const drop = await withCommit((client) =>
        dropService.arrive(
          client,
          dropId,
          { tempC: '-18.0', sealCheck: { sealId, status: 'verified_intact' } },
          fixtures.driverUserId,
        ),
      );
      expect(drop.status).toBe('arrived');
      expect(drop.arrivedAt).not.toBeNull();

      const sealAfter = await getOwnerPool().query<{ status: string }>(
        `SELECT status FROM sj_seals WHERE id = $1`,
        [sealId],
      );
      expect(sealAfter.rows[0]!.status).toBe('verified_intact');
    });

    it('FR-LOG-16 — receive(): wajib foto + signature enforced, discrepancy captured, stock lands in the outlet freezer via StockLedgerService, request+SJ complete', async () => {
      photoAttachmentId = await createConfirmedAttachment('receiving_photo', 'sj_drop', dropId);
      signatureAttachmentId = await createConfirmedAttachment('signature', 'sj_drop', dropId);

      // Wajib foto: rejects with zero photos even with everything else valid.
      await withRollback(async (client) => {
        await expect(
          dropService.receive(
            client,
            dropId,
            {
              lines: [
                {
                  lineId,
                  qtyReceived: RECEIVED_QTY,
                  receivedStorageAreaId: fixtures.freezerAreaOutlet,
                  discrepancyReason: 'kurang 1 kg saat bongkar',
                },
              ],
              photoAttachmentIds: [],
              signatureAttachmentId,
            } as never,
            fixtures.usersByRole[RoleKey.LEADER_OUTLET],
            RoleKey.LEADER_OUTLET,
          ),
        ).rejects.toMatchObject({ response: { code: 'ERR_PHOTO_REQUIRED' } });
      });

      // Discrepancy without a reason is rejected (dikirim vs diterima).
      await withRollback(async (client) => {
        await expect(
          dropService.receive(
            client,
            dropId,
            {
              lines: [
                {
                  lineId,
                  qtyReceived: RECEIVED_QTY,
                  receivedStorageAreaId: fixtures.freezerAreaOutlet,
                },
              ],
              photoAttachmentIds: [photoAttachmentId],
              signatureAttachmentId,
            } as never,
            fixtures.usersByRole[RoleKey.LEADER_OUTLET],
            RoleKey.LEADER_OUTLET,
          ),
        ).rejects.toMatchObject({ response: { code: 'ERR_VARIANCE_REASON_REQUIRED' } });
      });

      const beforeOutlet = await getOwnerPool().query<{ qty_on_hand: string } | undefined>(
        `SELECT qty_on_hand FROM stock_balances WHERE location_id = $1 AND storage_area_id = $2 AND item_id = $3`,
        [fixtures.outletId, fixtures.freezerAreaOutlet, fixtures.frozenItemId],
      );
      const beforeOutletQty = Number(beforeOutlet.rows[0]?.qty_on_hand ?? 0);

      const drop = await withCommit((client) =>
        dropService.receive(
          client,
          dropId,
          {
            lines: [
              {
                lineId,
                qtyReceived: RECEIVED_QTY,
                receivedStorageAreaId: fixtures.freezerAreaOutlet,
                discrepancyReason: 'kurang 1 kg saat bongkar',
              },
            ],
            photoAttachmentIds: [photoAttachmentId],
            signatureAttachmentId,
            discrepancyNotes: 'kurang 1 kg saat bongkar',
          } as never,
          fixtures.usersByRole[RoleKey.LEADER_OUTLET],
          RoleKey.LEADER_OUTLET,
        ),
      );

      expect(drop.status).toBe('completed_discrepancy');
      expect(drop.lines[0]!.qtyReceived).toBe(RECEIVED_QTY);
      expect(drop.lines[0]!.discrepancyReason).toBeTruthy();
      expect(drop.photoUrls).toContain(photoAttachmentId);

      const afterOutlet = await getOwnerPool().query<{ qty_on_hand: string }>(
        `SELECT qty_on_hand FROM stock_balances WHERE location_id = $1 AND storage_area_id = $2 AND item_id = $3`,
        [fixtures.outletId, fixtures.freezerAreaOutlet, fixtures.frozenItemId],
      );
      expect(Number(afterOutlet.rows[0]!.qty_on_hand)).toBeCloseTo(
        beforeOutletQty + Number(RECEIVED_QTY),
        3,
      );

      const movement = await getOwnerPool().query(
        `SELECT movement_type, storage_area_id FROM stock_movements WHERE ref_type = 'sj_drop' AND ref_id = $1 AND item_id = $2 AND movement_type = 'transfer_in'`,
        [dropId, fixtures.frozenItemId],
      );
      expect(movement.rows).toHaveLength(1);
      expect(movement.rows[0]!.storage_area_id).toBe(fixtures.freezerAreaOutlet);

      // SJ auto-completes once every drop is terminal (D-14).
      const sjAfter = await getOwnerPool().query<{ status: string; completed_at: Date | null }>(
        `SELECT status, completed_at FROM surat_jalan WHERE id = $1`,
        [sjId],
      );
      expect(sjAfter.rows[0]!.status).toBe('completed');
      expect(sjAfter.rows[0]!.completed_at).not.toBeNull();

      // The linked replenishment request reconciles to 'completed' (every line has a qty_received).
      expect(await readReplenishmentRequestStatus(requestId)).toBe('completed');
    });
  });

  // ── D-14 cold chain: breach detection + notification ─────────────────────

  describe('cold-chain breach', () => {
    let sjId: string;

    afterAll(async () => {
      if (sjId) await deleteSuratJalan(sjId);
    });

    it('a reading outside the frozen range (-25..-15) is flagged is_breach=true and raises the cold_chain_breach notification', async () => {
      const sj = await withCommit((client) =>
        sjService.create(
          client,
          {
            shipmentType: 'frozen' as never,
            driverId: fixtures.driverId,
            vehicleId: fixtures.frozenVehicleId,
            plannedDate: new Date().toISOString().slice(0, 10),
            drops: [
              {
                locationId: fixtures.outletId,
                lines: [
                  {
                    itemId: fixtures.frozenItemId,
                    qty: '2.000',
                    unitId: fixtures.frozenItemUnitId,
                  },
                ],
              },
            ],
          },
          fixtures.usersByRole[RoleKey.KEPALA_GUDANG],
        ),
      );
      sjId = sj.id;
      await withCommit((client) =>
        sjService.ready(client, sjId, fixtures.usersByRole[RoleKey.KEPALA_GUDANG]),
      );
      notifySpy.mockClear();

      const loaded = await withCommit((client) =>
        sjService.load(
          client,
          sjId,
          { seals: [{ sealNumber: 'SEAL-BREACH-0001' }], tempC: '-2.0' },
          fixtures.usersByRole[RoleKey.KEPALA_GUDANG],
        ),
      );

      const breachLog = loaded.tempLogs.find((t) => t.stage === 'load');
      expect(breachLog?.isBreach).toBe(true);

      expect(notifySpy).toHaveBeenCalledTimes(1);
      const call = notifySpy.mock.calls[0]![0];
      expect(call.templateKey).toBe('cold_chain_breach');
      expect(call.params.recordedTemp).toBe('-2.0');
      expect(call.userIds.length).toBeGreaterThan(0); // owner+manager+assigned KGD resolved via system-context, not an empty list

      const dbRow = await getOwnerPool().query<{ is_breach: boolean }>(
        `SELECT is_breach FROM sj_temperature_logs WHERE sj_id = $1 AND stage = 'load'`,
        [sjId],
      );
      expect(dbRow.rows[0]!.is_breach).toBe(true);
    });
  });

  // ── owner decision (2026-08-17): the cold truck carries BOTH frozen and chilled goods — breach must be
  // evaluated PER CLASS (`items.storage_type`) against ITS OWN `storage_areas` range, never against a
  // single static `shipment_types` range, or a chilled-only run on the cold truck gets falsely flagged on
  // every reading (the "alarm nobody reads" failure mode this whole redesign exists to avoid). ─────────────
  describe('cold-chain breach — per-class ranges on a shared cold truck', () => {
    let mixedSjId: string;
    let chilledOnlySjId: string;
    let frozenOnlySjId: string;

    afterAll(async () => {
      if (mixedSjId) await deleteSuratJalan(mixedSjId);
      if (chilledOnlySjId) await deleteSuratJalan(chilledOnlySjId);
      if (frozenOnlySjId) await deleteSuratJalan(frozenOnlySjId);
    });

    it('mixed cargo (frozen + chilled in the same drop): a freezer-temp reading breaches ONLY the chilled class and names it', async () => {
      const sj = await withCommit((client) =>
        sjService.create(
          client,
          {
            shipmentType: 'frozen' as never,
            driverId: fixtures.driverId,
            vehicleId: fixtures.frozenVehicleId,
            plannedDate: new Date().toISOString().slice(0, 10),
            drops: [
              {
                locationId: fixtures.outletId,
                lines: [
                  {
                    itemId: fixtures.frozenItemId,
                    qty: '2.000',
                    unitId: fixtures.frozenItemUnitId,
                  },
                  {
                    itemId: fixtures.chilledItemId,
                    qty: '2.000',
                    unitId: fixtures.chilledItemUnitId,
                  },
                ],
              },
            ],
          },
          fixtures.usersByRole[RoleKey.KEPALA_GUDANG],
        ),
      );
      mixedSjId = sj.id;
      await withCommit((client) =>
        sjService.ready(client, mixedSjId, fixtures.usersByRole[RoleKey.KEPALA_GUDANG]),
      );
      notifySpy.mockClear();

      // -18.0°C: squarely inside the freezer's -25..-15 (frozen items are FINE) but well outside the
      // chiller's 0..5 (chilled items are NOT) — the exact "one truck, one reading, two classes" case.
      const loaded = await withCommit((client) =>
        sjService.load(
          client,
          mixedSjId,
          { seals: [{ sealNumber: 'SEAL-MIXED-0001' }], tempC: '-18.0' },
          fixtures.usersByRole[RoleKey.KEPALA_GUDANG],
        ),
      );

      const log = loaded.tempLogs.find((t) => t.stage === 'load');
      expect(log?.isBreach).toBe(true); // overall boolean stays true (something breached)

      // Exactly one notification — for the chilled class only, not the frozen one.
      expect(notifySpy).toHaveBeenCalledTimes(1);
      const call = notifySpy.mock.calls[0]![0];
      expect(call.templateKey).toBe('cold_chain_breach');
      expect(call.params.goodsClass).toMatch(/chiller|chilled/i);
      expect(call.params.minTemp).toBe('0.0');
      expect(call.params.maxTemp).toBe('5.0');

      // The persisted detail names the breached class, not just the bare boolean (D-14 audit trail:
      // "frozen items exceeded -15°C" vs "temperature out of range").
      const dbRow = await getOwnerPool().query<{ is_breach: boolean; notes: string | null }>(
        `SELECT is_breach, notes FROM sj_temperature_logs WHERE sj_id = $1 AND stage = 'load'`,
        [mixedSjId],
      );
      expect(dbRow.rows[0]!.is_breach).toBe(true);
      const detail = JSON.parse(dbRow.rows[0]!.notes!);
      expect(detail.breachedClasses).toEqual(['chilled']);
    });

    it('chilled-only cargo on the cold truck: a normal chilled reading is NOT flagged (the false-positive this redesign fixes)', async () => {
      const sj = await withCommit((client) =>
        sjService.create(
          client,
          {
            shipmentType: 'frozen' as never,
            driverId: fixtures.driverId,
            vehicleId: fixtures.frozenVehicleId,
            plannedDate: new Date().toISOString().slice(0, 10),
            drops: [
              {
                locationId: fixtures.outletId,
                lines: [
                  {
                    itemId: fixtures.chilledItemId,
                    qty: '2.000',
                    unitId: fixtures.chilledItemUnitId,
                  },
                ],
              },
            ],
          },
          fixtures.usersByRole[RoleKey.KEPALA_GUDANG],
        ),
      );
      chilledOnlySjId = sj.id;
      await withCommit((client) =>
        sjService.ready(client, chilledOnlySjId, fixtures.usersByRole[RoleKey.KEPALA_GUDANG]),
      );
      notifySpy.mockClear();

      // 2.0°C is squarely inside the chiller's 0..5 range. Under the OLD (single static shipment-type
      // range) logic this would have been checked against frozen's -25..-15 and wrongly flagged EVERY time.
      const loaded = await withCommit((client) =>
        sjService.load(
          client,
          chilledOnlySjId,
          { seals: [{ sealNumber: 'SEAL-CHILLED-0001' }], tempC: '2.0' },
          fixtures.usersByRole[RoleKey.KEPALA_GUDANG],
        ),
      );

      const log = loaded.tempLogs.find((t) => t.stage === 'load');
      expect(log?.isBreach).toBe(false);
      expect(notifySpy).not.toHaveBeenCalled();

      const dbRow = await getOwnerPool().query<{ is_breach: boolean }>(
        `SELECT is_breach FROM sj_temperature_logs WHERE sj_id = $1 AND stage = 'load'`,
        [chilledOnlySjId],
      );
      expect(dbRow.rows[0]!.is_breach).toBe(false);
    });

    it('frozen-only cargo: a genuine breach is still flagged and names the frozen class (regression — the single-class case must keep working)', async () => {
      const sj = await withCommit((client) =>
        sjService.create(
          client,
          {
            shipmentType: 'frozen' as never,
            driverId: fixtures.driverId,
            vehicleId: fixtures.frozenVehicleId,
            plannedDate: new Date().toISOString().slice(0, 10),
            drops: [
              {
                locationId: fixtures.outletId,
                lines: [
                  {
                    itemId: fixtures.frozenItemId,
                    qty: '2.000',
                    unitId: fixtures.frozenItemUnitId,
                  },
                ],
              },
            ],
          },
          fixtures.usersByRole[RoleKey.KEPALA_GUDANG],
        ),
      );
      frozenOnlySjId = sj.id;
      await withCommit((client) =>
        sjService.ready(client, frozenOnlySjId, fixtures.usersByRole[RoleKey.KEPALA_GUDANG]),
      );
      notifySpy.mockClear();

      // 10.0°C breaches the freezer's -25..-15 range.
      const loaded = await withCommit((client) =>
        sjService.load(
          client,
          frozenOnlySjId,
          { seals: [{ sealNumber: 'SEAL-FROZEN-0001' }], tempC: '10.0' },
          fixtures.usersByRole[RoleKey.KEPALA_GUDANG],
        ),
      );

      const log = loaded.tempLogs.find((t) => t.stage === 'load');
      expect(log?.isBreach).toBe(true);

      expect(notifySpy).toHaveBeenCalledTimes(1);
      const call = notifySpy.mock.calls[0]![0];
      expect(call.params.goodsClass).toMatch(/beku|frozen/i);
      expect(call.params.minTemp).toBe('-25.0');
      expect(call.params.maxTemp).toBe('-15.0');

      const dbRow = await getOwnerPool().query<{ notes: string | null }>(
        `SELECT notes FROM sj_temperature_logs WHERE sj_id = $1 AND stage = 'load'`,
        [frozenOnlySjId],
      );
      const detail = JSON.parse(dbRow.rows[0]!.notes!);
      expect(detail.breachedClasses).toEqual(['frozen']);
    });
  });

  // ── SYNC-PROTOCOL §8 row 6: blind receipt (unmatched_delivery) ───────────

  describe('blind receipt (goods_receipts, unmatched_delivery)', () => {
    let receiptId: string;

    afterAll(async () => {
      if (receiptId) await deleteGoodsReceipt(receiptId);
      await resetStockKey(fixtures.outletId, fixtures.dryAreaOutlet, fixtures.dryItemId);
    });

    it('records as unmatched_delivery and still posts stock — a device that never cached the SJ can still receive goods', async () => {
      const photoId = await createConfirmedAttachment('receiving_photo', null, null);
      try {
        const receipt = await withCommit((client) =>
          goodsReceiptService.create(
            client,
            {
              locationId: fixtures.outletId,
              receiptType: 'unmatched_delivery',
              lines: [
                {
                  itemId: fixtures.dryItemId,
                  storageAreaId: fixtures.dryAreaOutlet,
                  qtyExpected: '0.000',
                  qtyReceived: '4.000',
                  discrepancyReason: 'unmatched delivery — no SJ cached on this device',
                },
              ],
              photoAttachmentIds: [photoId],
              notes: 'blind receipt integration test',
            },
            fixtures.usersByRole[RoleKey.LEADER_OUTLET],
          ),
        );
        receiptId = receipt.id;
        expect(receipt.receiptNumber).toMatch(/^GR\/\d{6}\/\d{4}$/);

        const dbRow = await getOwnerPool().query<{ receipt_type: string }>(
          `SELECT receipt_type FROM goods_receipts WHERE id = $1`,
          [receiptId],
        );
        expect(dbRow.rows[0]!.receipt_type).toBe('unmatched_delivery');

        const balance = await getOwnerPool().query<{ qty_on_hand: string }>(
          `SELECT qty_on_hand FROM stock_balances WHERE location_id = $1 AND storage_area_id = $2 AND item_id = $3`,
          [fixtures.outletId, fixtures.dryAreaOutlet, fixtures.dryItemId],
        );
        expect(balance.rows.length).toBeGreaterThan(0);
      } finally {
        await deleteAttachment(photoId);
      }
    });
  });

  // ── DeliverySyncProjector — the offline-delivery fix (coordinator's follow-up) ──────────

  describe('DeliverySyncProjector — real event through real ingest, then replay', () => {
    let sjId: string;
    let dropId: string;
    let lineId: string;
    let photoId: string;
    let sigId: string;

    const projectorRegistry = new SyncProjectorRegistry();
    const projector = new DeliverySyncProjector(eventsRepo, stockLedger, coldChain, dropService);
    projectorRegistry.register(projector);
    const offlineCredsRepo = new OfflineCredentialsRepository();
    const registryRepo = new RegistryRepository(getAppPool());
    const offlineAuth = new OfflineAuthService(
      offlineCredsRepo,
      conflictsRepo,
      new ConfigService(),
    );
    const reconciliation = new ReconciliationService(
      getAppPool(),
      eventsRepo,
      conflictsRepo,
      registryRepo,
    );
    const ingest = new SyncIngestService(
      eventsRepo,
      conflictDetector,
      offlineAuth,
      reconciliation,
      projectorRegistry,
    );

    /**
     * A far-future, fixed planned date — NOT `new Date()`, for the reason
     * `ROUTE_TEST_DATE` documents below.
     *
     * This describe books a 'dry' SJ for `fixtures.driverId`, and the full-flow
     * tests above book that SAME driver 'frozen' for TODAY. One driver may hold
     * only one truck type per day (FR-LOG-02), so on `new Date()` this
     * `beforeAll` threw and took the whole describe with it — deterministically,
     * from a clean database, not as a flake. A date nobody else plans around
     * removes the collision instead of coordinating with it.
     */
    const PROJECTOR_TEST_DATE = '2031-04-04';

    beforeAll(async () => {
      await seedWarehouseStock(fixtures.dryItemId, fixtures.dryAreaWarehouse, '20.000');
      const sj = await withCommit((client) =>
        sjService.create(
          client,
          {
            shipmentType: 'dry' as never,
            driverId: fixtures.driverId,
            vehicleId: fixtures.dryVehicleId,
            plannedDate: PROJECTOR_TEST_DATE,
            drops: [
              {
                locationId: fixtures.outletId,
                lines: [
                  { itemId: fixtures.dryItemId, qty: '5.000', unitId: fixtures.dryItemUnitId },
                ],
              },
            ],
          },
          fixtures.usersByRole[RoleKey.KEPALA_GUDANG],
        ),
      );
      sjId = sj.id;
      dropId = sj.drops[0]!.id;
      lineId = sj.drops[0]!.lines[0]!.id;

      await withCommit((client) =>
        sjService.ready(client, sjId, fixtures.usersByRole[RoleKey.KEPALA_GUDANG]),
      );
      await withCommit((client) =>
        sjService.load(
          client,
          sjId,
          { seals: [{ sealNumber: 'SEAL-PROJ-0001' }] },
          fixtures.usersByRole[RoleKey.KEPALA_GUDANG],
        ),
      );
      await withCommit((client) =>
        sjService.dispatch(client, sjId, fixtures.usersByRole[RoleKey.KEPALA_GUDANG]),
      );
      await withCommit((client) => dropService.depart(client, dropId, {}, fixtures.driverUserId));
      await withCommit((client) =>
        dropService.arrive(client, dropId, { tempC: '27.0' }, fixtures.driverUserId),
      );

      photoId = await createConfirmedAttachment('receiving_photo', 'sj_drop', dropId);
      sigId = await createConfirmedAttachment('signature', 'sj_drop', dropId);
    });

    afterAll(async () => {
      if (sjId) await deleteSuratJalan(sjId);
      if (photoId) await deleteAttachment(photoId);
      if (sigId) await deleteAttachment(sigId);
      await resetStockKey(fixtures.warehouseId, fixtures.dryAreaWarehouse, fixtures.dryItemId);
      await resetStockKey(fixtures.outletId, fixtures.dryAreaOutlet, fixtures.dryItemId);
    });

    function buildReceivedBatch(eventId: string, clientId: string): SyncPushBatch {
      return {
        batchId: randomUUID(),
        sentAt: new Date().toISOString(),
        events: [
          {
            eventId,
            originTier: SyncOriginType.DEVICE,
            originDeviceId: randomUUID(),
            locationId: fixtures.outletId,
            entity: 'sj_drops',
            entityId: dropId,
            op: 'received',
            payload: {
              v: 1,
              data: {
                dropId,
                lines: [
                  { lineId, qtyReceived: '5.000', receivedStorageAreaId: fixtures.dryAreaOutlet },
                ],
                photoAttachmentIds: [photoId],
                signatureAttachmentId: sigId,
                clientId,
              },
              meta: {
                actorUserId: fixtures.usersByRole[RoleKey.LEADER_OUTLET],
                actorRole: 'leader_outlet',
                appVersion: 'test-suite',
              },
            },
            clientSeq: 1n,
            occurredAt: new Date().toISOString(),
            actorUserId: fixtures.usersByRole[RoleKey.LEADER_OUTLET],
            schemaV: 1,
          },
        ],
      };
    }

    it('an offline sj_drops.received fact, pushed through the REAL ingest pipeline, materializes the domain row + stock effect — and a replayed re-ingest of the identical event applies exactly once', async () => {
      const eventId = formatUuidV7(Date.now(), randomBytes(16));
      const clientId = randomUUID();
      const batch = buildReceivedBatch(eventId, clientId);

      const beforeOutlet = await getOwnerPool().query<{ qty_on_hand: string } | undefined>(
        `SELECT qty_on_hand FROM stock_balances WHERE location_id = $1 AND storage_area_id = $2 AND item_id = $3`,
        [fixtures.outletId, fixtures.dryAreaOutlet, fixtures.dryItemId],
      );
      const beforeQty = Number(beforeOutlet.rows[0]?.qty_on_hand ?? 0);

      const start = Date.now();
      const ack1 = await ingest.ingestBatch(batch, async () => fixtures.outletId);
      console.log(
        `[delivery.integration] first sj_drops.received ingest took ${Date.now() - start}ms against live Postgres`,
      );
      expect(ack1.rejected).toEqual([]);

      // The domain effect landed exactly once: drop completed, stock posted.
      const dropAfter = await getOwnerPool().query<{ status: string }>(
        `SELECT status FROM sj_drops WHERE id = $1`,
        [dropId],
      );
      expect(dropAfter.rows[0]!.status).toBe('completed');

      const afterFirst = await getOwnerPool().query<{ qty_on_hand: string }>(
        `SELECT qty_on_hand FROM stock_balances WHERE location_id = $1 AND storage_area_id = $2 AND item_id = $3`,
        [fixtures.outletId, fixtures.dryAreaOutlet, fixtures.dryItemId],
      );
      expect(Number(afterFirst.rows[0]!.qty_on_hand)).toBeCloseTo(beforeQty + 5, 3);

      const movementCount = await getOwnerPool().query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM stock_movements WHERE ref_type = 'sj_drop' AND ref_id = $1 AND movement_type = 'transfer_in'`,
        [dropId],
      );
      expect(movementCount.rows[0]!.count).toBe('1');

      // REPLAY: the exact same event_id re-ingested. `SyncIngestService.applyOrRejectEvent` itself
      // short-circuits an already-applied event_id BEFORE ever calling the projector again (§4.4
      // idempotency) — this asserts the OUTCOME (stock/status unchanged) matches that guarantee end to end,
      // not just that the ingest layer's own bookkeeping thinks it deduped.
      const ack2 = await ingest.ingestBatch(batch, async () => fixtures.outletId);
      expect(ack2.rejected).toEqual([]);

      const afterReplay = await getOwnerPool().query<{ qty_on_hand: string }>(
        `SELECT qty_on_hand FROM stock_balances WHERE location_id = $1 AND storage_area_id = $2 AND item_id = $3`,
        [fixtures.outletId, fixtures.dryAreaOutlet, fixtures.dryItemId],
      );
      expect(Number(afterReplay.rows[0]!.qty_on_hand)).toBeCloseTo(beforeQty + 5, 3); // unchanged — not double-posted

      const movementCountAfterReplay = await getOwnerPool().query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM stock_movements WHERE ref_type = 'sj_drop' AND ref_id = $1 AND movement_type = 'transfer_in'`,
        [dropId],
      );
      expect(movementCountAfterReplay.rows[0]!.count).toBe('1'); // still exactly one row

      // A SECOND, genuinely DIFFERENT event_id but the SAME device-supplied `clientId` (simulating a client
      // retry that, due to a bug, minted a fresh eventId for a resend) — the below-the-registry dedup
      // (`sj_drops.client_id`) must ALSO prevent a double-post, independent of the registry's own event-id
      // guarantee (coordinator's follow-up).
      const secondEventId = formatUuidV7(Date.now() + 1, randomBytes(16));
      const secondBatch = buildReceivedBatch(secondEventId, clientId); // SAME clientId, different eventId
      const ack3 = await ingest.ingestBatch(secondBatch, async () => fixtures.outletId);
      expect(ack3.rejected).toEqual([]);

      const afterSecondEventId = await getOwnerPool().query<{ qty_on_hand: string }>(
        `SELECT qty_on_hand FROM stock_balances WHERE location_id = $1 AND storage_area_id = $2 AND item_id = $3`,
        [fixtures.outletId, fixtures.dryAreaOutlet, fixtures.dryItemId],
      );
      expect(Number(afterSecondEventId.rows[0]!.qty_on_hand)).toBeCloseTo(beforeQty + 5, 3); // STILL unchanged

      const movementCountFinal = await getOwnerPool().query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM stock_movements WHERE ref_type = 'sj_drop' AND ref_id = $1 AND movement_type = 'transfer_in'`,
        [dropId],
      );
      expect(movementCountFinal.rows[0]!.count).toBe('1'); // still exactly one — the clientId dedup caught it
    });

    it('sj_temperature_logs.logged, projected offline, stamps logged_at from sync_events.relay_received_at (never a fresh new Date()) — replay does not move it forward', async () => {
      const eventId = formatUuidV7(Date.now(), randomBytes(16));
      const batch: SyncPushBatch = {
        batchId: randomUUID(),
        sentAt: new Date().toISOString(),
        events: [
          {
            eventId,
            originTier: SyncOriginType.DEVICE,
            originDeviceId: randomUUID(),
            locationId: fixtures.outletId,
            entity: 'sj_temperature_logs',
            entityId: randomUUID(), // client-minted id for the (not-yet-existing) log row — this op's own dedup key is `sj_temperature_logs.client_id`, not `entityId`
            op: 'logged',
            payload: {
              v: 1,
              data: { sjId, dropId, stage: 'arrive', tempC: '31.0' },
              meta: {
                actorUserId: fixtures.usersByRole[RoleKey.DRIVER],
                actorRole: 'driver',
                appVersion: 'test-suite',
              },
            },
            clientSeq: 1n,
            occurredAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // claims it happened an hour ago
            actorUserId: fixtures.usersByRole[RoleKey.DRIVER],
            schemaV: 1,
          },
        ],
      };

      const ack1 = await ingest.ingestBatch(batch, async () => fixtures.outletId);
      expect(ack1.rejected).toEqual([]);

      const eventRow = await getOwnerPool().query<{
        relay_received_at: Date | null;
        received_at: Date;
      }>(`SELECT relay_received_at, received_at FROM sync_events WHERE event_id = $1`, [eventId]);
      const defensibleAt = (
        eventRow.rows[0]!.relay_received_at ?? eventRow.rows[0]!.received_at
      ).getTime();

      const tempLogRow1 = await getOwnerPool().query<{ logged_at: Date }>(
        `SELECT logged_at FROM sj_temperature_logs WHERE sj_id = $1 AND stage = 'arrive' AND temp_c = '31.0' ORDER BY logged_at DESC LIMIT 1`,
        [sjId],
      );
      expect(tempLogRow1.rows[0]!.logged_at.getTime()).toBe(defensibleAt); // NOT the device's claimed occurredAt (an hour earlier)

      // Simulate a re-projection retry days later — logged_at must NOT move forward to "now" on replay.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const ack2 = await ingest.ingestBatch(batch, async () => fixtures.outletId);
      expect(ack2.rejected).toEqual([]);

      const tempLogRow2 = await getOwnerPool().query<{ logged_at: Date }>(
        `SELECT logged_at FROM sj_temperature_logs WHERE sj_id = $1 AND stage = 'arrive' AND temp_c = '31.0' ORDER BY logged_at DESC LIMIT 1`,
        [sjId],
      );
      expect(tempLogRow2.rows[0]!.logged_at.getTime()).toBe(defensibleAt); // unchanged by the replay
    });
  });

  // ── Dispatch screen ticket: reorder drops + reassign driver/vehicle ──────

  describe('RouteService.planRoute — drop reordering', () => {
    // A far-future, fixed planned date — NOT `new Date()` (today). This suite runs against a shared dev
    // DB (other tickets' agents run their own integration passes against the same instance concurrently),
    // and "today" is exactly the date the FR-LOG-02/full-flow tests above already exercise for this same
    // `fixtures.driverId` — a genuinely unrelated leftover 'frozen' SJ for today was found sitting in the
    // DB while writing this suite (a prior run that did not clean up), which the one-truck-type-per-day
    // rule correctly refused to let a 'dry' fixture SJ collide with. Picking a date nobody else plans
    // around sidesteps that class of flake entirely rather than trying to out-guess what else is dated
    // "today".
    const ROUTE_TEST_DATE = '2031-02-02';

    /** Builds a fresh 3-drop dry SJ for one test, torn down after it. Three
     * drops (not two) so a reorder is a genuine permutation, not just a swap. */
    async function makeThreeDropSj(): Promise<{ sjId: string; dropIds: string[] }> {
      const sj = await withCommit((client) =>
        sjService.create(
          client,
          {
            shipmentType: 'dry' as never,
            driverId: fixtures.driverId,
            vehicleId: fixtures.dryVehicleId,
            plannedDate: ROUTE_TEST_DATE,
            drops: [
              {
                locationId: fixtures.outletId,
                lines: [
                  { itemId: fixtures.dryItemId, qty: '1.000', unitId: fixtures.dryItemUnitId },
                ],
              },
              {
                locationId: fixtures.outletId,
                lines: [
                  { itemId: fixtures.dryItemId, qty: '1.000', unitId: fixtures.dryItemUnitId },
                ],
              },
              {
                locationId: fixtures.outletId,
                lines: [
                  { itemId: fixtures.dryItemId, qty: '1.000', unitId: fixtures.dryItemUnitId },
                ],
              },
            ],
          },
          fixtures.usersByRole[RoleKey.KEPALA_GUDANG],
        ),
      );
      // `drops` comes back in `dropSeq` order (1, 2, 3) straight from `create()`.
      return { sjId: sj.id, dropIds: sj.drops.map((d) => d.id) };
    }

    it('reverses a 3-drop route: drop_seq ends up 1/2/3 against the reversed dropIds, with no UNIQUE(sj_id, drop_seq) collision mid-transaction', async () => {
      const { sjId, dropIds } = await makeThreeDropSj();
      try {
        const reversed = [...dropIds].reverse();
        const result = await withCommit((client) =>
          routeService.planRoute(
            client,
            sjId,
            { stops: reversed.map((dropId) => ({ dropId })) },
            fixtures.usersByRole[RoleKey.KEPALA_GUDANG],
          ),
        );
        expect(result).toEqual({ sjId, stops: 3 });

        const rows = await getOwnerPool().query<{ id: string; drop_seq: number }>(
          `SELECT id, drop_seq FROM sj_drops WHERE sj_id = $1 ORDER BY drop_seq ASC`,
          [sjId],
        );
        expect(rows.rows.map((r) => r.id)).toEqual(reversed);
        expect(rows.rows.map((r) => r.drop_seq)).toEqual([1, 2, 3]);
      } finally {
        await deleteSuratJalan(sjId);
      }
    });

    it('rejects a partial permutation (one dropId missing) — the route must NOT be silently applied', async () => {
      const { sjId, dropIds } = await makeThreeDropSj();
      try {
        await withRollback(async (client) => {
          await expect(
            routeService.planRoute(
              client,
              sjId,
              { stops: dropIds.slice(0, 2).map((dropId) => ({ dropId })) }, // drops the 3rd on the floor
              fixtures.usersByRole[RoleKey.KEPALA_GUDANG],
            ),
          ).rejects.toMatchObject({ response: { code: ERR_VALIDATION } });
        });

        // Untouched — the reject must roll back cleanly, not leave the parked/offset sequence behind.
        const rows = await getOwnerPool().query<{ drop_seq: number }>(
          `SELECT drop_seq FROM sj_drops WHERE sj_id = $1 ORDER BY drop_seq ASC`,
          [sjId],
        );
        expect(rows.rows.map((r) => r.drop_seq)).toEqual([1, 2, 3]);
      } finally {
        await deleteSuratJalan(sjId);
      }
    });

    it('rejects reordering a locked (in_transit) Surat Jalan — route order is locked once loading/in_transit', async () => {
      const { sjId, dropIds } = await makeThreeDropSj();
      try {
        // Flipping the status directly rather than running the full load/dispatch flow (stock ledger,
        // storage areas, seals) — the guard under test reads `surat_jalan.status` only, and this is the
        // owner (superuser, BYPASSRLS) connection already used for fixture setup/teardown throughout this
        // file, never the app-role path.
        await getOwnerPool().query(`UPDATE surat_jalan SET status = 'in_transit' WHERE id = $1`, [
          sjId,
        ]);

        await withRollback(async (client) => {
          await expect(
            routeService.planRoute(
              client,
              sjId,
              { stops: [...dropIds].reverse().map((dropId) => ({ dropId })) },
              fixtures.usersByRole[RoleKey.KEPALA_GUDANG],
            ),
          ).rejects.toMatchObject({ response: { code: 'ERR_CONFLICT' } });
        });
      } finally {
        await deleteSuratJalan(sjId);
      }
    });
  });

  describe('SuratJalanService.update — reassigning driver/vehicle re-checks the one-truck-type-per-driver-per-day rule', () => {
    it('rejects reassigning a driver onto this SJ when that driver already holds a different-truck-type route on the same planned date', async () => {
      // Far-future fixed date — see `ROUTE_TEST_DATE`'s comment above on why "today" is avoided here.
      const plannedDate = '2031-03-03';
      // A second active driver from the seed — the clash needs TWO real drivers: one who already holds
      // a route for the day (the "occupied" driver), and one who is this SJ's driver before the attempted
      // reassignment.
      const secondDriver = await getOwnerPool().query<{ id: string }>(
        `SELECT id FROM drivers WHERE is_active = true AND user_id IS NOT NULL AND id <> $1 LIMIT 1`,
        [fixtures.driverId],
      );
      if (!secondDriver.rows[0]) {
        // Seed data problem, not a test failure of this rule — flagged loudly rather than silently skipped.
        throw new Error('Seed needs at least 2 active drivers with a linked user_id for this test');
      }
      const otherDriverId = secondDriver.rows[0].id;

      // occupied: fixtures.driverId already has a DRY route today.
      const dryRun = await withCommit((client) =>
        sjService.create(
          client,
          {
            shipmentType: 'dry' as never,
            driverId: fixtures.driverId,
            vehicleId: fixtures.dryVehicleId,
            plannedDate,
            drops: [
              {
                locationId: fixtures.outletId,
                lines: [
                  { itemId: fixtures.dryItemId, qty: '1.000', unitId: fixtures.dryItemUnitId },
                ],
              },
            ],
          },
          fixtures.usersByRole[RoleKey.KEPALA_GUDANG],
        ),
      );

      // target: a FROZEN route today, currently held by the OTHER driver.
      const frozenRun = await withCommit((client) =>
        sjService.create(
          client,
          {
            shipmentType: 'frozen' as never,
            driverId: otherDriverId,
            vehicleId: fixtures.frozenVehicleId,
            plannedDate,
            drops: [
              {
                locationId: fixtures.outletId,
                lines: [
                  {
                    itemId: fixtures.frozenItemId,
                    qty: '1.000',
                    unitId: fixtures.frozenItemUnitId,
                  },
                ],
              },
            ],
          },
          fixtures.usersByRole[RoleKey.KEPALA_GUDANG],
        ),
      );

      try {
        // Reassigning the frozen run's driver to the one already on a dry run today must be rejected —
        // this is exactly the bypass `SuratJalanService.update()` had before this ticket's fix: `create()`
        // enforced the rule, but PATCHing the driver in afterwards did not.
        await withRollback(async (client) => {
          await expect(
            sjService.update(
              client,
              frozenRun.id,
              { driverId: fixtures.driverId },
              fixtures.usersByRole[RoleKey.KEPALA_GUDANG],
            ),
          ).rejects.toMatchObject({ response: { code: ERR_VALIDATION } });
        });

        // Untouched by the rejected attempt.
        const after = await getOwnerPool().query<{ driver_id: string }>(
          `SELECT driver_id FROM surat_jalan WHERE id = $1`,
          [frozenRun.id],
        );
        expect(after.rows[0]!.driver_id).toBe(otherDriverId);
      } finally {
        await deleteSuratJalan(dryRun.id);
        await deleteSuratJalan(frozenRun.id);
      }
    });

    it('still allows reassigning a driver whose OTHER route that day is the SAME truck type', async () => {
      // A different fixed future date from the "rejects" test above, so the two tests' fixture SJs never
      // interact even if they happened to run concurrently.
      const plannedDate = '2031-04-04';
      const secondDriver = await getOwnerPool().query<{ id: string }>(
        `SELECT id FROM drivers WHERE is_active = true AND user_id IS NOT NULL AND id <> $1 LIMIT 1`,
        [fixtures.driverId],
      );
      if (!secondDriver.rows[0]) {
        throw new Error('Seed needs at least 2 active drivers with a linked user_id for this test');
      }
      const otherDriverId = secondDriver.rows[0].id;

      // fixtures.driverId already has a DRY route today...
      const firstDryRun = await withCommit((client) =>
        sjService.create(
          client,
          {
            shipmentType: 'dry' as never,
            driverId: fixtures.driverId,
            vehicleId: fixtures.dryVehicleId,
            plannedDate,
            drops: [
              {
                locationId: fixtures.outletId,
                lines: [
                  { itemId: fixtures.dryItemId, qty: '1.000', unitId: fixtures.dryItemUnitId },
                ],
              },
            ],
          },
          fixtures.usersByRole[RoleKey.KEPALA_GUDANG],
        ),
      );
      // ...and this is a SECOND dry run, currently on the other driver.
      const secondDryRun = await withCommit((client) =>
        sjService.create(
          client,
          {
            shipmentType: 'dry' as never,
            driverId: otherDriverId,
            vehicleId: fixtures.dryVehicleId,
            plannedDate,
            drops: [
              {
                locationId: fixtures.outletId,
                lines: [
                  { itemId: fixtures.dryItemId, qty: '1.000', unitId: fixtures.dryItemUnitId },
                ],
              },
            ],
          },
          fixtures.usersByRole[RoleKey.KEPALA_GUDANG],
        ),
      );

      try {
        // Same truck type both times ('dry') — not a clash, one driver legitimately runs two dry routes.
        const updated = await withCommit((client) =>
          sjService.update(
            client,
            secondDryRun.id,
            { driverId: fixtures.driverId },
            fixtures.usersByRole[RoleKey.KEPALA_GUDANG],
          ),
        );
        expect(updated.driver.id).toBe(fixtures.driverId);
      } finally {
        await deleteSuratJalan(firstDryRun.id);
        await deleteSuratJalan(secondDryRun.id);
      }
    });
  });
});
