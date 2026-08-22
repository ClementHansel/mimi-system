import { Module } from '@nestjs/common';
import { AuthLockoutService } from './auth-lockout.service';

/**
 * kernel/auth-lockout — B-15.
 *
 * Its own module rather than a helper inside `kernel/approvals` or
 * `modules/auth`, because it has two unrelated consumers pulling in opposite
 * directions: the approval-code redeem path (which RECORDS failures) and the
 * auth module's unlock endpoint (which CLEARS them). Living in either one
 * would have made the other import a sibling's internals.
 *
 * Every method takes the caller's `PoolClient`, per the house convention —
 * a lockout write belongs in the SAME transaction as the failed attempt that
 * caused it, or a rollback elsewhere in the request would quietly hand back
 * a free guess.
 */
@Module({
  providers: [AuthLockoutService],
  exports: [AuthLockoutService],
})
export class AuthLockoutModule {}
