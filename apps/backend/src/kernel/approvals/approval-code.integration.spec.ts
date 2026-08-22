import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ApprovalDocumentType,
  ERR_APPROVAL_CODE_EXPIRED,
  ERR_APPROVAL_CODE_INVALID,
  ERR_APPROVAL_CODE_LOCKED,
  ERR_APPROVAL_STEP_ROLE,
  RoleKey,
} from '@mimi/shared';
import { AuthLockoutService, LOCKOUT_MAX_ATTEMPTS } from '../auth-lockout/auth-lockout.service';
import { NotificationService } from '../notification/notification.service';
import { ApprovalCodeRepository } from './approval-code.repository';
import { ApprovalCodeService } from './approval-code.service';
import { ApprovalsRepository } from './approvals.repository';
import { ApprovalService } from './approvals.service';
import {
  closePool,
  createWasteRecord,
  deleteWasteRecord,
  type Fixtures,
  getAppPool,
  getOwnerPool,
  loadFixtures,
  withRollback,
} from './test-support/live-db';

/**
 * B-15 — the one-time approval code, end to end against the live database.
 *
 * This suite replaces what `POST /auth/pin/verify` used to do and is the
 * evidence that the oracle is actually gone rather than merely renamed. It
 * drives the REAL services (no stubs but the notification sink) so the
 * assertions cover the RLS policies, the partial unique index and the argon2
 * verify, not just the TypeScript.
 *
 * WHY WASTE AND NOT VOID/REFUND: this is the approvals KERNEL's own suite, and
 * `waste_records` is the fixture it already owns. The POS void path — the one
 * the owner actually asked about — is covered where it lives, in
 * `modules/pos/pos-rbac.integration.test.ts`. Testing the mechanism here and
 * the money flow there keeps each suite honest about what it proves.
 *
 * A note on the lockout tests: they cannot run inside the caller's rolled-back
 * transaction, because `recordFailure` deliberately COMMITS on its own
 * connection (a security counter that a failing request could roll back would
 * count to one forever). They therefore clean up after themselves through the
 * owner pool, and say so.
 */

const hasDb = Boolean(process.env.DATABASE_URL);

function codeService(): ApprovalCodeService {
  const pool = getAppPool();
  const notifications = {
    // The delivery channels are exercised in `kernel/notification`'s own suite.
    // Here a sink keeps the test about authorization, and would make a silent
    // "never notified" regression invisible — so the issue test asserts on the
    // call itself rather than trusting this stub.
    notify: async () => ({ inApp: [], email: [], whatsapp: [] }),
  } as unknown as NotificationService;
  return new ApprovalCodeService(
    pool,
    new ApprovalCodeRepository(),
    new ApprovalsRepository(),
    new AuthLockoutService(pool),
    notifications,
  );
}

function approvalService(): ApprovalService {
  return new ApprovalService(new ApprovalsRepository());
}

async function clearLockout(userId: string): Promise<void> {
  await getOwnerPool().query('DELETE FROM auth_lockouts WHERE user_id = $1', [userId]);
}

/**
 * Reads committed lockout state over the OWNER pool.
 *
 * Deliberately raw SQL rather than `AuthLockoutService.find`: the point of
 * these assertions is that the row is REALLY THERE, committed by a different
 * connection. Reading it back through the same service that wrote it would
 * leave a caching or transaction-scoping bug invisible.
 */
async function readLockout(
  userId: string,
): Promise<{ failed_count: number; hard_locked: boolean; locked_until: Date | null } | null> {
  const res = await getOwnerPool().query<{
    failed_count: number;
    hard_locked: boolean;
    locked_until: Date | null;
  }>('SELECT failed_count, hard_locked, locked_until FROM auth_lockouts WHERE user_id = $1', [
    userId,
  ]);
  return res.rows[0] ?? null;
}

let fx: Fixtures;

beforeAll(async () => {
  if (!hasDb) return;
  fx = await loadFixtures();
});

afterAll(async () => {
  if (!hasDb) return;
  await closePool();
});

describe.skipIf(!hasDb)('B-15 approval codes — live DB', () => {
  it('an eligible approver gets a six-digit code bound to the requester, and the plaintext is NOT what is stored', async () => {
    const wasteId = await createWasteRecord(
      fx.outletId,
      fx.storageAreaOutlet,
      fx.itemId,
      fx.usersByRole[RoleKey.LEADER_OUTLET],
    );
    try {
      await withRollback(async (client) => {
        await approvalService().submit(client, {
          documentType: ApprovalDocumentType.WASTE,
          documentId: wasteId,
          requestedBy: fx.usersByRole[RoleKey.LEADER_OUTLET],
          locationId: fx.outletId,
        });

        const issued = await codeService().issue(client, {
          documentType: ApprovalDocumentType.WASTE,
          documentId: wasteId,
          approver: {
            userId: fx.usersByRole[RoleKey.SUPERVISOR],
            roleKey: RoleKey.SUPERVISOR,
          },
        });

        expect(issued.code).toMatch(/^\d{6}$/);
        expect(issued.redeemableByUserId).toBe(fx.usersByRole[RoleKey.LEADER_OUTLET]);
        expect(new Date(issued.expiresAt).getTime()).toBeGreaterThan(Date.now());

        // The stored value must be an argon2id PHC hash, never the code. If this
        // ever regresses to plaintext, a database read hands back a live
        // authorization — which is most of what made the old PIN endpoint bad.
        const stored = await client.query<{ code_hash: string; state: string }>(
          `SELECT code_hash, state FROM approval_codes WHERE document_id = $1`,
          [wasteId],
        );
        expect(stored.rows[0]!.state).toBe('active');
        expect(stored.rows[0]!.code_hash).toMatch(/^\$argon2id\$/);
        expect(stored.rows[0]!.code_hash).not.toContain(issued.code);
      });
    } finally {
      await deleteWasteRecord(wasteId);
    }
  }, 30_000);

  it('a role the state machine does not name as an approver cannot issue a code at all', async () => {
    const wasteId = await createWasteRecord(
      fx.outletId,
      fx.storageAreaOutlet,
      fx.itemId,
      fx.usersByRole[RoleKey.LEADER_OUTLET],
    );
    try {
      await withRollback(async (client) => {
        await approvalService().submit(client, {
          documentType: ApprovalDocumentType.WASTE,
          documentId: wasteId,
          requestedBy: fx.usersByRole[RoleKey.LEADER_OUTLET],
          locationId: fx.outletId,
        });

        // A driver holds no approval authority anywhere in §5.2. Note this is
        // NOT the permission-key check (that lives on the controller): it is the
        // per-step eligibility check, which is what makes holding
        // `approval.code.issue` insufficient on its own.
        await expect(
          codeService().issue(client, {
            documentType: ApprovalDocumentType.WASTE,
            documentId: wasteId,
            approver: { userId: fx.usersByRole[RoleKey.DRIVER], roleKey: RoleKey.DRIVER },
          }),
        ).rejects.toMatchObject({ response: { code: ERR_APPROVAL_STEP_ROLE } });
      });
    } finally {
      await deleteWasteRecord(wasteId);
    }
  }, 30_000);

  it('re-issuing supersedes the previous code — the old one stops working, and only one is ever live', async () => {
    const wasteId = await createWasteRecord(
      fx.outletId,
      fx.storageAreaOutlet,
      fx.itemId,
      fx.usersByRole[RoleKey.LEADER_OUTLET],
    );
    try {
      await withRollback(async (client) => {
        await approvalService().submit(client, {
          documentType: ApprovalDocumentType.WASTE,
          documentId: wasteId,
          requestedBy: fx.usersByRole[RoleKey.LEADER_OUTLET],
          locationId: fx.outletId,
        });
        const svc = codeService();
        const approver = {
          userId: fx.usersByRole[RoleKey.SUPERVISOR],
          roleKey: RoleKey.SUPERVISOR,
        };
        const first = await svc.issue(client, {
          documentType: ApprovalDocumentType.WASTE,
          documentId: wasteId,
          approver,
        });
        const second = await svc.issue(client, {
          documentType: ApprovalDocumentType.WASTE,
          documentId: wasteId,
          approver,
        });
        expect(second.code).not.toBe(first.code);

        const states = await client.query<{ state: string }>(
          `SELECT state FROM approval_codes WHERE document_id = $1 ORDER BY created_at`,
          [wasteId],
        );
        expect(states.rows.map((r) => r.state)).toEqual(['superseded', 'active']);

        // Two live codes for one document would mean two chances to guess, and
        // an ambiguous answer to "who authorised this".
        await expect(
          svc.redeem(client, {
            documentType: ApprovalDocumentType.WASTE,
            documentId: wasteId,
            code: first.code,
            redeemerUserId: fx.usersByRole[RoleKey.LEADER_OUTLET],
          }),
        ).rejects.toMatchObject({ response: { code: ERR_APPROVAL_CODE_INVALID } });
      });
    } finally {
      await deleteWasteRecord(wasteId);
      await clearLockout(fx.usersByRole[RoleKey.LEADER_OUTLET]);
    }
  }, 30_000);

  it('someone other than the named redeemer cannot spend a code they have the digits for', async () => {
    const wasteId = await createWasteRecord(
      fx.outletId,
      fx.storageAreaOutlet,
      fx.itemId,
      fx.usersByRole[RoleKey.LEADER_OUTLET],
    );
    try {
      await withRollback(async (client) => {
        await approvalService().submit(client, {
          documentType: ApprovalDocumentType.WASTE,
          documentId: wasteId,
          requestedBy: fx.usersByRole[RoleKey.LEADER_OUTLET],
          locationId: fx.outletId,
        });
        const svc = codeService();
        const issued = await svc.issue(client, {
          documentType: ApprovalDocumentType.WASTE,
          documentId: wasteId,
          approver: {
            userId: fx.usersByRole[RoleKey.SUPERVISOR],
            roleKey: RoleKey.SUPERVISOR,
          },
        });

        // The correct digits, in the wrong hands. This is the "overheard the
        // code" case, and it must fail with the SAME error as a wrong guess —
        // telling the holder that the code was right but they are the wrong
        // person is itself information worth not giving away.
        await expect(
          svc.redeem(client, {
            documentType: ApprovalDocumentType.WASTE,
            documentId: wasteId,
            code: issued.code,
            redeemerUserId: fx.usersByRole[RoleKey.KASIR],
          }),
        ).rejects.toMatchObject({ response: { code: ERR_APPROVAL_CODE_INVALID } });
      });
    } finally {
      await deleteWasteRecord(wasteId);
      await clearLockout(fx.usersByRole[RoleKey.KASIR]);
    }
  }, 30_000);

  it('an expired code is reported as expired, not as a wrong guess', async () => {
    const wasteId = await createWasteRecord(
      fx.outletId,
      fx.storageAreaOutlet,
      fx.itemId,
      fx.usersByRole[RoleKey.LEADER_OUTLET],
    );
    try {
      await withRollback(async (client) => {
        await approvalService().submit(client, {
          documentType: ApprovalDocumentType.WASTE,
          documentId: wasteId,
          requestedBy: fx.usersByRole[RoleKey.LEADER_OUTLET],
          locationId: fx.outletId,
        });
        const svc = codeService();
        const issued = await svc.issue(client, {
          documentType: ApprovalDocumentType.WASTE,
          documentId: wasteId,
          approver: {
            userId: fx.usersByRole[RoleKey.SUPERVISOR],
            roleKey: RoleKey.SUPERVISOR,
          },
        });

        // Age it inside this transaction rather than waiting five minutes.
        await client.query(
          `UPDATE approval_codes SET expires_at = NOW() - INTERVAL '1 second' WHERE document_id = $1 AND state = 'active'`,
          [wasteId],
        );

        await expect(
          svc.redeem(client, {
            documentType: ApprovalDocumentType.WASTE,
            documentId: wasteId,
            code: issued.code,
            redeemerUserId: fx.usersByRole[RoleKey.LEADER_OUTLET],
          }),
        ).rejects.toMatchObject({ response: { code: ERR_APPROVAL_CODE_EXPIRED } });

        // Expiry is a distinct outcome from a bad guess ON PURPOSE: it is not
        // a security signal (anyone can wait five minutes), and telling the
        // cashier "ask for a new one" instead of "wrong code" is the difference
        // between a working till and a queue.
        const state = await client.query<{ state: string }>(
          `SELECT state FROM approval_codes WHERE document_id = $1`,
          [wasteId],
        );
        expect(state.rows[0]!.state).toBe('expired');
      });
    } finally {
      await deleteWasteRecord(wasteId);
    }
  }, 30_000);
});

describe.skipIf(!hasDb)('B-15 caller lockout — live DB, deliberately NOT rolled back', () => {
  /**
   * These run against committed state because that is the property under test:
   * `recordFailure` opens its own transaction and COMMITs, precisely so that
   * rolling back the rejected request cannot erase the count. A test that ran
   * inside a rollback would pass while proving the opposite of what it claims.
   */
  it('counts failures across separate transactions, backs off, then hard-locks the CALLER (never the approver)', async () => {
    const caller = fx.usersByRole[RoleKey.KASIR];
    const approver = fx.usersByRole[RoleKey.SUPERVISOR];
    await clearLockout(caller);
    await clearLockout(approver);
    const lockouts = new AuthLockoutService(getAppPool());

    try {
      const base = new Date();
      for (let attempt = 1; attempt <= LOCKOUT_MAX_ATTEMPTS; attempt += 1) {
        const state = await lockouts.recordFailure(caller, base);
        expect(state.failedCount).toBe(attempt);

        if (attempt === 3) expect(state.lockedUntil).not.toBeNull(); // 30s backoff
        if (attempt === 4) expect(state.lockedUntil).not.toBeNull(); // 2m backoff
        if (attempt < LOCKOUT_MAX_ATTEMPTS) expect(state.hardLocked).toBe(false);
      }

      const finalState = await readLockout(caller);
      expect(finalState?.hard_locked).toBe(true);
      expect(finalState?.failed_count).toBe(LOCKOUT_MAX_ATTEMPTS);

      // Q4, stated as an assertion: the approver whose code was being guessed
      // is untouched. A per-target lockout here would have handed any kasir a
      // way to disable their supervisor mid-shift.
      expect(await readLockout(approver)).toBeNull();
    } finally {
      await clearLockout(caller);
      await clearLockout(approver);
    }
  }, 30_000);

  it('only a HIGHER-ranked user can clear a hard lock; a peer cannot', async () => {
    const caller = fx.usersByRole[RoleKey.KASIR];
    await clearLockout(caller);
    const lockouts = new AuthLockoutService(getAppPool());

    try {
      for (let i = 0; i < LOCKOUT_MAX_ATTEMPTS; i += 1) {
        await lockouts.recordFailure(caller);
      }

      // A peer — same rank — is refused. This is what stops two cashiers
      // taking turns to unlock each other and guess all day.
      await expect(
        lockouts.clear(caller, {
          userId: fx.usersByRole[RoleKey.DRIVER],
          roleKey: RoleKey.DRIVER,
        }),
      ).rejects.toMatchObject({ response: { code: 'ERR_FORBIDDEN' } });

      const cleared = await lockouts.clear(caller, {
        userId: fx.usersByRole[RoleKey.SUPERVISOR],
        roleKey: RoleKey.SUPERVISOR,
      });
      expect(cleared?.hardLocked).toBe(false);
      expect(cleared?.failedCount).toBe(0);
    } finally {
      await clearLockout(caller);
    }
  }, 30_000);

  it('a locked caller is refused before the code row is even read', async () => {
    const caller = fx.usersByRole[RoleKey.LEADER_OUTLET];
    await clearLockout(caller);
    const lockouts = new AuthLockoutService(getAppPool());
    try {
      for (let i = 0; i < LOCKOUT_MAX_ATTEMPTS; i += 1) {
        await lockouts.recordFailure(caller);
      }

      // No document, no code — and still `LOCKED`, not `NOT_ISSUED`. That
      // ordering is the point: a locked caller must not be able to use this
      // endpoint to discover which documents have a code waiting.
      await withRollback(async (client) => {
        await expect(
          codeService().redeem(client, {
            documentType: ApprovalDocumentType.WASTE,
            documentId: '00000000-0000-0000-0000-000000000000',
            code: '123456',
            redeemerUserId: caller,
          }),
        ).rejects.toMatchObject({ response: { code: ERR_APPROVAL_CODE_LOCKED } });
      });
    } finally {
      await clearLockout(caller);
    }
  }, 30_000);
});
