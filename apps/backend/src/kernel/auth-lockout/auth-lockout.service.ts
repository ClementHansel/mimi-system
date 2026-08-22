import { ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  ERR_APPROVAL_CODE_LOCKED,
  ERR_FORBIDDEN,
  ERR_NOT_FOUND,
  ROLE_RANK,
  type RoleKey,
  type UUID,
} from '@mimi/shared';
import type { Pool, PoolClient } from 'pg';
import { DATABASE_POOL } from '../../common/database/database-pool.provider';
import { SYSTEM_CENTRAL_ROLE, withSystemContext } from '../../common/database/system-context';

/**
 * B-15 (owner decisions, 2026-08-22) — the attempt limiter behind one-time
 * approval codes.
 *
 * THE DECISION THAT SHAPES THIS FILE (Q4): failures lock the **caller** — the
 * person typing a code at the till — and never the approver whose code it is.
 * The obvious design (lock the account being verified) was rejected because it
 * hands any kasir a way to disable their own supervisor mid-shift by burning
 * the attempts on purpose. Locking the caller inverts that: the only account an
 * attacker can take out of service by guessing is their own.
 *
 * The ladder (Q5, owner-accepted defaults):
 *
 *   attempts 1–2   no delay — a mistyped digit is not an attack
 *   attempt 3      30-second backoff
 *   attempt 4      2-minute backoff
 *   attempt 5      HARD LOCK, cleared only by a higher-ranked user (Q6)
 *
 * Failures age out after a 15-minute window, and any SUCCESS resets the row
 * completely, so ordinary fat-fingering spread across a shift never
 * accumulates into a lock.
 *
 * ## Why the failure write does not use the caller's client
 *
 * A wrong code THROWS, and a thrown request is rolled back — by the route's own
 * error path and unconditionally by `RlsCleanupInterceptor`. Recording the
 * failure on the caller's transaction would therefore roll it back too, and the
 * limiter would count to one forever while an attacker guessed all day. This is
 * the same class of defect as "THE BIG ONE" (writes that returned 201 and
 * silently rolled back), except here the silence would be a security control
 * that does nothing.
 *
 * So `recordFailure` and `clear` run through `withSystemContext`, which owns
 * its own connection and COMMITs independently of the request that failed.
 * `recordSuccess` deliberately does NOT: a success only counts if the
 * transaction it authorised actually commits, and if the void rolls back then
 * so did the code consumption, so the attempt never really happened.
 *
 * Q6's escalation is a `ROLE_RANK` comparison, not a permission key: holding
 * `auth.lockout.clear` gets a supervisor as far as this service, which then
 * requires the clearer to STRICTLY outrank the locked user. So a supervisor
 * frees a kasir, a manager frees a supervisor, and no one frees a peer — which
 * is what stops two colluding cashiers taking turns to guess.
 */

/** Failures older than this stop counting toward a lock. */
export const LOCKOUT_WINDOW_MS = 15 * 60_000;
/** The failure count at which the lock becomes terminal. */
export const LOCKOUT_MAX_ATTEMPTS = 5;
/** Progressive backoff in ms, indexed by failure count. Counts below the first entry are free. */
export const BACKOFF_BY_FAILURE_COUNT: Readonly<Record<number, number>> = {
  3: 30_000,
  4: 120_000,
};

export interface LockoutState {
  userId: UUID;
  failedCount: number;
  /** Short backoff currently in force, if any. */
  lockedUntil: string | null;
  hardLocked: boolean;
  hardLockedAt: string | null;
}

interface LockoutRow {
  user_id: string;
  failed_count: number;
  window_started_at: Date;
  last_failed_at: Date | null;
  locked_until: Date | null;
  hard_locked: boolean;
  hard_locked_at: Date | null;
}

function mapRow(row: LockoutRow): LockoutState {
  return {
    userId: row.user_id as UUID,
    failedCount: row.failed_count,
    lockedUntil: row.locked_until ? row.locked_until.toISOString() : null,
    hardLocked: row.hard_locked,
    hardLockedAt: row.hard_locked_at ? row.hard_locked_at.toISOString() : null,
  };
}

@Injectable()
export class AuthLockoutService {
  private readonly logger = new Logger(AuthLockoutService.name);

  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  /**
   * Throws if `userId` may not attempt a code right now. Call this BEFORE any
   * verification work — including before reading the code row — so a locked
   * caller cannot use the endpoint to probe which documents have a live code,
   * which would be a smaller oracle of exactly the kind B-15 is about.
   */
  async assertMayAttempt(client: PoolClient, userId: UUID, now = new Date()): Promise<void> {
    const state = await this.find(client, userId);
    if (!state) return;

    if (state.hardLocked) {
      throw new ForbiddenException({
        code: ERR_APPROVAL_CODE_LOCKED,
        message:
          'Too many incorrect codes. Someone more senior must unlock this account before it can try again.',
        details: { hardLocked: true },
      });
    }

    if (state.lockedUntil && new Date(state.lockedUntil) > now) {
      const retryAfterSeconds = Math.ceil(
        (new Date(state.lockedUntil).getTime() - now.getTime()) / 1000,
      );
      throw new ForbiddenException({
        code: ERR_APPROVAL_CODE_LOCKED,
        message: `Too many incorrect codes. Try again in ${retryAfterSeconds}s.`,
        details: { hardLocked: false, retryAfterSeconds },
      });
    }
  }

  /**
   * Records one failure on its OWN committed transaction (see the file header)
   * and returns the resulting state, so the caller can tell the user what
   * happened and notify on a hard lock (Q9).
   *
   * The window is measured from `window_started_at`, not from the last failure:
   * a per-attempt rolling window would let a patient attacker guess at one
   * attempt every 15 minutes forever and never accumulate a count.
   */
  async recordFailure(
    userId: UUID,
    now = new Date(),
  ): Promise<LockoutState & { justHardLocked: boolean }> {
    return withSystemContext(this.pool, { role: SYSTEM_CENTRAL_ROLE }, (client) =>
      this.recordFailureOn(client, userId, now),
    );
  }

  /**
   * The failure logic against a caller-supplied client. Exposed so a consumer
   * that already holds a COMMITTED system transaction can fold its own
   * bookkeeping into the same one — `ApprovalCodeService` uses it to bump the
   * code's `attempt_count` and the caller's lock counter together, on one
   * connection, rather than opening two and risking a half-recorded attempt.
   *
   * Do not pass a request-scoped `dbClient` here: it will be rolled back with
   * the failing request, which is the whole defect this design avoids.
   */
  async recordFailureOn(
    client: PoolClient,
    userId: UUID,
    now = new Date(),
  ): Promise<LockoutState & { justHardLocked: boolean }> {
    const existing = await this.findRow(client, userId);

    const windowExpired =
      !existing || now.getTime() - existing.window_started_at.getTime() > LOCKOUT_WINDOW_MS;
    const failedCount = windowExpired ? 1 : existing.failed_count + 1;
    const windowStartedAt = windowExpired ? now : existing.window_started_at;

    const hardLocked = failedCount >= LOCKOUT_MAX_ATTEMPTS;
    const backoffMs = BACKOFF_BY_FAILURE_COUNT[failedCount];
    const lockedUntil = !hardLocked && backoffMs ? new Date(now.getTime() + backoffMs) : null;

    const res = await client.query<LockoutRow>(
      `INSERT INTO auth_lockouts
         (user_id, failed_count, window_started_at, last_failed_at, locked_until,
          hard_locked, hard_locked_at, cleared_by_user_id, cleared_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, NULL)
       ON CONFLICT (user_id) DO UPDATE SET
         failed_count = EXCLUDED.failed_count,
         window_started_at = EXCLUDED.window_started_at,
         last_failed_at = EXCLUDED.last_failed_at,
         locked_until = EXCLUDED.locked_until,
         hard_locked = EXCLUDED.hard_locked,
         hard_locked_at = EXCLUDED.hard_locked_at,
         cleared_by_user_id = NULL,
         cleared_at = NULL
       RETURNING *`,
      [userId, failedCount, windowStartedAt, now, lockedUntil, hardLocked, hardLocked ? now : null],
    );

    const state = mapRow(res.rows[0]!);
    const justHardLocked = hardLocked && !(existing?.hard_locked ?? false);
    if (justHardLocked) {
      this.logger.warn(
        `Caller ${userId} hard-locked after ${failedCount} incorrect approval codes within ${Math.round(
          LOCKOUT_WINDOW_MS / 60_000,
        )} minutes`,
      );
    }
    return { ...state, justHardLocked };
  }

  /**
   * Clears the counter after a legitimate success, on the CALLER's transaction
   * (see the file header for why this one is different). Deletes rather than
   * zeroes: a row here means "this account has recent failures", and a zeroed
   * leftover would make any future "who is struggling?" read lie.
   *
   * A hard-locked row is left alone — reaching a success while hard-locked
   * should be impossible (`assertMayAttempt` runs first), and if it ever
   * happens, silently un-locking would hide the bug.
   */
  async recordSuccess(client: PoolClient, userId: UUID): Promise<void> {
    await client.query(`DELETE FROM auth_lockouts WHERE user_id = $1 AND hard_locked = FALSE`, [
      userId,
    ]);
  }

  /**
   * Q6 — the escalation path. `clearedBy` must STRICTLY outrank the locked
   * user; equal rank is refused, which is the difference between "my supervisor
   * unlocked me" and "my colleague unlocked me".
   *
   * The locked user's role is read here rather than accepted as a parameter,
   * because a caller-supplied role would make the rank check trivially
   * bypassable by the very person it constrains. The write runs under a system
   * context because `auth_lockouts`' RLS is central-or-self, and a supervisor
   * clearing a kasir is neither.
   */
  async clear(
    targetUserId: UUID,
    clearedBy: { userId: UUID; roleKey: RoleKey },
  ): Promise<LockoutState | null> {
    return withSystemContext(this.pool, { role: SYSTEM_CENTRAL_ROLE }, async (client) => {
      const target = await client.query<{ role_key: string }>(
        `SELECT r.key AS role_key FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`,
        [targetUserId],
      );
      const targetRole = target.rows[0]?.role_key as RoleKey | undefined;
      if (!targetRole) {
        throw new NotFoundException({ code: ERR_NOT_FOUND, message: 'User not found' });
      }

      const clearerRank = ROLE_RANK[clearedBy.roleKey] ?? 0;
      const targetRank = ROLE_RANK[targetRole] ?? 0;
      if (clearerRank <= targetRank) {
        throw new ForbiddenException({
          code: ERR_FORBIDDEN,
          message:
            'Only someone of higher authority than the locked user may unlock them. Escalate to a manager.',
        });
      }

      const res = await client.query<LockoutRow>(
        `UPDATE auth_lockouts
            SET failed_count = 0,
                locked_until = NULL,
                hard_locked = FALSE,
                hard_locked_at = NULL,
                window_started_at = NOW(),
                cleared_by_user_id = $2,
                cleared_at = NOW()
          WHERE user_id = $1
          RETURNING *`,
        [targetUserId, clearedBy.userId],
      );
      this.logger.log(`Lockout cleared for ${targetUserId} by ${clearedBy.userId}`);
      return res.rows[0] ? mapRow(res.rows[0]) : null;
    });
  }

  async find(client: PoolClient, userId: UUID): Promise<LockoutState | null> {
    const row = await this.findRow(client, userId);
    return row ? mapRow(row) : null;
  }

  private async findRow(client: PoolClient, userId: UUID): Promise<LockoutRow | null> {
    const res = await client.query<LockoutRow>(`SELECT * FROM auth_lockouts WHERE user_id = $1`, [
      userId,
    ]);
    return res.rows[0] ?? null;
  }
}
