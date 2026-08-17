import { ForbiddenException } from '@nestjs/common';
import { ERR_LOCATION_OUT_OF_SCOPE } from '@mimi/shared';
import type { LocationScope } from '../../common/scope/scope.service';

/**
 * Every dashboard query MUST apply this — materialized views (`mv_sales_daily`
 * etc.) are ordinary Postgres objects with NO row security of their own (see
 * this module's ticket header): a `null` `locationScope` means unrestricted
 * (central role), a `string[]` means the caller's own locations ONLY, and
 * every SQL string built here must fold that into an explicit
 * `AND location_id = ANY($n::uuid[])` (or the view's equivalent column) —
 * never rely on RLS to filter a matview read.
 *
 * Appends the next bind parameter (`$<params.length + 1>`) to `params` and
 * returns the SQL fragment to AND onto the query's WHERE clause — `''` when
 * `locationScope` is `null` (central, no filter needed).
 */
export function scopeClause(locationScope: LocationScope, column: string, params: unknown[]): string {
  if (locationScope === null) return '';
  params.push(locationScope);
  return ` AND ${column} = ANY($${params.length}::uuid[])`;
}

/**
 * Belt-and-braces 403 (matches `modules/inventory/scope.util.ts`'s identical
 * pattern, duplicated here rather than imported cross-module per this
 * ticket's "own only modules/dashboard/**" boundary): RLS/`scopeClause` above
 * would silently return zero rows for a `:locationId`/`?locationId=` outside
 * the caller's scope; the outlet drill-down endpoint needs a clear 403
 * instead ("a scoped caller requesting a :locationId outside their scope
 * must 403, not silently return data" — CONTRACTS.md §4.18).
 */
export function assertLocationInScope(locationScope: LocationScope, locationId: string | undefined): void {
  if (!locationId) return;
  if (locationScope === null) return;
  if (!locationScope.includes(locationId)) {
    throw new ForbiddenException({
      code: ERR_LOCATION_OUT_OF_SCOPE,
      message: `Location ${locationId} is outside your assigned scope`,
    });
  }
}
