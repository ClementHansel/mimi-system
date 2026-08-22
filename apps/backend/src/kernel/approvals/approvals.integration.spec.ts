import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ApprovalDocumentType,
  ApprovalMode,
  ERR_APPROVAL_STEP_ROLE,
  ERR_OFFLINE_NOT_ELIGIBLE,
  ERR_REASON_REQUIRED,
  RoleKey,
} from '@mimi/shared';
import { SettingsRepository } from '../../modules/settings/settings.repository';
import type { NotificationService } from '../notification/notification.service';
import { ApprovalsRepository } from './approvals.repository';
import { ApprovalService } from './approvals.service';
import {
  buildApprovalServiceWithNotifications,
  closePool,
  createOfflineCredential,
  createReturnOutletToWarehouse,
  createReturnWarehouseToSupplier,
  createStockOpname,
  createWasteRecord,
  deleteOfflineCredential,
  deleteReturn,
  deleteStockOpname,
  deleteWasteRecord,
  ensureUserContact,
  ensureUserLocation,
  type Fixtures,
  getAppPool,
  loadFixtures,
  readOutboxRows,
  readOwnNotifications,
  setSettingValue,
  withRollback,
  withRollbackAs,
} from './test-support/live-db';

/**
 * Integration suite against the live Postgres (BUILD-PLAN W2-B "TESTING":
 * "Integration tests against the live DB for every one of the 12 document
 * types' chains, including the four runtime-resolved ones").
 *
 * D-22 shape: fixture rows this agent does not own (`stock_opname`,
 * `waste_records`, `returns`, `offline_credentials`) are created/deleted via
 * the OWNER pool (`test-support/live-db.ts`'s `getOwnerPool`, durably
 * committed so the SEPARATE `mimi_app` connection under test can see them),
 * `try { ... } finally { deleteX(...) }` around each `withRollback` block.
 * Every `ApprovalService`/`ApprovalsRepository` call runs on an `mimi_app`
 * `PoolClient` inside its own rolled-back transaction, under the SAME
 * `SET LOCAL ROLE app_user` + session-var context `RlsContextGuard` asserts
 * for a real request — nothing here runs on, or benefits from, a superuser
 * connection.
 */

function service(): ApprovalService {
  return new ApprovalService(new ApprovalsRepository());
}

let fx: Fixtures;

beforeAll(async () => {
  fx = await loadFixtures();
}, 30_000);

afterAll(async () => {
  await closePool();
});

describe('ApprovalService — live DB (mimi_app, real RLS), all 12 ApprovalDocumentType chains', () => {
  // ── 1. replenishment_request (regular, 2-step) ─────────────────────────
  it('replenishment_request: Supervisor then Kepala Gudang, in order, wrong role rejected', async () => {
    await withRollback(async (client) => {
      const svc = service();
      const documentId = randomUUID();
      const submitted = await svc.submit(client, {
        documentType: ApprovalDocumentType.REPLENISHMENT_REQUEST,
        documentId,
        requestedBy: fx.usersByRole[RoleKey.LEADER_OUTLET],
        amount: '150000.00',
        locationId: fx.outletId,
      });
      expect(submitted.currentStep).toBe(1);
      expect(submitted.approvalState).toBe('pending');

      await expect(
        svc.approve(client, {
          documentType: ApprovalDocumentType.REPLENISHMENT_REQUEST,
          documentId,
          currentState: 'submitted',
          actorUserId: fx.usersByRole[RoleKey.KASIR],
          actorRole: RoleKey.KASIR,
        }),
      ).rejects.toMatchObject({ response: { code: ERR_APPROVAL_STEP_ROLE } });

      const step1 = await svc.approve(client, {
        documentType: ApprovalDocumentType.REPLENISHMENT_REQUEST,
        documentId,
        currentState: 'submitted',
        actorUserId: fx.usersByRole[RoleKey.SUPERVISOR],
        actorRole: RoleKey.SUPERVISOR,
      });
      expect(step1.nextState).toBe('awaiting_approval');
      expect(step1.currentStep).toBe(2);
      expect(step1.approvalState).toBe('pending');

      const step2 = await svc.approve(client, {
        documentType: ApprovalDocumentType.REPLENISHMENT_REQUEST,
        documentId,
        currentState: 'awaiting_approval',
        actorUserId: fx.usersByRole[RoleKey.KEPALA_GUDANG],
        actorRole: RoleKey.KEPALA_GUDANG,
      });
      expect(step2.nextState).toBe('approved');
      expect(step2.currentStep).toBeNull();
      expect(step2.approvalState).toBe('approved');

      // The PERSISTED row must agree with the in-memory return value, not just happen to match it in
      // this call's response: `current_step IS NULL` is the documented "chain finished" signal every
      // consuming module keys on, and `finalizeApproval` used to update `state`/`decided_at` only,
      // silently leaving `current_step` at the last-acted step number forever (migration 216 made the
      // column nullable so this could be fixed at all). Read it back via `getDetail()` — a fresh query
      // against the table, not the object `approve()` already returned — so this actually exercises
      // what's in the database.
      const persisted = await svc.getDetail(
        client,
        ApprovalDocumentType.REPLENISHMENT_REQUEST,
        documentId,
      );
      expect(persisted.currentStep).toBeNull();
      expect(persisted.state).toBe('approved');
    });
  });

  it('replenishment_request: reject at step 1 requires a reason and is terminal', async () => {
    await withRollback(async (client) => {
      const svc = service();
      const documentId = randomUUID();
      await svc.submit(client, {
        documentType: ApprovalDocumentType.REPLENISHMENT_REQUEST,
        documentId,
        requestedBy: fx.usersByRole[RoleKey.LEADER_OUTLET],
        amount: '150000.00',
        locationId: fx.outletId,
      });

      await expect(
        svc.reject(client, {
          documentType: ApprovalDocumentType.REPLENISHMENT_REQUEST,
          documentId,
          currentState: 'submitted',
          actorUserId: fx.usersByRole[RoleKey.SUPERVISOR],
          actorRole: RoleKey.SUPERVISOR,
        }),
      ).rejects.toMatchObject({ response: { code: ERR_REASON_REQUIRED } });

      const rejected = await svc.reject(client, {
        documentType: ApprovalDocumentType.REPLENISHMENT_REQUEST,
        documentId,
        currentState: 'submitted',
        actorUserId: fx.usersByRole[RoleKey.SUPERVISOR],
        actorRole: RoleKey.SUPERVISOR,
        reason: 'stok gudang tidak cukup',
      });
      expect(rejected.approvalState).toBe('rejected');
      expect(rejected.currentStep).toBeNull();

      const detail = await svc.getDetail(
        client,
        ApprovalDocumentType.REPLENISHMENT_REQUEST,
        documentId,
      );
      expect(detail.steps[0]!.reason).toBe('stok gudang tidak cukup');
    });
  });

  // ── 2. void_refund (regular, threshold escalation) ─────────────────────
  it('void_refund: below threshold — Supervisor alone finalizes it (chain ends, no Manager step)', async () => {
    await withRollback(async (client) => {
      const svc = service();
      const documentId = randomUUID();
      const submitted = await svc.submit(client, {
        documentType: ApprovalDocumentType.VOID_REFUND,
        documentId,
        requestedBy: fx.usersByRole[RoleKey.KASIR],
        amount: '100000.00',
        locationId: fx.outletId,
      });
      expect(submitted.currentStep).toBe(1);

      const result = await svc.approve(client, {
        documentType: ApprovalDocumentType.VOID_REFUND,
        documentId,
        currentState: 'pending',
        actorUserId: fx.usersByRole[RoleKey.SUPERVISOR],
        actorRole: RoleKey.SUPERVISOR,
      });
      expect(result.currentStep).toBeNull();
      expect(result.approvalState).toBe('approved');
    });
  });

  it('void_refund: above threshold — Supervisor step leaves it pending, Manager step finalizes it', async () => {
    await withRollback(async (client) => {
      const svc = service();
      const documentId = randomUUID();
      await svc.submit(client, {
        documentType: ApprovalDocumentType.VOID_REFUND,
        documentId,
        requestedBy: fx.usersByRole[RoleKey.KASIR],
        amount: '300000.00',
        locationId: fx.outletId,
      });

      const step1 = await svc.approve(client, {
        documentType: ApprovalDocumentType.VOID_REFUND,
        documentId,
        currentState: 'pending',
        actorUserId: fx.usersByRole[RoleKey.SUPERVISOR],
        actorRole: RoleKey.SUPERVISOR,
      });
      // Same document-status edge is reported by transition() at every step (§5.2 has only one 'pending'->'approved'
      // rule) — `currentStep` is the disambiguator the caller MUST check before persisting `nextState`.
      expect(step1.nextState).toBe('approved');
      expect(step1.currentStep).toBe(2);
      expect(step1.approvalState).toBe('pending');

      // Supervisor cannot also close out step 2 — Manager-only.
      await expect(
        svc.approve(client, {
          documentType: ApprovalDocumentType.VOID_REFUND,
          documentId,
          currentState: 'pending',
          actorUserId: fx.usersByRole[RoleKey.SUPERVISOR],
          actorRole: RoleKey.SUPERVISOR,
        }),
      ).rejects.toMatchObject({ response: { code: ERR_APPROVAL_STEP_ROLE } });

      const step2 = await svc.approve(client, {
        documentType: ApprovalDocumentType.VOID_REFUND,
        documentId,
        currentState: 'pending',
        actorUserId: fx.usersByRole[RoleKey.MANAGER],
        actorRole: RoleKey.MANAGER,
      });
      expect(step2.currentStep).toBeNull();
      expect(step2.approvalState).toBe('approved');
    });
  });

  it('void_refund: offline-provisional approval is allowed (§7.6) and stamps offline_authorized', async () => {
    const credentialId = await createOfflineCredential(
      fx.usersByRole[RoleKey.SUPERVISOR],
      RoleKey.SUPERVISOR,
      [fx.outletId],
    );
    try {
      await withRollback(async (client) => {
        const svc = service();
        const documentId = randomUUID();
        await svc.submit(client, {
          documentType: ApprovalDocumentType.VOID_REFUND,
          documentId,
          requestedBy: fx.usersByRole[RoleKey.KASIR],
          amount: '100000.00',
          locationId: fx.outletId,
        });

        await svc.approve(client, {
          documentType: ApprovalDocumentType.VOID_REFUND,
          documentId,
          currentState: 'pending',
          actorUserId: fx.usersByRole[RoleKey.SUPERVISOR],
          actorRole: RoleKey.SUPERVISOR,
          offline: { credentialId },
        });

        const detail = await svc.getDetail(client, ApprovalDocumentType.VOID_REFUND, documentId);
        expect(detail.steps[0]!.offlineAuthorized).toBe(true);
        expect(detail.steps[0]!.reverificationStatus).toBeNull(); // pending re-verification, D-17
      });
    } finally {
      await deleteOfflineCredential(credentialId);
    }
  });

  it('void_refund: live settings threshold change is honoured immediately (no chain_steps edit needed)', async () => {
    await withRollback(async (client) => {
      // Written on the SAME app-pool client/transaction as the code under test — rolls back with everything
      // else, never touches the owner pool (see test-support/live-db.ts's setSettingValue doc comment).
      await setSettingValue(client, 'approval.threshold.void', { managerAboveIdr: '50000.00' });
      const svc = service();
      const documentId = randomUUID();
      await svc.submit(client, {
        documentType: ApprovalDocumentType.VOID_REFUND,
        documentId,
        requestedBy: fx.usersByRole[RoleKey.KASIR],
        amount: '100000.00', // below the SEEDED 200000 threshold, but above the live-lowered 50000
        locationId: fx.outletId,
      });

      const result = await svc.approve(client, {
        documentType: ApprovalDocumentType.VOID_REFUND,
        documentId,
        currentState: 'pending',
        actorUserId: fx.usersByRole[RoleKey.SUPERVISOR],
        actorRole: RoleKey.SUPERVISOR,
      });
      // With the live threshold lowered to 50000, 100000 now escalates — a step 2 must exist.
      expect(result.currentStep).toBe(2);
      expect(result.approvalState).toBe('pending');
    });
  });

  // ── 3/4. purchase_request -> purchase_order ────────────────────────────
  it('purchase_request: Manager approves, single step', async () => {
    await withRollback(async (client) => {
      const svc = service();
      const documentId = randomUUID();
      await svc.submit(client, {
        documentType: ApprovalDocumentType.PURCHASE_REQUEST,
        documentId,
        requestedBy: fx.usersByRole[RoleKey.KEPALA_GUDANG],
        locationId: fx.warehouseId,
      });
      const result = await svc.approve(client, {
        documentType: ApprovalDocumentType.PURCHASE_REQUEST,
        documentId,
        currentState: 'submitted',
        actorUserId: fx.usersByRole[RoleKey.MANAGER],
        actorRole: RoleKey.MANAGER,
      });
      expect(result.approvalState).toBe('approved');
      expect(result.nextState).toBe('approved');
    });
  });

  it('purchase_order: below owner threshold, Manager alone finalizes; above threshold needs Owner too', async () => {
    await withRollback(async (client) => {
      const svc = service();
      const cheapId = randomUUID();
      await svc.submit(client, {
        documentType: ApprovalDocumentType.PURCHASE_ORDER,
        documentId: cheapId,
        requestedBy: fx.usersByRole[RoleKey.KEPALA_GUDANG],
        amount: '5000000.00',
        locationId: fx.warehouseId,
      });
      const cheap = await svc.approve(client, {
        documentType: ApprovalDocumentType.PURCHASE_ORDER,
        documentId: cheapId,
        currentState: 'pending_approval',
        actorUserId: fx.usersByRole[RoleKey.MANAGER],
        actorRole: RoleKey.MANAGER,
      });
      expect(cheap.currentStep).toBeNull();
      expect(cheap.approvalState).toBe('approved');

      const bigId = randomUUID();
      await svc.submit(client, {
        documentType: ApprovalDocumentType.PURCHASE_ORDER,
        documentId: bigId,
        requestedBy: fx.usersByRole[RoleKey.KEPALA_GUDANG],
        amount: '15000000.00',
        locationId: fx.warehouseId,
      });
      const step1 = await svc.approve(client, {
        documentType: ApprovalDocumentType.PURCHASE_ORDER,
        documentId: bigId,
        currentState: 'pending_approval',
        actorUserId: fx.usersByRole[RoleKey.MANAGER],
        actorRole: RoleKey.MANAGER,
      });
      expect(step1.currentStep).toBe(2);
      const step2 = await svc.approve(client, {
        documentType: ApprovalDocumentType.PURCHASE_ORDER,
        documentId: bigId,
        currentState: 'pending_approval',
        actorUserId: fx.usersByRole[RoleKey.OWNER],
        actorRole: RoleKey.OWNER,
      });
      expect(step2.currentStep).toBeNull();
      expect(step2.approvalState).toBe('approved');
    });
  });

  it('purchase_order: reject requires a reason and returns the document to draft', async () => {
    await withRollback(async (client) => {
      const svc = service();
      const documentId = randomUUID();
      await svc.submit(client, {
        documentType: ApprovalDocumentType.PURCHASE_ORDER,
        documentId,
        requestedBy: fx.usersByRole[RoleKey.KEPALA_GUDANG],
        amount: '1000000.00',
        locationId: fx.warehouseId,
      });
      await expect(
        svc.reject(client, {
          documentType: ApprovalDocumentType.PURCHASE_ORDER,
          documentId,
          currentState: 'pending_approval',
          actorUserId: fx.usersByRole[RoleKey.MANAGER],
          actorRole: RoleKey.MANAGER,
        }),
      ).rejects.toMatchObject({ response: { code: ERR_REASON_REQUIRED } });

      const rejected = await svc.reject(client, {
        documentType: ApprovalDocumentType.PURCHASE_ORDER,
        documentId,
        currentState: 'pending_approval',
        actorUserId: fx.usersByRole[RoleKey.MANAGER],
        actorRole: RoleKey.MANAGER,
        reason: 'harga tidak sesuai',
      });
      expect(rejected.nextState).toBe('draft');
      expect(rejected.approvalState).toBe('rejected');
    });
  });

  // ── 5. stock_opname (IRREGULAR — location-type routing) ────────────────
  describe('stock_opname — carried-forward item 2 (location-type routing)', () => {
    it('an outlet opname routes to Supervisor; Kepala Gudang is rejected', async () => {
      const opnameId = await createStockOpname(fx.outletId, fx.usersByRole[RoleKey.LEADER_OUTLET]);
      try {
        await withRollback(async (client) => {
          const svc = service();
          await svc.submit(client, {
            documentType: ApprovalDocumentType.STOCK_OPNAME,
            documentId: opnameId,
            requestedBy: fx.usersByRole[RoleKey.LEADER_OUTLET],
            amount: '100000.00',
            locationId: fx.outletId,
          });

          await expect(
            svc.approve(client, {
              documentType: ApprovalDocumentType.STOCK_OPNAME,
              documentId: opnameId,
              currentState: 'submitted',
              actorUserId: fx.usersByRole[RoleKey.KEPALA_GUDANG],
              actorRole: RoleKey.KEPALA_GUDANG,
            }),
          ).rejects.toMatchObject({ response: { code: ERR_APPROVAL_STEP_ROLE } });

          const result = await svc.approve(client, {
            documentType: ApprovalDocumentType.STOCK_OPNAME,
            documentId: opnameId,
            currentState: 'submitted',
            actorUserId: fx.usersByRole[RoleKey.SUPERVISOR],
            actorRole: RoleKey.SUPERVISOR,
          });
          expect(result.nextState).toBe('adjusted');
          expect(result.approvalState).toBe('approved');
        });
      } finally {
        await deleteStockOpname(opnameId);
      }
    });

    it('a warehouse opname routes to Kepala Gudang; Supervisor is rejected — the seeded chain role is only "supervisor"', async () => {
      const opnameId = await createStockOpname(
        fx.warehouseId,
        fx.usersByRole[RoleKey.KEPALA_GUDANG],
      );
      try {
        await withRollback(async (client) => {
          const svc = service();
          await svc.submit(client, {
            documentType: ApprovalDocumentType.STOCK_OPNAME,
            documentId: opnameId,
            requestedBy: fx.usersByRole[RoleKey.KEPALA_GUDANG],
            amount: '100000.00',
            locationId: fx.warehouseId,
          });

          await expect(
            svc.approve(client, {
              documentType: ApprovalDocumentType.STOCK_OPNAME,
              documentId: opnameId,
              currentState: 'submitted',
              actorUserId: fx.usersByRole[RoleKey.SUPERVISOR],
              actorRole: RoleKey.SUPERVISOR,
            }),
          ).rejects.toMatchObject({ response: { code: ERR_APPROVAL_STEP_ROLE } });

          const result = await svc.approve(client, {
            documentType: ApprovalDocumentType.STOCK_OPNAME,
            documentId: opnameId,
            currentState: 'submitted',
            actorUserId: fx.usersByRole[RoleKey.KEPALA_GUDANG],
            actorRole: RoleKey.KEPALA_GUDANG,
          });
          expect(result.approvalState).toBe('approved');
        });
      } finally {
        await deleteStockOpname(opnameId);
      }
    });

    it('a large variance escalates to Manager after the location-routed step 1', async () => {
      const opnameId = await createStockOpname(fx.outletId, fx.usersByRole[RoleKey.LEADER_OUTLET]);
      try {
        await withRollback(async (client) => {
          const svc = service();
          await svc.submit(client, {
            documentType: ApprovalDocumentType.STOCK_OPNAME,
            documentId: opnameId,
            requestedBy: fx.usersByRole[RoleKey.LEADER_OUTLET],
            amount: '3000000.00', // above the seeded 2,000,000 manager threshold
            locationId: fx.outletId,
          });

          const step1 = await svc.approve(client, {
            documentType: ApprovalDocumentType.STOCK_OPNAME,
            documentId: opnameId,
            currentState: 'submitted',
            actorUserId: fx.usersByRole[RoleKey.SUPERVISOR],
            actorRole: RoleKey.SUPERVISOR,
          });
          expect(step1.currentStep).toBe(2);
          expect(step1.approvalState).toBe('pending');

          const step2 = await svc.approve(client, {
            documentType: ApprovalDocumentType.STOCK_OPNAME,
            documentId: opnameId,
            currentState: 'submitted',
            actorUserId: fx.usersByRole[RoleKey.MANAGER],
            actorRole: RoleKey.MANAGER,
          });
          expect(step2.currentStep).toBeNull();
          expect(step2.approvalState).toBe('approved');
        });
      } finally {
        await deleteStockOpname(opnameId);
      }
    });

    it('reject requires a reason regardless of location type', async () => {
      const opnameId = await createStockOpname(
        fx.warehouseId,
        fx.usersByRole[RoleKey.KEPALA_GUDANG],
      );
      try {
        await withRollback(async (client) => {
          const svc = service();
          await svc.submit(client, {
            documentType: ApprovalDocumentType.STOCK_OPNAME,
            documentId: opnameId,
            requestedBy: fx.usersByRole[RoleKey.KEPALA_GUDANG],
            amount: '10000.00',
            locationId: fx.warehouseId,
          });
          await expect(
            svc.reject(client, {
              documentType: ApprovalDocumentType.STOCK_OPNAME,
              documentId: opnameId,
              currentState: 'submitted',
              actorUserId: fx.usersByRole[RoleKey.KEPALA_GUDANG],
              actorRole: RoleKey.KEPALA_GUDANG,
            }),
          ).rejects.toMatchObject({ response: { code: ERR_REASON_REQUIRED } });
        });
      } finally {
        await deleteStockOpname(opnameId);
      }
    });
  });

  // ── 6. return (IRREGULAR — direction routing) ──────────────────────────
  describe('return — carried-forward item 2 (direction routing)', () => {
    it('outlet_to_warehouse routes to Supervisor', async () => {
      const returnId = await createReturnOutletToWarehouse(
        fx.outletId,
        fx.warehouseId,
        fx.usersByRole[RoleKey.LEADER_OUTLET],
      );
      try {
        await withRollback(async (client) => {
          const svc = service();
          await svc.submit(client, {
            documentType: ApprovalDocumentType.RETURN,
            documentId: returnId,
            requestedBy: fx.usersByRole[RoleKey.LEADER_OUTLET],
            locationId: fx.outletId,
          });

          await expect(
            svc.approve(client, {
              documentType: ApprovalDocumentType.RETURN,
              documentId: returnId,
              currentState: 'submitted',
              actorUserId: fx.usersByRole[RoleKey.KEPALA_GUDANG],
              actorRole: RoleKey.KEPALA_GUDANG,
            }),
          ).rejects.toMatchObject({ response: { code: ERR_APPROVAL_STEP_ROLE } });

          const result = await svc.approve(client, {
            documentType: ApprovalDocumentType.RETURN,
            documentId: returnId,
            currentState: 'submitted',
            actorUserId: fx.usersByRole[RoleKey.SUPERVISOR],
            actorRole: RoleKey.SUPERVISOR,
          });
          expect(result.approvalState).toBe('approved');
        });
      } finally {
        await deleteReturn(returnId);
      }
    });

    it('warehouse_to_supplier routes to Kepala Gudang — the seeded chain role is only "supervisor"', async () => {
      const returnId = await createReturnWarehouseToSupplier(
        fx.warehouseId,
        fx.supplierId,
        fx.usersByRole[RoleKey.KEPALA_GUDANG],
      );
      try {
        await withRollback(async (client) => {
          const svc = service();
          await svc.submit(client, {
            documentType: ApprovalDocumentType.RETURN,
            documentId: returnId,
            requestedBy: fx.usersByRole[RoleKey.KEPALA_GUDANG],
            locationId: fx.warehouseId,
          });

          await expect(
            svc.approve(client, {
              documentType: ApprovalDocumentType.RETURN,
              documentId: returnId,
              currentState: 'submitted',
              actorUserId: fx.usersByRole[RoleKey.SUPERVISOR],
              actorRole: RoleKey.SUPERVISOR,
            }),
          ).rejects.toMatchObject({ response: { code: ERR_APPROVAL_STEP_ROLE } });

          const result = await svc.approve(client, {
            documentType: ApprovalDocumentType.RETURN,
            documentId: returnId,
            currentState: 'submitted',
            actorUserId: fx.usersByRole[RoleKey.KEPALA_GUDANG],
            actorRole: RoleKey.KEPALA_GUDANG,
          });
          expect(result.approvalState).toBe('approved');
        });
      } finally {
        await deleteReturn(returnId);
      }
    });
  });

  // ── 7. waste (IRREGULAR — location-type routing + offline eligibility) ─
  describe('waste — carried-forward item 2 + D-17 offline eligibility', () => {
    it('an outlet waste report routes to Supervisor and MAY be approved offline (§7.6)', async () => {
      const wasteId = await createWasteRecord(
        fx.outletId,
        fx.storageAreaOutlet,
        fx.itemId,
        fx.usersByRole[RoleKey.LEADER_OUTLET],
      );
      const credentialId = await createOfflineCredential(
        fx.usersByRole[RoleKey.SUPERVISOR],
        RoleKey.SUPERVISOR,
        [fx.outletId],
      );
      try {
        await withRollback(async (client) => {
          const svc = service();
          await svc.submit(client, {
            documentType: ApprovalDocumentType.WASTE,
            documentId: wasteId,
            requestedBy: fx.usersByRole[RoleKey.LEADER_OUTLET],
            locationId: fx.outletId,
          });

          const result = await svc.approve(client, {
            documentType: ApprovalDocumentType.WASTE,
            documentId: wasteId,
            currentState: 'pending',
            actorUserId: fx.usersByRole[RoleKey.SUPERVISOR],
            actorRole: RoleKey.SUPERVISOR,
            offline: { credentialId },
          });
          expect(result.approvalState).toBe('approved');

          const detail = await svc.getDetail(client, ApprovalDocumentType.WASTE, wasteId);
          expect(detail.steps[0]!.offlineAuthorized).toBe(true);
        });
      } finally {
        await deleteOfflineCredential(credentialId);
        await deleteWasteRecord(wasteId);
      }
    });

    it('a warehouse waste report routes to Kepala Gudang and MUST NOT be approved offline', async () => {
      const wasteId = await createWasteRecord(
        fx.warehouseId,
        fx.storageAreaWarehouse,
        fx.itemId,
        fx.usersByRole[RoleKey.KEPALA_GUDANG],
      );
      try {
        await withRollback(async (client) => {
          const svc = service();
          await svc.submit(client, {
            documentType: ApprovalDocumentType.WASTE,
            documentId: wasteId,
            requestedBy: fx.usersByRole[RoleKey.KEPALA_GUDANG],
            locationId: fx.warehouseId,
          });

          await expect(
            svc.approve(client, {
              documentType: ApprovalDocumentType.WASTE,
              documentId: wasteId,
              currentState: 'pending',
              actorUserId: fx.usersByRole[RoleKey.SUPERVISOR],
              actorRole: RoleKey.SUPERVISOR,
            }),
          ).rejects.toMatchObject({ response: { code: ERR_APPROVAL_STEP_ROLE } });

          // Transition()'s offline-eligibility check runs (and fails) BEFORE any credential lookup, so a
          // bare random UUID is fine here — this rejection never reaches the FK-checked write.
          await expect(
            svc.approve(client, {
              documentType: ApprovalDocumentType.WASTE,
              documentId: wasteId,
              currentState: 'pending',
              actorUserId: fx.usersByRole[RoleKey.KEPALA_GUDANG],
              actorRole: RoleKey.KEPALA_GUDANG,
              offline: { credentialId: randomUUID() },
            }),
          ).rejects.toMatchObject({ response: { code: ERR_OFFLINE_NOT_ELIGIBLE } });

          const result = await svc.approve(client, {
            documentType: ApprovalDocumentType.WASTE,
            documentId: wasteId,
            currentState: 'pending',
            actorUserId: fx.usersByRole[RoleKey.KEPALA_GUDANG],
            actorRole: RoleKey.KEPALA_GUDANG,
          });
          expect(result.approvalState).toBe('approved');
        });
      } finally {
        await deleteWasteRecord(wasteId);
      }
    });
  });

  // ── 8. payroll_run (regular, unconditional 2-step) ─────────────────────
  it('payroll_run: Finance then Owner, always both steps (no threshold on either)', async () => {
    await withRollback(async (client) => {
      const svc = service();
      const documentId = randomUUID();
      await svc.submit(client, {
        documentType: ApprovalDocumentType.PAYROLL_RUN,
        documentId,
        requestedBy: fx.usersByRole[RoleKey.HR_ADMIN],
        locationId: null,
      });

      const step1 = await svc.approve(client, {
        documentType: ApprovalDocumentType.PAYROLL_RUN,
        documentId,
        currentState: 'pending_approval',
        actorUserId: fx.usersByRole[RoleKey.FINANCE],
        actorRole: RoleKey.FINANCE,
      });
      expect(step1.currentStep).toBe(2);
      expect(step1.approvalState).toBe('pending');

      const step2 = await svc.approve(client, {
        documentType: ApprovalDocumentType.PAYROLL_RUN,
        documentId,
        currentState: 'pending_approval',
        actorUserId: fx.usersByRole[RoleKey.OWNER],
        actorRole: RoleKey.OWNER,
      });
      expect(step2.currentStep).toBeNull();
      expect(step2.approvalState).toBe('approved');
    });
  });

  // ── 9. payment_verification (regular, threshold gates a differently-named action) ─
  describe('payment_verification — the "pay" action, not "approve"', () => {
    it('below the owner threshold: submit resolves the approval immediately, nothing to decide', async () => {
      await withRollback(async (client) => {
        const svc = service();
        const documentId = randomUUID();
        const submitted = await svc.submit(client, {
          documentType: ApprovalDocumentType.PAYMENT_VERIFICATION,
          documentId,
          requestedBy: fx.usersByRole[RoleKey.FINANCE],
          amount: '5000000.00',
          locationId: fx.warehouseId,
        });
        expect(submitted.currentStep).toBeNull();
        expect(submitted.approvalState).toBe('approved');
      });
    });

    it('above the owner threshold: Finance cannot close the "pay" step, only Owner can', async () => {
      await withRollback(async (client) => {
        const svc = service();
        const documentId = randomUUID();
        const submitted = await svc.submit(client, {
          documentType: ApprovalDocumentType.PAYMENT_VERIFICATION,
          documentId,
          requestedBy: fx.usersByRole[RoleKey.FINANCE],
          amount: '25000000.00',
          locationId: fx.warehouseId,
        });
        expect(submitted.currentStep).toBe(1);

        await expect(
          svc.decide(client, {
            documentType: ApprovalDocumentType.PAYMENT_VERIFICATION,
            documentId,
            action: 'pay',
            outcome: 'approved',
            currentState: 'verified',
            actorUserId: fx.usersByRole[RoleKey.FINANCE],
            actorRole: RoleKey.FINANCE,
          }),
        ).rejects.toMatchObject({ response: { code: ERR_APPROVAL_STEP_ROLE } });

        const result = await svc.decide(client, {
          documentType: ApprovalDocumentType.PAYMENT_VERIFICATION,
          documentId,
          action: 'pay',
          outcome: 'approved',
          currentState: 'verified',
          actorUserId: fx.usersByRole[RoleKey.OWNER],
          actorRole: RoleKey.OWNER,
        });
        expect(result.nextState).toBe('paid');
        expect(result.approvalState).toBe('approved');
      });
    });
  });

  // ── 10. leave_request (IRREGULAR — any-of role set) ────────────────────
  describe('leave_request — carried-forward item 2 (any-of Supervisor/HR Admin/Manager)', () => {
    it.each([RoleKey.SUPERVISOR, RoleKey.HR_ADMIN, RoleKey.MANAGER])(
      '%s may approve step 1 even though the seeded chain role is only "supervisor"',
      async (approverRole) => {
        await withRollback(async (client) => {
          const svc = service();
          const documentId = randomUUID();
          await svc.submit(client, {
            documentType: ApprovalDocumentType.LEAVE_REQUEST,
            documentId,
            requestedBy: fx.usersByRole[RoleKey.LEADER_OUTLET],
            locationId: fx.outletId,
          });
          const result = await svc.approve(client, {
            documentType: ApprovalDocumentType.LEAVE_REQUEST,
            documentId,
            currentState: 'pending',
            actorUserId: fx.usersByRole[approverRole],
            actorRole: approverRole,
          });
          expect(result.approvalState).toBe('approved');
        });
      },
    );

    it('Kasir may not approve a leave request', async () => {
      await withRollback(async (client) => {
        const svc = service();
        const documentId = randomUUID();
        await svc.submit(client, {
          documentType: ApprovalDocumentType.LEAVE_REQUEST,
          documentId,
          requestedBy: fx.usersByRole[RoleKey.LEADER_OUTLET],
          locationId: fx.outletId,
        });
        await expect(
          svc.approve(client, {
            documentType: ApprovalDocumentType.LEAVE_REQUEST,
            documentId,
            currentState: 'pending',
            actorUserId: fx.usersByRole[RoleKey.KASIR],
            actorRole: RoleKey.KASIR,
          }),
        ).rejects.toMatchObject({ response: { code: ERR_APPROVAL_STEP_ROLE } });
      });
    });
  });

  // ── 11. employee_loan (regular, unconditional 2-step) ──────────────────
  it('employee_loan: Finance then Manager, always both steps', async () => {
    await withRollback(async (client) => {
      const svc = service();
      const documentId = randomUUID();
      await svc.submit(client, {
        documentType: ApprovalDocumentType.EMPLOYEE_LOAN,
        documentId,
        requestedBy: fx.usersByRole[RoleKey.HR_ADMIN],
        locationId: null,
      });

      const step1 = await svc.approve(client, {
        documentType: ApprovalDocumentType.EMPLOYEE_LOAN,
        documentId,
        currentState: 'pending',
        actorUserId: fx.usersByRole[RoleKey.FINANCE],
        actorRole: RoleKey.FINANCE,
      });
      expect(step1.currentStep).toBe(2);

      const step2 = await svc.approve(client, {
        documentType: ApprovalDocumentType.EMPLOYEE_LOAN,
        documentId,
        currentState: 'pending',
        actorUserId: fx.usersByRole[RoleKey.MANAGER],
        actorRole: RoleKey.MANAGER,
      });
      expect(step2.currentStep).toBeNull();
      expect(step2.approvalState).toBe('approved');
    });
  });

  // ── 12. cash_variance_proposal (regular, D-19 reason-on-approve + never offline) ─
  describe('cash_variance_proposal — D-19 (reason required on APPROVE too, never offline)', () => {
    it('approve without a reason is rejected — unique among all 12 chains', async () => {
      await withRollback(async (client) => {
        const svc = service();
        const documentId = randomUUID();
        await svc.submit(client, {
          documentType: ApprovalDocumentType.CASH_VARIANCE_PROPOSAL,
          documentId,
          requestedBy: fx.usersByRole[RoleKey.KASIR],
          amount: '25000.00',
          locationId: fx.outletId,
        });
        await expect(
          svc.approve(client, {
            documentType: ApprovalDocumentType.CASH_VARIANCE_PROPOSAL,
            documentId,
            currentState: 'pending',
            actorUserId: fx.usersByRole[RoleKey.SUPERVISOR],
            actorRole: RoleKey.SUPERVISOR,
          }),
        ).rejects.toMatchObject({ response: { code: ERR_REASON_REQUIRED } });
      });
    });

    it('approve with a reason succeeds', async () => {
      await withRollback(async (client) => {
        const svc = service();
        const documentId = randomUUID();
        await svc.submit(client, {
          documentType: ApprovalDocumentType.CASH_VARIANCE_PROPOSAL,
          documentId,
          requestedBy: fx.usersByRole[RoleKey.KASIR],
          amount: '25000.00',
          locationId: fx.outletId,
        });
        const result = await svc.approve(client, {
          documentType: ApprovalDocumentType.CASH_VARIANCE_PROPOSAL,
          documentId,
          currentState: 'pending',
          actorUserId: fx.usersByRole[RoleKey.SUPERVISOR],
          actorRole: RoleKey.SUPERVISOR,
          reason: 'selisih diakui kasir, dipotong dari gaji',
        });
        expect(result.approvalState).toBe('approved');
      });
    });

    it('is never offline-authorizable (D-19, SYNC-PROTOCOL §7.6 exclusion)', async () => {
      await withRollback(async (client) => {
        const svc = service();
        const documentId = randomUUID();
        await svc.submit(client, {
          documentType: ApprovalDocumentType.CASH_VARIANCE_PROPOSAL,
          documentId,
          requestedBy: fx.usersByRole[RoleKey.KASIR],
          amount: '25000.00',
          locationId: fx.outletId,
        });
        await expect(
          svc.approve(client, {
            documentType: ApprovalDocumentType.CASH_VARIANCE_PROPOSAL,
            documentId,
            currentState: 'pending',
            actorUserId: fx.usersByRole[RoleKey.SUPERVISOR],
            actorRole: RoleKey.SUPERVISOR,
            reason: 'diakui',
            offline: { credentialId: randomUUID() },
          }),
        ).rejects.toMatchObject({ response: { code: ERR_OFFLINE_NOT_ELIGIBLE } });
      });
    });
  });

  // ── cross-cutting ────────────────────────────────────────────────────────
  it('"my pending approvals" is scoped by role AND location — a Supervisor at outlet A never sees outlet B\'s pending opname', async () => {
    const opnameId = await createStockOpname(fx.outletId, fx.usersByRole[RoleKey.LEADER_OUTLET]);
    try {
      await withRollback(async (client) => {
        const svc = service();
        await svc.submit(client, {
          documentType: ApprovalDocumentType.STOCK_OPNAME,
          documentId: opnameId,
          requestedBy: fx.usersByRole[RoleKey.LEADER_OUTLET],
          amount: '10000.00',
          locationId: fx.outletId,
        });

        const inScope = await svc.getPending(
          client,
          {
            userId: fx.usersByRole[RoleKey.SUPERVISOR],
            roleKey: RoleKey.SUPERVISOR,
            locationIds: [fx.outletId],
          },
          { page: 1, pageSize: 50 },
        );
        expect(inScope.rows.some((r) => r.documentId === opnameId)).toBe(true);

        const outOfScope = await svc.getPending(
          client,
          {
            userId: fx.usersByRole[RoleKey.SUPERVISOR],
            roleKey: RoleKey.SUPERVISOR,
            locationIds: [fx.warehouseId],
          },
          { page: 1, pageSize: 50 },
        );
        expect(outOfScope.rows.some((r) => r.documentId === opnameId)).toBe(false);
      });
    } finally {
      await deleteStockOpname(opnameId);
    }
  });

  it('"my pending approvals" resolves runtime eligibility, not the stored seed role — Kepala Gudang sees a warehouse opname even though the DB row stores approver_role=\'supervisor\'', async () => {
    const opnameId = await createStockOpname(fx.warehouseId, fx.usersByRole[RoleKey.KEPALA_GUDANG]);
    try {
      await withRollback(async (client) => {
        const svc = service();
        await svc.submit(client, {
          documentType: ApprovalDocumentType.STOCK_OPNAME,
          documentId: opnameId,
          requestedBy: fx.usersByRole[RoleKey.KEPALA_GUDANG],
          amount: '10000.00',
          locationId: fx.warehouseId,
        });

        const kgdView = await svc.getPending(
          client,
          {
            userId: fx.usersByRole[RoleKey.KEPALA_GUDANG],
            roleKey: RoleKey.KEPALA_GUDANG,
            locationIds: [fx.warehouseId],
          },
          { page: 1, pageSize: 50 },
        );
        expect(kgdView.rows.some((r) => r.documentId === opnameId)).toBe(true);

        const spvView = await svc.getPending(
          client,
          {
            userId: fx.usersByRole[RoleKey.SUPERVISOR],
            roleKey: RoleKey.SUPERVISOR,
            locationIds: [fx.warehouseId],
          },
          { page: 1, pageSize: 50 },
        );
        expect(spvView.rows.some((r) => r.documentId === opnameId)).toBe(false);
      });
    } finally {
      await deleteStockOpname(opnameId);
    }
  });

  /**
   * THE regression test the coordinator flagged as missing: `users_select`
   * RLS (migration 009) is `app_is_central() OR app_is_self(id)` — Supervisor
   * Cabang and Kepala Gudang are neither. Before this fix,
   * `findPendingCandidates`'s `JOIN users u ON u.id = a.requested_by` ran as
   * one of those roles and silently DROPPED every row whose requester wasn't
   * the approver's own user id — every scoped approver's pending-approvals
   * inbox was empty. A same-user happy path (approver = requester) would
   * never have caught this.
   *
   * CRITICAL, found only by actually trying to make this test fail first:
   * `withRollback` (used by every other test in this file) fixes the DB
   * session's `app.role` to `'owner'` — a CENTRAL role. `users_select`
   * grants a central role unconditional access, so running this exact
   * scenario through `withRollback` PASSES even with the broken
   * `JOIN users` reinstated — it proves nothing. Passing `roleKey:
   * RoleKey.SUPERVISOR` into `getPending()`'s `CallerScope` is an
   * application-level parameter for THIS engine's own scoping logic; it has
   * no bearing on what the Postgres SESSION itself is allowed to read. Only
   * `withRollbackAs({ role: 'supervisor', ... })` puts `app.role` itself at
   * the non-central value a real Supervisor's request would carry — that is
   * the one thing that actually re-creates the incident. Verified live: with
   * `approvals.repository.ts`'s `JOIN users` reinstated, this exact test
   * (unchanged) fails at `expect(row).toBeDefined()` — the row is dropped,
   * not just unnamed. With the `app_user_display()` fix, it passes.
   */
  it("a Supervisor (real, non-central RLS session) sees a pending request raised by ANOTHER user in their inbox, with the requester's real name populated", async () => {
    const requesterId = fx.usersByRole[RoleKey.LEADER_OUTLET];
    const approverId = fx.usersByRole[RoleKey.SUPERVISOR];
    expect(requesterId).not.toBe(approverId); // the exact case app_is_self() cannot satisfy for the approver

    await withRollbackAs(
      { role: RoleKey.SUPERVISOR, userId: approverId, locationIds: [fx.outletId] },
      async (client) => {
        const svc = service();
        const documentId = randomUUID();

        await svc.submit(client, {
          documentType: ApprovalDocumentType.REPLENISHMENT_REQUEST,
          documentId,
          requestedBy: requesterId,
          amount: '150000.00',
          locationId: fx.outletId,
        });

        const inbox = await svc.getPending(
          client,
          { userId: approverId, roleKey: RoleKey.SUPERVISOR, locationIds: [fx.outletId] },
          { page: 1, pageSize: 50 },
        );

        const row = inbox.rows.find((r) => r.documentId === documentId);
        expect(row).toBeDefined(); // the row itself must survive — this is what the INNER JOIN used to eliminate
        expect(row!.requestedBy).not.toBe(requesterId); // a real name, not the raw id echoed back as a fallback
        expect(row!.requestedBy.length).toBeGreaterThan(0);
        expect(row!.requestedBy).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/i); // not a UUID-shaped fallback
      },
    );
  });

  it("a Kepala Gudang (real, non-central RLS session) also resolves a non-self requester's name (not just Supervisor)", async () => {
    const requesterId = fx.usersByRole[RoleKey.LEADER_OUTLET];
    const kgdApproverId = fx.usersByRole[RoleKey.KEPALA_GUDANG];
    expect(requesterId).not.toBe(kgdApproverId);

    // Step 1 (Supervisor clearing the request) runs under the Supervisor's own real, non-central
    // session; the session then switches to the Kepala Gudang's real, non-central session for the
    // inbox read — one transaction, `set_config` is re-assertable mid-transaction, `SET LOCAL ROLE
    // app_user` (the actual Postgres role) never needs reissuing.
    await withRollbackAs(
      {
        role: RoleKey.SUPERVISOR,
        userId: fx.usersByRole[RoleKey.SUPERVISOR],
        locationIds: [fx.outletId],
      },
      async (client) => {
        const svc = service();
        const documentId = randomUUID();

        await svc.submit(client, {
          documentType: ApprovalDocumentType.REPLENISHMENT_REQUEST,
          documentId,
          requestedBy: requesterId,
          amount: '150000.00',
          locationId: fx.outletId,
        });
        await svc.approve(client, {
          documentType: ApprovalDocumentType.REPLENISHMENT_REQUEST,
          documentId,
          currentState: 'submitted',
          actorUserId: fx.usersByRole[RoleKey.SUPERVISOR],
          actorRole: RoleKey.SUPERVISOR,
        });

        await client.query(`SELECT set_config('app.role', $1, true)`, [RoleKey.KEPALA_GUDANG]);
        await client.query(`SELECT set_config('app.user_id', $1, true)`, [kgdApproverId]);
        // ScopeService's real kepalaGudangScope() is "their warehouse UNION every outlet that
        // warehouse has shipped to" — this replenishment request's `approvals.location_id` is the
        // REQUESTING outlet (set at submit()), so a Kepala Gudang who serves it legitimately has
        // both in scope. `app.location_ids` (the RLS session var) is irrelevant to this read (no RLS
        // on approvals/approval_steps); `CallerScope.locationIds` below is the one that matters.
        await client.query(`SELECT set_config('app.location_ids', $1, true)`, [
          `${fx.warehouseId},${fx.outletId}`,
        ]);

        const inbox = await svc.getPending(
          client,
          {
            userId: kgdApproverId,
            roleKey: RoleKey.KEPALA_GUDANG,
            locationIds: [fx.warehouseId, fx.outletId],
          },
          { page: 1, pageSize: 50 },
        );
        const row = inbox.rows.find((r) => r.documentId === documentId);
        expect(row).toBeDefined();
        expect(row!.requestedBy).not.toBe(requesterId);
        expect(row!.requestedBy.length).toBeGreaterThan(0);
      },
    );
  });

  it('a second decision on an already-decided approval is rejected (idempotency / no double-spend)', async () => {
    await withRollback(async (client) => {
      const svc = service();
      const documentId = randomUUID();
      await svc.submit(client, {
        documentType: ApprovalDocumentType.VOID_REFUND,
        documentId,
        requestedBy: fx.usersByRole[RoleKey.KASIR],
        amount: '50000.00',
        locationId: fx.outletId,
      });
      await svc.approve(client, {
        documentType: ApprovalDocumentType.VOID_REFUND,
        documentId,
        currentState: 'pending',
        actorUserId: fx.usersByRole[RoleKey.SUPERVISOR],
        actorRole: RoleKey.SUPERVISOR,
      });
      await expect(
        svc.approve(client, {
          documentType: ApprovalDocumentType.VOID_REFUND,
          documentId,
          currentState: 'pending',
          actorUserId: fx.usersByRole[RoleKey.SUPERVISOR],
          actorRole: RoleKey.SUPERVISOR,
        }),
      ).rejects.toMatchObject({ response: { code: 'ERR_APPROVAL_ALREADY_DECIDED' } });
    });
  });

  it('submitting twice for the same document is rejected (ERR_CONFLICT)', async () => {
    await withRollback(async (client) => {
      const svc = service();
      const documentId = randomUUID();
      await svc.submit(client, {
        documentType: ApprovalDocumentType.PURCHASE_REQUEST,
        documentId,
        requestedBy: fx.usersByRole[RoleKey.KEPALA_GUDANG],
        locationId: fx.warehouseId,
      });
      await expect(
        svc.submit(client, {
          documentType: ApprovalDocumentType.PURCHASE_REQUEST,
          documentId,
          requestedBy: fx.usersByRole[RoleKey.KEPALA_GUDANG],
          locationId: fx.warehouseId,
        }),
      ).rejects.toMatchObject({ response: { code: 'ERR_CONFLICT' } });
    });
  });
});

/**
 * D-23 (owner-decided, BUILD-PLAN carried-forward) — per-`ApprovalDocumentType`
 * mode. Three representative types per the ticket: `void_refund` (high-risk),
 * `waste` (routine), `payroll_run` (financial). Modes are set via the SAME
 * `SettingsRepository.upsertApprovalMode` the real `settings.approval_mode.manage`
 * endpoint calls (M20) — never a hand-rolled raw `UPDATE settings` — so this
 * suite exercises the real self-seeding upsert path, not a shortcut around it.
 */
describe('ApprovalService — D-23 per-document-type approval modes', () => {
  const settingsRepo = new SettingsRepository();

  it('defaults every document type to manual until an Owner explicitly changes it (no settings row needed)', async () => {
    await withRollback(async (client) => {
      const svc = service();
      expect(await svc.getMode(client, ApprovalDocumentType.VOID_REFUND)).toBe(ApprovalMode.MANUAL);
      expect(await svc.getMode(client, ApprovalDocumentType.WASTE)).toBe(ApprovalMode.MANUAL);
      expect(await svc.getMode(client, ApprovalDocumentType.PAYROLL_RUN)).toBe(ApprovalMode.MANUAL);
      expect(
        await svc.resolveNotificationChannels(client, ApprovalDocumentType.VOID_REFUND),
      ).toEqual(['in_app', 'email']);
    });
  });

  it('off (waste, routine): submit() auto-approves with NO human step, yet still records the real actor — never anonymous', async () => {
    const wasteId = await createWasteRecord(
      fx.outletId,
      fx.storageAreaOutlet,
      fx.itemId,
      fx.usersByRole[RoleKey.LEADER_OUTLET],
    );
    try {
      await withRollback(async (client) => {
        await settingsRepo.upsertApprovalMode(
          client,
          ApprovalDocumentType.WASTE,
          ApprovalMode.OFF,
          fx.usersByRole[RoleKey.OWNER],
        );
        const svc = service();
        const requester = fx.usersByRole[RoleKey.LEADER_OUTLET];

        expect(await svc.resolveNotificationChannels(client, ApprovalDocumentType.WASTE)).toEqual(
          [],
        ); // nothing pending to notify anyone about

        const submitted = await svc.submit(client, {
          documentType: ApprovalDocumentType.WASTE,
          documentId: wasteId,
          requestedBy: requester,
          locationId: fx.outletId,
          requestedByRole: RoleKey.LEADER_OUTLET,
        });
        expect(submitted.mode).toBe(ApprovalMode.OFF);
        expect(submitted.approvalState).toBe('approved');
        expect(submitted.currentStep).toBeNull();
        expect(submitted.stepState).toBe('approved');

        // Bookkeeping (D-08's own `approvals`/`approval_steps` tables) is NOT holed just because the
        // human gate was switched off — a report spanning this mode change has the actor, the timestamp,
        // and the resulting terminal state, exactly the ticket's "off" contract.
        const detail = await svc.getDetail(client, ApprovalDocumentType.WASTE, wasteId);
        expect(detail.state).toBe('approved');
        expect(detail.steps).toHaveLength(1);
        expect(detail.steps[0]!.state).toBe('approved');
        expect(detail.steps[0]!.actedBy).toBe(requester);
        expect(detail.steps[0]!.actedAt).not.toBeNull();
        expect(detail.steps[0]!.approverRole).toBe(RoleKey.LEADER_OUTLET);

        // No human gate ever existed for this submission — a later decide() attempt correctly finds
        // nothing pending, not a step it can still act on.
        await expect(
          svc.approve(client, {
            documentType: ApprovalDocumentType.WASTE,
            documentId: wasteId,
            currentState: 'approved',
            actorUserId: fx.usersByRole[RoleKey.SUPERVISOR],
            actorRole: RoleKey.SUPERVISOR,
          }),
        ).rejects.toMatchObject({ response: { code: 'ERR_APPROVAL_ALREADY_DECIDED' } });
      });
    } finally {
      await deleteWasteRecord(wasteId);
    }
  });

  it('off with no requestedByRole supplied: actor is still captured, role label degrades to the documented "system" sentinel', async () => {
    const wasteId = await createWasteRecord(
      fx.outletId,
      fx.storageAreaOutlet,
      fx.itemId,
      fx.usersByRole[RoleKey.LEADER_OUTLET],
    );
    try {
      await withRollback(async (client) => {
        await settingsRepo.upsertApprovalMode(
          client,
          ApprovalDocumentType.WASTE,
          ApprovalMode.OFF,
          fx.usersByRole[RoleKey.OWNER],
        );
        const svc = service();
        const requester = fx.usersByRole[RoleKey.LEADER_OUTLET];
        await svc.submit(client, {
          documentType: ApprovalDocumentType.WASTE,
          documentId: wasteId,
          requestedBy: requester,
          locationId: fx.outletId,
        });
        const detail = await svc.getDetail(client, ApprovalDocumentType.WASTE, wasteId);
        expect(detail.steps[0]!.actedBy).toBe(requester); // actor recorded regardless
        expect(detail.steps[0]!.approverRole).toBe('system');
      });
    } finally {
      await deleteWasteRecord(wasteId);
    }
  });

  it('whatsapp (void_refund, high-risk): chain still requires the real authenticated decision; only the notify channel changes (D-24)', async () => {
    await withRollback(async (client) => {
      await settingsRepo.upsertApprovalMode(
        client,
        ApprovalDocumentType.VOID_REFUND,
        ApprovalMode.WHATSAPP,
        fx.usersByRole[RoleKey.OWNER],
      );
      const svc = service();
      expect(
        await svc.resolveNotificationChannels(client, ApprovalDocumentType.VOID_REFUND),
      ).toEqual(['in_app', 'whatsapp']);

      const documentId = randomUUID();
      const submitted = await svc.submit(client, {
        documentType: ApprovalDocumentType.VOID_REFUND,
        documentId,
        requestedBy: fx.usersByRole[RoleKey.KASIR],
        amount: '100000.00',
        locationId: fx.outletId,
      });
      expect(submitted.mode).toBe(ApprovalMode.WHATSAPP);
      expect(submitted.approvalState).toBe('pending'); // still a real chain — a WA message is a notify, never a decide

      // A Kasir cannot decide their own request just because a WA message went out — same RBAC gate as manual mode.
      await expect(
        svc.approve(client, {
          documentType: ApprovalDocumentType.VOID_REFUND,
          documentId,
          currentState: 'pending',
          actorUserId: fx.usersByRole[RoleKey.KASIR],
          actorRole: RoleKey.KASIR,
        }),
      ).rejects.toMatchObject({ response: { code: ERR_APPROVAL_STEP_ROLE } });

      const decided = await svc.approve(client, {
        documentType: ApprovalDocumentType.VOID_REFUND,
        documentId,
        currentState: 'pending',
        actorUserId: fx.usersByRole[RoleKey.SUPERVISOR],
        actorRole: RoleKey.SUPERVISOR,
      });
      expect(decided.approvalState).toBe('approved');
    });
  });

  it('auto (payroll_run, financial): the request is system-created without a separate submit step, but BOTH human decisions (Finance, Owner) are still required — auto never decides', async () => {
    await withRollback(async (client) => {
      await settingsRepo.upsertApprovalMode(
        client,
        ApprovalDocumentType.PAYROLL_RUN,
        ApprovalMode.AUTO,
        fx.usersByRole[RoleKey.OWNER],
      );
      const svc = service();
      expect(
        await svc.resolveNotificationChannels(client, ApprovalDocumentType.PAYROLL_RUN),
      ).toEqual(['in_app', 'email']);

      const documentId = randomUUID();
      const submitted = await svc.submit(client, {
        documentType: ApprovalDocumentType.PAYROLL_RUN,
        documentId,
        requestedBy: fx.usersByRole[RoleKey.HR_ADMIN],
        locationId: null,
      });
      expect(submitted.mode).toBe(ApprovalMode.AUTO);
      expect(submitted.approvalState).toBe('pending'); // "auto" automates the REQUEST, never the decision

      const step1 = await svc.approve(client, {
        documentType: ApprovalDocumentType.PAYROLL_RUN,
        documentId,
        currentState: 'pending_approval',
        actorUserId: fx.usersByRole[RoleKey.FINANCE],
        actorRole: RoleKey.FINANCE,
      });
      expect(step1.currentStep).toBe(2);
      expect(step1.approvalState).toBe('pending');

      const step2 = await svc.approve(client, {
        documentType: ApprovalDocumentType.PAYROLL_RUN,
        documentId,
        currentState: 'pending_approval',
        actorUserId: fx.usersByRole[RoleKey.OWNER],
        actorRole: RoleKey.OWNER,
      });
      expect(step2.currentStep).toBeNull();
      expect(step2.approvalState).toBe('approved');
    });
  });

  it('a mode change takes effect on the very next submit() with no restart — flipping payroll_run manual -> off mid-suite', async () => {
    await withRollback(async (client) => {
      const svc = service();
      expect(await svc.getMode(client, ApprovalDocumentType.PAYROLL_RUN)).toBe(ApprovalMode.MANUAL);

      await settingsRepo.upsertApprovalMode(
        client,
        ApprovalDocumentType.PAYROLL_RUN,
        ApprovalMode.OFF,
        fx.usersByRole[RoleKey.OWNER],
      );
      expect(await svc.getMode(client, ApprovalDocumentType.PAYROLL_RUN)).toBe(ApprovalMode.OFF);

      const documentId = randomUUID();
      const submitted = await svc.submit(client, {
        documentType: ApprovalDocumentType.PAYROLL_RUN,
        documentId,
        requestedBy: fx.usersByRole[RoleKey.HR_ADMIN],
        locationId: null,
      });
      expect(submitted.approvalState).toBe('approved'); // no Finance/Owner steps created at all
    });
  });
});

/**
 * B-07 — closing the gap that made approval notifications real: nothing
 * previously called `NotificationService.notify()` on submit/step-advance/
 * decision, so an approver only ever learned of a pending request by
 * happening to look at "my pending approvals". These tests run
 * `ApprovalService` wired with a REAL `NotificationService`
 * (`buildApprovalServiceWithNotifications()`) against the SAME live
 * Postgres the rest of this suite uses, and assert the actual side effect:
 * a real row in `notifications`/`notification_outbox`, not a mocked call.
 *
 * KNOWN TEST-DB ARTIFACT (matching `notification.service.integration.spec.ts`'s
 * own established shape): unlike `approvals`/`approval_steps`/`settings`,
 * `NotificationService`'s writes run on their OWN connection/transaction
 * (never the caller's rolled-back `DbClient` — see
 * `notification-recipients.ts`), so they COMMIT for real and are not
 * rolled back by `withRollback`. These rows are left in place, exactly as
 * the existing notification-kernel suite already does.
 */
describe('ApprovalService × NotificationService — B-07 (live DB, real notify() calls)', () => {
  const settingsRepo = new SettingsRepository();

  it('submit (manual mode, default): the step-1 approver gets a real approval_pending in-app notification with a deep link', async () => {
    const svc = buildApprovalServiceWithNotifications();
    await ensureUserLocation(fx.usersByRole[RoleKey.SUPERVISOR], fx.outletId);
    const before = await readOwnNotifications(fx.usersByRole[RoleKey.SUPERVISOR]);

    await withRollback(async (client) => {
      expect(await svc.getMode(client, ApprovalDocumentType.REPLENISHMENT_REQUEST)).toBe(
        ApprovalMode.MANUAL,
      );
      const documentId = randomUUID();
      await svc.submit(client, {
        documentType: ApprovalDocumentType.REPLENISHMENT_REQUEST,
        documentId,
        requestedBy: fx.usersByRole[RoleKey.LEADER_OUTLET],
        amount: '150000.00',
        locationId: fx.outletId,
      });

      const after = await readOwnNotifications(fx.usersByRole[RoleKey.SUPERVISOR]);
      expect(after.length).toBeGreaterThan(before.length);
      const row = after[0]!;
      expect(row.type).toBe('approval_pending');
      expect(row.body).toContain(documentId);
      // B-13 — assert the WHOLE path, not the prefix and the id separately: a
      // link ending at `/approvals/replenishment_request/` with the id loose
      // somewhere else in the body would satisfy two separate `toContain`s and
      // still 404. The route this must resolve to is pinned on the frontend
      // side by `app/approvals/deep-link-route.test.tsx`.
      expect(row.body).toContain(`/approvals/replenishment_request/${documentId}`);
    });
  });

  it('whatsapp mode (void_refund): submit() writes a real whatsapp outbox attempt for the step-1 approver, not just in-app', async () => {
    const svc = buildApprovalServiceWithNotifications();
    const approverId = fx.usersByRole[RoleKey.SUPERVISOR];
    await ensureUserLocation(approverId, fx.outletId);
    await ensureUserContact(approverId, '628111000111', 'spv-b07-test@example.com');

    await withRollback(async (client) => {
      await settingsRepo.upsertApprovalMode(
        client,
        ApprovalDocumentType.VOID_REFUND,
        ApprovalMode.WHATSAPP,
        fx.usersByRole[RoleKey.OWNER],
      );
      const documentId = randomUUID();
      await svc.submit(client, {
        documentType: ApprovalDocumentType.VOID_REFUND,
        documentId,
        requestedBy: fx.usersByRole[RoleKey.KASIR],
        amount: '100000.00',
        locationId: fx.outletId,
      });

      const outboxRows = await readOutboxRows('whatsapp', '628111000111');
      expect(outboxRows.some((r) => r.template_key === 'approval_pending')).toBe(true);
    });
  });

  it("off mode: submit() notifies nobody — no new notification row for the role that would otherwise be step 1's approver", async () => {
    const svc = buildApprovalServiceWithNotifications();
    const approverId = fx.usersByRole[RoleKey.LEADER_OUTLET];
    const wasteId = await createWasteRecord(
      fx.outletId,
      fx.storageAreaOutlet,
      fx.itemId,
      fx.usersByRole[RoleKey.LEADER_OUTLET],
    );
    try {
      const before = await readOwnNotifications(approverId);
      await withRollback(async (client) => {
        await settingsRepo.upsertApprovalMode(
          client,
          ApprovalDocumentType.WASTE,
          ApprovalMode.OFF,
          fx.usersByRole[RoleKey.OWNER],
        );
        await svc.submit(client, {
          documentType: ApprovalDocumentType.WASTE,
          documentId: wasteId,
          requestedBy: fx.usersByRole[RoleKey.LEADER_OUTLET],
          locationId: fx.outletId,
          requestedByRole: RoleKey.LEADER_OUTLET,
        });
      });
      const after = await readOwnNotifications(approverId);
      expect(after.length).toBe(before.length); // off mode: no pending step ever exists, so nobody is told
    } finally {
      await deleteWasteRecord(wasteId);
    }
  });

  it('rejection: the requester is notified of the outcome WITH the reason', async () => {
    const svc = buildApprovalServiceWithNotifications();
    const requesterId = fx.usersByRole[RoleKey.LEADER_OUTLET];
    const reason = 'B07-TEST: barang tidak sesuai pesanan, ditolak oleh Supervisor';

    await withRollback(async (client) => {
      const documentId = randomUUID();
      await svc.submit(client, {
        documentType: ApprovalDocumentType.REPLENISHMENT_REQUEST,
        documentId,
        requestedBy: requesterId,
        amount: '150000.00',
        locationId: fx.outletId,
      });

      await svc.reject(client, {
        documentType: ApprovalDocumentType.REPLENISHMENT_REQUEST,
        documentId,
        currentState: 'submitted',
        actorUserId: fx.usersByRole[RoleKey.SUPERVISOR],
        actorRole: RoleKey.SUPERVISOR,
        reason,
      });

      const rows = await readOwnNotifications(requesterId);
      const decided = rows.find(
        (r) => r.type === 'approval_decided' && r.body.includes(documentId),
      );
      expect(decided).toBeDefined();
      expect(decided!.body).toContain(reason);
      expect(decided!.body).toContain('ditolak'); // outcome mapped to its Indonesian verb, not the raw 'rejected' data value
    });
  });

  it('a failing notification channel never blocks or rolls back the approval itself', async () => {
    const failingNotifications = {
      notify: async () => {
        throw new Error('simulated notify failure');
      },
    } as unknown as NotificationService;
    const svc = new ApprovalService(new ApprovalsRepository(), failingNotifications, getAppPool());

    await withRollback(async (client) => {
      const documentId = randomUUID();
      // Would previously throw straight through submit() if the try/catch-and-log stance were missing.
      const submitted = await svc.submit(client, {
        documentType: ApprovalDocumentType.REPLENISHMENT_REQUEST,
        documentId,
        requestedBy: fx.usersByRole[RoleKey.LEADER_OUTLET],
        amount: '150000.00',
        locationId: fx.outletId,
      });
      expect(submitted.approvalState).toBe('pending');
      expect(submitted.currentStep).toBe(1);

      const decided = await svc.reject(client, {
        documentType: ApprovalDocumentType.REPLENISHMENT_REQUEST,
        documentId,
        currentState: 'submitted',
        actorUserId: fx.usersByRole[RoleKey.SUPERVISOR],
        actorRole: RoleKey.SUPERVISOR,
        reason: 'B07-TEST: notify channel is intentionally broken for this test',
      });
      expect(decided.approvalState).toBe('rejected');
    });
  });
});
