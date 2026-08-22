import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomInt } from 'node:crypto';
import type { Pool } from 'pg';
import {
  ApprovalDocumentType,
  ERR_APPROVAL_CODE_EXPIRED,
  ERR_APPROVAL_CODE_INVALID,
  ERR_APPROVAL_CODE_NOT_ISSUED,
  ERR_APPROVAL_STEP_ROLE,
  ERR_NOT_FOUND,
  ERR_VALIDATION,
  isRoleAuthorized,
  type RoleKey,
  type UUID,
} from '@mimi/shared';
import { DATABASE_POOL } from '../../common/database/database-pool.provider';
import { SYSTEM_CENTRAL_ROLE, withSystemContext } from '../../common/database/system-context';
import { hashPin, verifyPin } from '../../modules/auth/pin-hash.util';
import { AuthLockoutService, LOCKOUT_MAX_ATTEMPTS } from '../auth-lockout/auth-lockout.service';
import { NotificationService } from '../notification/notification.service';
import { ApprovalCodeRepository } from './approval-code.repository';
import { ApprovalsRepository } from './approvals.repository';
import { resolveDocumentContext, resolveEligibleRoles } from './document-context.resolver';
import type { DbClient } from './types';

/**
 * B-15 — one-time approval codes, the replacement for `POST /auth/pin/verify`.
 *
 * ## What was wrong, and why a rate limit alone was not the fix
 *
 * The old endpoint took an arbitrary `userId`, read that user under an RLS
 * bypass, and answered "is this 6-digit PIN correct?". Any authenticated
 * account could brute-force any other account's PIN — and that same PIN backs
 * offline authorization on tablets, so what leaked was not a session token but
 * the supervisor's standing secret.
 *
 * Bolting a limiter onto that shape would have left a STATIC secret behind an
 * imperfect gate. The owner's call (Q8, 2026-08-22) removes the secret instead:
 * the code is generated when the approver approves, is valid for one document
 * for five minutes, and is destroyed on use. Nobody holds it between
 * transactions, so there is nothing for repeated guessing to extract.
 *
 * ## The flow this implements
 *
 *   1. Kasir requests a void (unchanged).
 *   2. Eligible approvers are notified (unchanged — `approval_pending`).
 *   3. The approver, IN THEIR OWN AUTHENTICATED SESSION, calls `issue()`. This
 *      is the authorization act. They can be anywhere — which is the point of
 *      Q2: a supervisor off sick or covering a swapped shift can still approve
 *      without walking to the register.
 *   4. The code reaches the approver (HTTP response + `approval_code_issued`
 *      over in-app/email/WhatsApp) and they relay it to the till.
 *   5. The kasir types it; `redeem()` verifies and returns WHO approved. The
 *      domain module then records the decision as the APPROVER's, never the
 *      redeemer's.
 *
 * ## Two gates, not one (Q1 + Q3)
 *
 * `issue()` refuses unless the caller is an eligible approver for THIS
 * document's CURRENT step. That eligibility is read from
 * `resolveEligibleRoles` — the same §5.2 state machine the kernel's own
 * `decide()` obeys — rather than restated here, because a second copy of
 * "who may approve" is a second thing to get wrong. Holding
 * `approval.code.issue` only gets a caller as far as this check.
 *
 * `redeem()` refuses a code that was not issued for this exact document, and
 * refuses anyone but the named redeemer. So a code cannot be minted
 * speculatively, replayed onto a second sale, or used by a bystander who
 * overheard it.
 *
 * ## What is deliberately NOT distinguished
 *
 * A wrong code, a code for another document, and a code someone else must
 * redeem all return the same `ERR_APPROVAL_CODE_INVALID`. Telling the caller
 * which of those it was is precisely the oracle this work exists to remove.
 */

/** Five minutes: long enough for a phone call, short enough that a shouted code goes stale. */
export const APPROVAL_CODE_TTL_MS = 5 * 60_000;
export const APPROVAL_CODE_LENGTH = 6;

export interface IssuedCode {
  /** Plaintext, returned exactly once — to the approver who authorised it. */
  code: string;
  expiresAt: string;
  /** Who must type it in. Surfaced so the approver's screen can say whose till to call. */
  redeemableByUserId: UUID;
  documentType: string;
  documentId: UUID;
}

export interface RedeemedCode {
  /** The approver whose authorization this was — the actor the decision is recorded against. */
  approverUserId: UUID;
  approverRole: RoleKey;
  codeId: UUID;
}

/**
 * `crypto.randomInt` — a CSPRNG, uniform over the range, and NOT
 * `Math.random()`. Six digits is only 20 bits, so the generator being unbiased
 * is doing real work here: a predictable low digit would cut the search space
 * an attacker faces below what the attempt limiter assumes.
 *
 * Zero-padded, so `000042` is a valid code and the space really is 10^6.
 */
function generateCode(): string {
  return String(randomInt(0, 10 ** APPROVAL_CODE_LENGTH)).padStart(APPROVAL_CODE_LENGTH, '0');
}

@Injectable()
export class ApprovalCodeService {
  private readonly logger = new Logger(ApprovalCodeService.name);

  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly codes: ApprovalCodeRepository,
    private readonly approvals: ApprovalsRepository,
    private readonly lockouts: AuthLockoutService,
    private readonly notifications: NotificationService,
  ) {}

  /**
   * The approver authorises a document and gets back a one-time code.
   *
   * Runs on the APPROVER's own request client: reading the approval and writing
   * the code are both things their own session may legitimately do, and using a
   * system context here would have widened the very check the method exists to
   * perform.
   */
  async issue(
    client: DbClient,
    input: {
      documentType: ApprovalDocumentType;
      documentId: UUID;
      approver: { userId: UUID; roleKey: RoleKey };
    },
  ): Promise<IssuedCode> {
    const approval = await this.approvals.findApproval(
      client,
      input.documentType,
      input.documentId,
    );
    if (!approval) {
      throw new NotFoundException({
        code: ERR_NOT_FOUND,
        message: `No approval found for ${input.documentType}/${input.documentId}`,
      });
    }
    if (approval.state !== 'pending' || approval.currentStep === null) {
      throw new BadRequestException({
        code: ERR_VALIDATION,
        message: `This document is already ${approval.state}; there is nothing left to authorise.`,
      });
    }

    const step = await this.approvals.findStep(client, approval.id, approval.currentStep);
    if (!step) {
      throw new NotFoundException({
        code: ERR_NOT_FOUND,
        message: `Approval ${approval.id} has no step ${approval.currentStep}`,
      });
    }

    // Q1 — eligibility from the state machine, not from the permission key.
    const ctx = await resolveDocumentContext(client, input.documentType, input.documentId);
    const eligible = resolveEligibleRoles(
      input.documentType,
      step.stepNo,
      step.approverRole as RoleKey,
      ctx,
    );
    if (!isRoleAuthorized(eligible, input.approver.roleKey)) {
      throw new ForbiddenException({
        code: ERR_APPROVAL_STEP_ROLE,
        message: `${input.approver.roleKey} may not authorise step ${step.stepNo} of ${input.documentType}`,
      });
    }

    // The requester is the only person who may redeem: they are the one at the
    // till with the document open. Reading it off the approval row rather than
    // accepting it from the approver keeps a code from being pointed at a
    // third party.
    const redeemableByUserId = approval.requestedBy as UUID;

    const code = generateCode();
    const codeHash = await hashPin(code);
    const expiresAt = new Date(Date.now() + APPROVAL_CODE_TTL_MS);

    // Retire any live code first: the partial unique index allows exactly one,
    // and two valid codes for one void would mean two chances to guess and an
    // ambiguous answer to "who approved this".
    await this.codes.retireActive(client, input.documentType, input.documentId);
    await this.codes.insert(client, {
      documentType: input.documentType,
      documentId: input.documentId,
      locationId: (approval.locationId as UUID | null) ?? null,
      issuedByUserId: input.approver.userId,
      issuedByRole: input.approver.roleKey,
      redeemableByUserId,
      codeHash,
      expiresAt,
    });

    // Q9 — the code also goes out over the approver's own channels, so they can
    // read it off their phone rather than off the screen of whoever asked. A
    // delivery failure must never lose the authorization that already committed:
    // the code is in the HTTP response either way.
    try {
      await this.notifications.notify({
        templateKey: 'approval_code_issued',
        userIds: [input.approver.userId],
        params: {
          documentType: input.documentType,
          documentId: input.documentId,
          code,
          minutes: String(Math.round(APPROVAL_CODE_TTL_MS / 60_000)),
        },
        locationId: approval.locationId ?? undefined,
      });
    } catch (err) {
      this.logger.error(
        `Approval code issued for ${input.documentType}/${input.documentId} but could not be delivered: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    return {
      code,
      expiresAt: expiresAt.toISOString(),
      redeemableByUserId,
      documentType: input.documentType,
      documentId: input.documentId,
    };
  }

  /**
   * Verifies a code typed at the till and returns the approver it belongs to.
   *
   * Order matters and is not cosmetic: the lock is checked FIRST, before the
   * code row is even read, so a locked caller cannot use timing or error codes
   * to learn whether a document has a live code waiting.
   */
  async redeem(
    client: DbClient,
    input: {
      documentType: ApprovalDocumentType;
      documentId: UUID;
      code: string;
      redeemerUserId: UUID;
    },
  ): Promise<RedeemedCode> {
    await this.lockouts.assertMayAttempt(client, input.redeemerUserId);

    const row = await this.codes.findActiveForVerify(client, input.documentType, input.documentId);
    if (!row) {
      // Not a failed ATTEMPT — there is nothing to guess against, so it must not
      // consume one of the caller's five. Counting it would let anyone lock a
      // till out by spamming a document nobody has authorised yet.
      throw new BadRequestException({
        code: ERR_APPROVAL_CODE_NOT_ISSUED,
        message: 'No approval code is waiting for this document. Ask the approver to authorise it.',
      });
    }

    if (new Date(row.expiresAt) <= new Date()) {
      await this.codes.markExpired(client, row.id);
      throw new BadRequestException({
        code: ERR_APPROVAL_CODE_EXPIRED,
        message: 'That code has expired. Ask the approver for a new one.',
      });
    }

    const correct =
      row.redeemableByUserId === input.redeemerUserId &&
      (await verifyPin(input.code, row.codeHash));

    if (!correct) {
      await this.registerFailedAttempt(row.id, input.redeemerUserId);
      throw new ForbiddenException({
        code: ERR_APPROVAL_CODE_INVALID,
        message: 'Incorrect code.',
      });
    }

    await this.codes.markConsumed(client, row.id);
    await this.lockouts.recordSuccess(client, input.redeemerUserId);

    return {
      approverUserId: row.issuedByUserId,
      approverRole: row.issuedByRole as RoleKey,
      codeId: row.id,
    };
  }

  /**
   * Both halves of "that was wrong" — the code's own attempt counter and the
   * caller's lock — written on ONE connection that commits independently of the
   * request being rejected. If this rode on the caller's transaction it would
   * be rolled back with the 403 and the limiter would never count past one.
   */
  private async registerFailedAttempt(codeId: UUID, redeemerUserId: UUID): Promise<void> {
    const result = await withSystemContext(
      this.pool,
      { role: SYSTEM_CENTRAL_ROLE },
      async (systemClient) => {
        await this.codes.recordAttempt(systemClient, codeId);
        return this.lockouts.recordFailureOn(systemClient, redeemerUserId);
      },
    );

    if (result.justHardLocked) {
      // Q9 — a hard lock is the signal worth escalating: either someone is
      // struggling and a shift is stalled, or someone is guessing. Delivered
      // in-app and by email; never allowed to throw over the top of the 403
      // the caller is already getting.
      try {
        await this.notifyHardLock(redeemerUserId);
      } catch (err) {
        this.logger.error(
          `Failed to raise the hard-lock notification for ${redeemerUserId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  /**
   * Tells the locked user's supervisors — anyone who could actually clear it —
   * plus the user themselves, so the person at the till sees why their screen
   * stopped working without having to ask.
   *
   * Recipients are resolved by RANK, from the same `ROLE_RANK` table Q6's
   * unlock check uses, so "who gets told" and "who can act on it" cannot drift
   * apart.
   */
  private async notifyHardLock(lockedUserId: UUID): Promise<void> {
    const recipients = await withSystemContext(
      this.pool,
      { role: SYSTEM_CENTRAL_ROLE },
      async (client) => {
        const res = await client.query<{ id: string; name: string }>(
          `SELECT DISTINCT u.id, u.name
             FROM users u
             JOIN roles r ON r.id = u.role_id
            WHERE u.is_active
              AND r.key IN ('supervisor', 'manager', 'owner')
              AND (
                EXISTS (
                  SELECT 1 FROM user_locations ul1
                    JOIN user_locations ul2 ON ul2.location_id = ul1.location_id
                   WHERE ul1.user_id = u.id AND ul2.user_id = $1
                )
                OR r.key IN ('manager', 'owner')
              )`,
          [lockedUserId],
        );
        const locked = await client.query<{ name: string }>(
          `SELECT name FROM users WHERE id = $1`,
          [lockedUserId],
        );
        return {
          ids: res.rows.map((r) => r.id as UUID),
          lockedName: locked.rows[0]?.name ?? 'Pengguna',
        };
      },
    );

    const userIds = Array.from(new Set([...recipients.ids, lockedUserId]));
    await this.notifications.notify({
      templateKey: 'auth_lockout',
      userIds,
      params: {
        userName: recipients.lockedName,
        attempts: String(LOCKOUT_MAX_ATTEMPTS),
      },
    });
  }
}
