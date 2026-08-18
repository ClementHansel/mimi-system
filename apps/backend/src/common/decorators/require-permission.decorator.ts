import { SetMetadata } from '@nestjs/common';
import type { PermissionKey } from '@mimi/shared';

export const REQUIRE_PERMISSION_KEY = 'require_permission';

/**
 * Restricts an endpoint to callers whose role holds at least one of the
 * given permission keys (CONTRACTS.md §3 — the 137-key RBAC matrix).
 * Enforced by `PermissionsGuard` against `can(roleKey, key)` from
 * `@mimi/shared`. `PermissionKey` (like `ErrorCode`) is a closed union
 * derived from the matrix itself — a typo'd key is a compile error here,
 * at the call site, rather than a silent no-match inside the guard. RLS
 * (§1.14) additionally scopes rows by location — a granted permission
 * never widens a scoped role's `location_ids`.
 *
 * CONTRACTS §0: "Every mutating endpoint: @RequirePermission(<key>) +
 * @Audited() + emits a sync event."
 *
 * @example
 *   @RequirePermission('inventory.minstock.manage')
 *   @Patch(':id')
 *   update(...) { ... }
 */
export const RequirePermission = (...keys: PermissionKey[]) =>
  SetMetadata(REQUIRE_PERMISSION_KEY, keys);
