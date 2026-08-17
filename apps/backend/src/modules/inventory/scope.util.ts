import { ForbiddenException } from '@nestjs/common';
import { ERR_LOCATION_OUT_OF_SCOPE } from '@mimi/shared';

/**
 * `RlsContextGuard`'s `locationScope` (`null` = central role, sees every
 * location; `string[]` = exactly these) is the enforcement authority — RLS
 * itself would silently return zero rows for an out-of-scope `locationId`
 * rather than error. That is correct for security but a bad caller
 * experience: a Kasir who fat-fingers `?locationId=<some-other-outlet>` gets
 * an empty page instead of a message telling them why. This is the "clearer
 * 403 instead of a confusing empty result" nicety `ERR_LOCATION_OUT_OF_SCOPE`
 * exists for (`packages/shared/src/error-codes.ts`) — belt-and-braces on top
 * of RLS, never a substitute for it.
 */
export function assertLocationInScope(locationScope: readonly string[] | null, locationId: string | undefined): void {
  if (!locationId) return;
  if (locationScope === null) return; // central role — unrestricted
  if (!locationScope.includes(locationId)) {
    throw new ForbiddenException({
      code: ERR_LOCATION_OUT_OF_SCOPE,
      message: `Location ${locationId} is outside your assigned scope`,
    });
  }
}
