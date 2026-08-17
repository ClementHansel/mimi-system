import { ForbiddenException } from '@nestjs/common';
import { ERR_LOCATION_OUT_OF_SCOPE } from '@mimi/shared';

/**
 * Own copy of `inventory/scope.util.ts`'s `assertLocationInScope` — this
 * module owns only `modules/report/**`, so it cannot import a sibling
 * module's internal file (that file has no `exports` entry making it part
 * of `InventoryModule`'s public surface, and reaching into another module's
 * unexported internals is exactly the cross-module coupling the ticket's
 * "own ONLY report/**" boundary exists to prevent). The logic is identical
 * on purpose: `request.locationScope` (`null` = central role, unrestricted;
 * `string[]` = exactly these) is the same `RlsContextGuard`/`ScopeService`
 * authority every module checks against, and RLS itself would silently
 * return zero rows for an out-of-scope `locationId` rather than error — this
 * is the "clearer 403 instead of a confusing empty report" belt-and-braces
 * check on top of RLS, never a substitute for it.
 */
export function assertLocationInScope(locationScope: readonly string[] | null | undefined, locationId: string | undefined): void {
  if (!locationId) return;
  if (locationScope === null || locationScope === undefined) return; // central role — unrestricted
  if (!locationScope.includes(locationId)) {
    throw new ForbiddenException({
      code: ERR_LOCATION_OUT_OF_SCOPE,
      message: `Location ${locationId} is outside your assigned scope`,
    });
  }
}
