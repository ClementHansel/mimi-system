import { ForbiddenException } from '@nestjs/common';
import { ERR_LOCATION_OUT_OF_SCOPE } from '@mimi/shared';
import type { JwtAccessPayload } from '../../common/jwt/jwt-payload.interface';

/** CONTRACTS.md §1.14: roles whose scope spans every location. Same set `StorageService` uses. */
export const ASSET_CENTRAL_ROLES = new Set(['owner', 'manager', 'finance', 'hr_admin']);

/**
 * `maintenance_schedules`/`maintenance_jobs`/`service_history` carry NO RLS
 * (migration 074's own comment: "API-gated only") — this is the entire
 * enforcement for those three tables, copied from
 * `StorageService.assertEntityScope`'s exact shape (`kernel/storage/
 * storage.service.ts`). The owning `assets` row itself IS RLS-scoped
 * (`assets_loc`, `FORCE ROW LEVEL SECURITY`), so a plain
 * `SELECT ... FROM assets WHERE id = $1` on the caller's own `req.dbClient`
 * already returns 0 rows for an out-of-scope scoped role before this ever
 * runs — every call site below fetches the asset's `location_id` that way
 * FIRST (so an out-of-scope asset id 404s exactly like a nonexistent one,
 * never leaking existence), then calls this as defense-in-depth at the exact
 * point a schedule/job/history row is read or written, per this ticket's
 * explicit instruction to gate those three tables the same way.
 */
export function assertAssetLocationScope(
  user: JwtAccessPayload,
  locationScope: string[] | null,
  assetLocationId: string,
): void {
  if (ASSET_CENTRAL_ROLES.has(user.roleKey)) return;
  if (locationScope === null) return;
  if (locationScope.includes(assetLocationId)) return;
  throw new ForbiddenException({
    code: ERR_LOCATION_OUT_OF_SCOPE,
    message: 'Asset belongs to a location outside your scope',
  });
}
