import { randomUUID } from 'node:crypto';
import * as bcrypt from 'bcrypt';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ERR_APPROVAL_STEP_ROLE,
  ERR_AUTH_PIN_INVALID,
  ERR_REASON_REQUIRED,
  PaymentMethod,
  RoleKey,
  VoidRefundType,
} from '@mimi/shared';
import { PosShiftService } from './services/pos-shift.service';
import { PosSaleService } from './services/pos-sale.service';
import { PosVoidRefundService } from './services/pos-void-refund.service';
import { PosCashVarianceService } from './services/pos-cash-variance.service';
import {
  buildApprovalService,
  buildEventBus,
  buildNotificationService,
  buildPaymentVerificationsService,
  buildStockLedgerService,
  buildSyncEmitService,
  closePool,
  getAppPool,
  getOwnerPool,
  loadOutletFixture,
  neutralizeOpenShifts,
  switchActor,
  withRollback,
  type OutletFixture,
} from './test-support/live-db';

/**
 * RBAC negative-path suite (campaign-wide instruction: "RBAC negatives must
 * assert BOTH directions — and for you specifically, prove a Kasir cannot
 * approve their own void"). Every assertion below runs the REAL
 * `ApprovalService`/kernel role gate against the live database as the
 * ACTUAL role being tested (never inspecting the RBAC matrix as a
 * substitute for calling the code) — same live-DB discipline as
 * `pos-shift-flow.integration.test.ts`.
 *
 * Seed users only ever have a PIN for central/supervisor roles
 * (`database/seed.ts`'s `withPin: true` list) — a Kasir has none. To prove
 * the ROLE gate specifically (`ERR_APPROVAL_STEP_ROLE`), not merely the PIN
 * gate (`ERR_AUTH_PIN_INVALID`), the "kasir with a PIN" test temporarily
 * gives the seed Kasir a real bcrypt PIN hash via the OWNER pool and
 * restores the original value in `finally` — the only place this suite
 * durably touches seed data, and it always cleans up.
 */

function services(pool = getAppPool()) {
  const eventBus = buildEventBus();
  const approvals = buildApprovalService();
  const stockLedger = buildStockLedgerService(eventBus);
  const syncEmit = buildSyncEmitService(pool);
  const notifications = buildNotificationService(pool);
  return {
    shifts: new PosShiftService(pool, approvals, notifications),
    sales: new PosSaleService(pool, stockLedger, buildPaymentVerificationsService(pool)),
    voidRefunds: new PosVoidRefundService(
      pool,
      approvals,
      stockLedger,
      syncEmit,
      notifications,
      eventBus,
    ),
    cashVariances: new PosCashVarianceService(pool, approvals),
  };
}

let fx: OutletFixture;

beforeAll(async () => {
  fx = await loadOutletFixture();
}, 30_000);

afterAll(async () => {
  await closePool();
});

/** Opens a shift and completes one cash sale, returning the sale — shared setup for the void-approval tests below. */
async function openShiftWithCashSale(client: PoolClient, svc: ReturnType<typeof services>) {
  await neutralizeOpenShifts(client, fx.locationId);
  const shift = await svc.shifts.open(client, fx.kasirId, {
    clientId: randomUUID(),
    locationId: fx.locationId,
    openingCash: '50000.00',
  });
  const sale = await svc.sales.create(
    client,
    fx.kasirId,
    {
      clientId: randomUUID(),
      shiftId: shift.id,
      locationId: fx.locationId,
      occurredAt: new Date().toISOString(),
      lines: [{ productId: fx.productId, qty: '1.000', unitPrice: fx.productPrice }],
      payments: [{ method: PaymentMethod.CASH, amount: fx.productPrice }],
    },
    { roleKey: 'kasir', locationIds: [fx.locationId] },
  );
  return { shift, sale };
}

describe('POS RBAC — negative and positive paths, live database', () => {
  it('a Kasir with NO pin_hash configured is rejected at the PIN gate before the role gate is ever reached', async () => {
    await withRollback(
      { userId: fx.kasirId, roleKey: 'kasir', locationIds: [fx.locationId] },
      async (client) => {
        const svc = services();
        const { sale } = await openShiftWithCashSale(client, svc);
        const requested = await svc.voidRefunds.requestVoid(client, sale.id, fx.kasirId, {
          clientId: randomUUID(),
          type: VoidRefundType.VOID,
          reason: 'test',
        });

        await expect(
          svc.voidRefunds.approve(
            client,
            requested.voidRefundId,
            fx.kasirId,
            RoleKey.KASIR,
            '000000',
          ),
        ).rejects.toMatchObject({
          response: { code: ERR_AUTH_PIN_INVALID },
        });
      },
    );
  }, 30_000);

  it('a Kasir CANNOT approve their own void even WITH a correct PIN — ApprovalService rejects the role, not just the credential', async () => {
    const KASIR_TEST_PIN = '999999';
    const ownerPool = getOwnerPool();
    const original = await ownerPool.query<{ pin_hash: string | null }>(
      'SELECT pin_hash FROM users WHERE id = $1',
      [fx.kasirId],
    );
    const testHash = await bcrypt.hash(KASIR_TEST_PIN, 10);
    await ownerPool.query('UPDATE users SET pin_hash = $2 WHERE id = $1', [fx.kasirId, testHash]);

    try {
      await withRollback(
        { userId: fx.kasirId, roleKey: 'kasir', locationIds: [fx.locationId] },
        async (client) => {
          const svc = services();
          const { sale } = await openShiftWithCashSale(client, svc);
          const requested = await svc.voidRefunds.requestVoid(client, sale.id, fx.kasirId, {
            clientId: randomUUID(),
            type: VoidRefundType.VOID,
            reason: 'test — kasir self-approval attempt',
          });

          // The PIN is now genuinely valid — proves the REJECTION below is the role gate
          // (`ApprovalService.decide()`'s `resolveEligibleRoles`/`isRoleAuthorized`,
          // `packages/shared/src/approvals/state-machine.ts` §5.2: only SUPERVISOR (+ rank-override
          // MANAGER/OWNER) may act on `void_refund.approve`), not a PIN failure.
          await expect(
            svc.voidRefunds.approve(
              client,
              requested.voidRefundId,
              fx.kasirId,
              RoleKey.KASIR,
              KASIR_TEST_PIN,
            ),
          ).rejects.toMatchObject({
            response: { code: ERR_APPROVAL_STEP_ROLE },
          });

          // And the void is genuinely still pending — the rejected attempt had NO side effect.
          const stillPending = await client.query('SELECT status FROM void_refunds WHERE id = $1', [
            requested.voidRefundId,
          ]);
          expect(stillPending.rows[0].status).toBe('pending');
        },
      );
    } finally {
      await ownerPool.query('UPDATE users SET pin_hash = $2 WHERE id = $1', [
        fx.kasirId,
        original.rows[0]?.pin_hash ?? null,
      ]);
    }
  }, 30_000);

  it('a Supervisor (the eligible role) CAN approve the same void — proves the gate is role-specific, not a blanket block', async () => {
    await withRollback(
      { userId: fx.kasirId, roleKey: 'kasir', locationIds: [fx.locationId] },
      async (client) => {
        const svc = services();
        const { sale } = await openShiftWithCashSale(client, svc);
        const requested = await svc.voidRefunds.requestVoid(client, sale.id, fx.kasirId, {
          clientId: randomUUID(),
          type: VoidRefundType.VOID,
          reason: 'test — supervisor approval path',
        });

        // `verifyPin` reads the ACTING user's own `pin_hash` under `users_select`'s `app_is_self`
        // policy — switch the session to the Supervisor first (see `switchActor`'s header).
        await switchActor(client, {
          userId: fx.supervisorId,
          roleKey: 'supervisor',
          locationIds: [fx.locationId],
        });
        const approved = await svc.voidRefunds.approve(
          client,
          requested.voidRefundId,
          fx.supervisorId,
          RoleKey.SUPERVISOR,
          fx.supervisorPin,
        );
        expect(approved.status).toBe('approved');
      },
    );
  }, 30_000);

  it('a Kasir CANNOT decide a cash-variance proposal (D-19 — online-only, supervisor+ only)', async () => {
    await withRollback(
      { userId: fx.kasirId, roleKey: 'kasir', locationIds: [fx.locationId] },
      async (client) => {
        const svc = services();
        await neutralizeOpenShifts(client, fx.locationId);
        const shift = await svc.shifts.open(client, fx.kasirId, {
          clientId: randomUUID(),
          locationId: fx.locationId,
          openingCash: '50000.00',
        });
        const { report } = await svc.shifts.close(client, shift.id, fx.kasirId, {
          closingCashCounted: '0.00',
        });
        expect(report.cashVarianceProposalId).not.toBeNull();

        await expect(
          svc.cashVariances.approve(
            client,
            report.cashVarianceProposalId!,
            fx.kasirId,
            RoleKey.KASIR,
            'kasir mencoba menyetujui usulan sendiri',
          ),
        ).rejects.toMatchObject({ response: { code: ERR_APPROVAL_STEP_ROLE } });
      },
    );
  }, 30_000);

  it('a Supervisor CAN decide a cash-variance proposal, but a reason is mandatory even to approve (§5.9)', async () => {
    await withRollback(
      { userId: fx.kasirId, roleKey: 'kasir', locationIds: [fx.locationId] },
      async (client) => {
        const svc = services();
        await neutralizeOpenShifts(client, fx.locationId);
        const shift = await svc.shifts.open(client, fx.kasirId, {
          clientId: randomUUID(),
          locationId: fx.locationId,
          openingCash: '50000.00',
        });
        const { report } = await svc.shifts.close(client, shift.id, fx.kasirId, {
          closingCashCounted: '0.00',
        });
        const proposalId = report.cashVarianceProposalId!;

        await expect(
          svc.cashVariances.approve(client, proposalId, fx.supervisorId, RoleKey.SUPERVISOR, ''),
        ).rejects.toMatchObject({
          response: { code: ERR_REASON_REQUIRED },
        });

        const decided = await svc.cashVariances.approve(
          client,
          proposalId,
          fx.supervisorId,
          RoleKey.SUPERVISOR,
          'Disetujui setelah konfirmasi kasir',
        );
        expect(decided.status).toBe('approved');
      },
    );
  }, 30_000);
});
