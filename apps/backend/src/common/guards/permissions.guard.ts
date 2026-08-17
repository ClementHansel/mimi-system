import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
// `can(role, permission)` is packages/shared's pure RBAC-matrix lookup
// (CONTRACTS.md §3 → `packages/shared/src/rbac.ts`, verbatim, BUILD-PLAN §5
// W1-B). `RoleKey`/`PermissionKey` are the same package's closed-union
// types (`enums.ts`/`rbac.ts`) — `can`'s second parameter is `PermissionKey`,
// not `string`, so `REQUIRE_PERMISSION_KEY` metadata must be read back out
// as `PermissionKey[]` below, matching what `@RequirePermission()` now
// requires at its own call sites.
import { can, RoleKey, PermissionKey, ERR_FORBIDDEN } from '@mimi/shared';
import { REQUIRE_PERMISSION_KEY } from '../decorators/require-permission.decorator';
import { JwtAccessPayload } from '../jwt/jwt-payload.interface';

/**
 * Enforces `@RequirePermission()` (CONTRACTS.md §3 — the 137-key RBAC
 * matrix). Unlike a DB-backed permission resolver, this is a pure,
 * zero-I/O check: Mimi has 9 FIXED roles with no per-tenant custom roles
 * (single-tenant, D-05), so "does this role hold this permission" is a pure
 * function of `roleKey` — no query needed, no cache needed.
 *
 * Registered globally via `APP_GUARD`, after `JwtAuthGuard` and
 * `RlsContextGuard` in the guard chain (both populate/need `request.user`
 * first). Routes without `@RequirePermission()` are unaffected (open to any
 * authenticated — or `@Public()` — caller).
 *
 * RLS (§1.14) is layered on top of this, not a substitute for it: holding a
 * permission key never widens a scoped role's visible `location_id`s.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<PermissionKey[]>(REQUIRE_PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest();
    const user = request.user as JwtAccessPayload | undefined;
    if (!user) {
      throw new ForbiddenException({ code: ERR_FORBIDDEN, message: 'Not authenticated' });
    }

    const allowed = required.some((key) => can(user.roleKey as RoleKey, key));
    if (!allowed) {
      throw new ForbiddenException({
        code: ERR_FORBIDDEN,
        message: `Role '${user.roleKey}' lacks permission: ${required.join(' or ')}`,
        details: { required, roleKey: user.roleKey },
      });
    }
    return true;
  }
}
