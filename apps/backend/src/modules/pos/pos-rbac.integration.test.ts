import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ApprovalDocumentType,
  ERR_APPROVAL_CODE_INVALID,
  ERR_APPROVAL_CODE_NOT_ISSUED,
  ERR_APPROVAL_STEP_ROLE,
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
  buildApprovalCodeService,
  clearAuthLockouts,
  buildApprovalService,
  buildEventBus,
  buildNotificationService,
  buildPaymentVerificationsService,
  buildStockLedgerService,
  buildSyncEmitService,
  closePool,
  getAppPool,
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
 * REWRITTEN FOR B-15 (2026-08-22). These tests used to feed a PIN to
 * `voidRefunds.approve` and assert `ERR_AUTH_PIN_INVALID`. That parameter no
 * longer exists: approval is carried by a ONE-TIME CODE the approver issues
 * from their own session, and the kasir at the till merely redeems it.
 *
 * The role gate consequently MOVED, and these tests now pin it where it
 * actually lives — on `ApprovalCodeService.issue`. A kasir is refused a code
 * for their own void before any credential is involved at all, which is a
 * stronger property than the old "a kasir with a valid PIN is still refused":
 * there is nothing for them to hold a valid credential FOR.
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
    approvalCodes: buildApprovalCodeService(pool),
    voidRefunds: new PosVoidRefundService(
      pool,
      approvals,
      buildApprovalCodeService(pool),
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
  // B-15 — a wrong code commits a lockout row that outlives every rollback.
  await clearAuthLockouts();
  fx = await loadOutletFixture();
}, 30_000);

afterAll(async () => {
  await clearAuthLockouts();
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
  it('redeeming before anyone has authorised anything is refused, and does NOT count as a failed attempt', async () => {
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

        // Distinct from a WRONG code on purpose. If "nothing issued" burned an
        // attempt, anyone could lock a till out of service by hammering a void
        // no supervisor had looked at yet — a denial of service handed to the
        // attacker for free, and the mirror image of the mistake Q4 avoided by
        // locking the caller rather than the approver.
        await expect(
          svc.voidRefunds.approve(client, requested.voidRefundId, fx.kasirId, '000000'),
        ).rejects.toMatchObject({
          response: { code: ERR_APPROVAL_CODE_NOT_ISSUED },
        });
      },
    );
  }, 30_000);

  it('a Kasir cannot issue an approval code for their OWN void — the role gate now sits on issue, before any credential exists', async () => {
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

        // §5.2: only SUPERVISOR (+ rank-override MANAGER/OWNER) may act on
        // `void_refund.approve`. `ApprovalCodeService.issue` reads that through
        // the same `resolveEligibleRoles`/`isRoleAuthorized` pair the kernel's
        // own `decide()` uses, so the two cannot disagree about who may approve.
        await expect(
          svc.approvalCodes.issue(client, {
            documentType: ApprovalDocumentType.VOID_REFUND,
            documentId: requested.voidRefundId,
            approver: { userId: fx.kasirId, roleKey: RoleKey.KASIR },
          }),
        ).rejects.toMatchObject({
          response: { code: ERR_APPROVAL_STEP_ROLE },
        });

        const stillPending = await client.query('SELECT status FROM void_refunds WHERE id = $1', [
          requested.voidRefundId,
        ]);
        expect(stillPending.rows[0].status).toBe('pending');
      },
    );
  }, 30_000);

  it('a wrong code is refused even when a real one is outstanding, and the void stays pending', async () => {
    await withRollback(
      { userId: fx.kasirId, roleKey: 'kasir', locationIds: [fx.locationId] },
      async (client) => {
        const svc = services();
        const { sale } = await openShiftWithCashSale(client, svc);
        const requested = await svc.voidRefunds.requestVoid(client, sale.id, fx.kasirId, {
          clientId: randomUUID(),
          type: VoidRefundType.VOID,
          reason: 'test — wrong code',
        });

        await switchActor(client, {
          userId: fx.supervisorId,
          roleKey: 'supervisor',
          locationIds: [fx.locationId],
        });
        const issued = await svc.approvalCodes.issue(client, {
          documentType: ApprovalDocumentType.VOID_REFUND,
          documentId: requested.voidRefundId,
          approver: { userId: fx.supervisorId, roleKey: RoleKey.SUPERVISOR },
        });

        // Deliberately a DIFFERENT six digits from the one just issued.
        const wrong = issued.code === '000000' ? '111111' : '000000';
        await switchActor(client, {
          userId: fx.kasirId,
          roleKey: 'kasir',
          locationIds: [fx.locationId],
        });
        await expect(
          svc.voidRefunds.approve(client, requested.voidRefundId, fx.kasirId, wrong),
        ).rejects.toMatchObject({
          response: { code: ERR_APPROVAL_CODE_INVALID },
        });

        const stillPending = await client.query('SELECT status FROM void_refunds WHERE id = $1', [
          requested.voidRefundId,
        ]);
        expect(stillPending.rows[0].status).toBe('pending');
      },
    );
  }, 30_000);

  it('the supervisor issues, the KASIR redeems, and the decision is recorded against the SUPERVISOR', async () => {
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

        // The supervisor authorises from their own session. In the field they
        // are frequently not at this till at all — that is the entire point of
        // the owner's Q2 (swapped shifts, someone off sick).
        await switchActor(client, {
          userId: fx.supervisorId,
          roleKey: 'supervisor',
          locationIds: [fx.locationId],
        });
        const issued = await svc.approvalCodes.issue(client, {
          documentType: ApprovalDocumentType.VOID_REFUND,
          documentId: requested.voidRefundId,
          approver: { userId: fx.supervisorId, roleKey: RoleKey.SUPERVISOR },
        });
        expect(issued.code).toMatch(/^\d{6}$/);
        // Q3 — the code is bound to the requester, not handed to whoever asks.
        expect(issued.redeemableByUserId).toBe(fx.kasirId);

        // Back at the till: the KASIR's session commits the approval.
        await switchActor(client, {
          userId: fx.kasirId,
          roleKey: 'kasir',
          locationIds: [fx.locationId],
        });
        const approved = await svc.voidRefunds.approve(
          client,
          requested.voidRefundId,
          fx.kasirId,
          issued.code,
        );
        expect(approved.status).toBe('approved');

        // The accountability assertion, and the reason this test exists: the
        // kasir drove the request, but the record must name the supervisor.
        const row = await client.query<{ approved_by: string }>(
          'SELECT approved_by FROM void_refunds WHERE id = $1',
          [requested.voidRefundId],
        );
        expect(row.rows[0]!.approved_by).toBe(fx.supervisorId);
      },
    );
  }, 30_000);

  it('a code is single-use — the same code cannot approve a second time', async () => {
    await withRollback(
      { userId: fx.kasirId, roleKey: 'kasir', locationIds: [fx.locationId] },
      async (client) => {
        const svc = services();
        const { sale } = await openShiftWithCashSale(client, svc);
        const requested = await svc.voidRefunds.requestVoid(client, sale.id, fx.kasirId, {
          clientId: randomUUID(),
          type: VoidRefundType.VOID,
          reason: 'test — replay',
        });

        await switchActor(client, {
          userId: fx.supervisorId,
          roleKey: 'supervisor',
          locationIds: [fx.locationId],
        });
        const issued = await svc.approvalCodes.issue(client, {
          documentType: ApprovalDocumentType.VOID_REFUND,
          documentId: requested.voidRefundId,
          approver: { userId: fx.supervisorId, roleKey: RoleKey.SUPERVISOR },
        });
        await switchActor(client, {
          userId: fx.kasirId,
          roleKey: 'kasir',
          locationIds: [fx.locationId],
        });
        await svc.voidRefunds.approve(client, requested.voidRefundId, fx.kasirId, issued.code);

        // Second use: the row is `consumed`, so there is no ACTIVE code to find
        // — the same answer a caller gets before anything was issued.
        await expect(
          svc.voidRefunds.approve(client, requested.voidRefundId, fx.kasirId, issued.code),
        ).rejects.toMatchObject({
          response: { code: ERR_APPROVAL_CODE_NOT_ISSUED },
        });
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
