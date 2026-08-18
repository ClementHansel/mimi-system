/**
 * RBAC + audit wiring test for D-23's `PUT /api/settings/approval-modes/:documentType`
 * (CONTRACTS.md §4.20-style convention; §3-equivalent: this key has no CONTRACTS.md
 * row yet — see `packages/shared/src/rbac.ts`'s own D-23 comment for the same
 * documented drift `rbac.ts`'s header already flags for the 131-vs-137 count).
 *
 * Two things a service-level test (`settings.service.integration.spec.ts`)
 * can't catch, mirroring `modules/inventory/inventory.rbac.spec.ts`'s pattern:
 *
 *  1. The route carries EXACTLY `settings.approval_mode.manage` — a ticket
 *     requirement ("Owner-only to change; the permission key should reflect
 *     that") is a real, shippable bug if the decorator drifts from the key
 *     the RBAC matrix actually locks to Owner-only.
 *  2. The REAL `PermissionsGuard` + REAL (unmocked) `can()`/`RBAC_MATRIX`,
 *     driven by the REAL reflected metadata off `SettingsController`'s own
 *     methods, denies every one of the 8 non-Owner roles and allows Owner —
 *     nothing here is mocked.
 *  3. `@Audited()` metadata is present with the right `entityType`/`action` —
 *     "a mode change is itself auditable" (ticket requirement 4) proven at
 *     the wiring layer; `AuditInterceptor`'s own mechanics are covered by
 *     `kernel/audit`'s own integration suite, not re-tested here.
 */
import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RBAC_MATRIX, RoleKey, type PermissionKey } from '@mimi/shared';

import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { REQUIRE_PERMISSION_KEY } from '../../common/decorators/require-permission.decorator';
import { AUDITED_KEY, type AuditedOptions } from '../../common/decorators/audited.decorator';
import { SettingsController } from './settings.controller';

const guard = new PermissionsGuard(new Reflector());

type AnyHandler = (...args: any[]) => unknown; // eslint-disable-line @typescript-eslint/no-explicit-any

function contextFor(handler: AnyHandler, roleKey: RoleKey): ExecutionContext {
  const request = { user: { sub: 'test-user', roleKey } };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
      getNext: () => ({}),
    }),
    getHandler: () => handler,
    getClass: () => SettingsController,
  } as unknown as ExecutionContext;
}

function requiredKeysOf(handler: AnyHandler): PermissionKey[] | undefined {
  return Reflect.getMetadata(REQUIRE_PERMISSION_KEY, handler) as PermissionKey[] | undefined;
}

function auditedOptionsOf(handler: AnyHandler): AuditedOptions | undefined {
  return Reflect.getMetadata(AUDITED_KEY, handler) as AuditedOptions | undefined;
}

function methodsOf(ctrl: typeof SettingsController): Record<string, AnyHandler> {
  return ctrl.prototype as unknown as Record<string, AnyHandler>;
}

const ALL_ROLES = Object.values(RoleKey);
const PERMISSION_KEY: PermissionKey = 'settings.approval_mode.manage';

describe('M20 settings controller — D-23 approval-mode wiring', () => {
  it("putApprovalMode carries exactly @RequirePermission('settings.approval_mode.manage')", () => {
    const handler = methodsOf(SettingsController).putApprovalMode!;
    expect(requiredKeysOf(handler)).toEqual([PERMISSION_KEY]);
  });

  it("listApprovalModes carries the shared read permission ('settings.read'), not the Owner-only manage key", () => {
    const handler = methodsOf(SettingsController).listApprovalModes!;
    expect(requiredKeysOf(handler)).toEqual(['settings.read']);
  });

  it('putApprovalMode is @Audited() with the D-23 entity type + action', () => {
    const handler = methodsOf(SettingsController).putApprovalMode!;
    expect(auditedOptionsOf(handler)).toEqual({
      entityType: 'approval_mode',
      action: 'settings.approval_mode.manage',
    });
  });

  it("'settings.approval_mode.manage' is Owner-only in the real RBAC matrix (packages/shared/src/rbac.ts)", () => {
    expect(RBAC_MATRIX[PERMISSION_KEY][RoleKey.OWNER]).toBe(true);
    for (const role of ALL_ROLES) {
      if (role === RoleKey.OWNER) continue;
      expect(RBAC_MATRIX[PERMISSION_KEY][role]).toBe(false);
    }
  });

  describe('putApprovalMode — every one of the 9 roles, against the REAL guard', () => {
    const handler = methodsOf(SettingsController).putApprovalMode!;

    it.each(ALL_ROLES)('role %s matches the Owner-only matrix exactly', (roleKey) => {
      const expectedAllowed = RBAC_MATRIX[PERMISSION_KEY][roleKey];
      const ctx = contextFor(handler, roleKey);

      if (expectedAllowed) {
        expect(guard.canActivate(ctx)).toBe(true);
      } else {
        try {
          guard.canActivate(ctx);
          throw new Error('unreachable — canActivate should have thrown above');
        } catch (err) {
          const response = (err as { getResponse?: () => { code?: string } }).getResponse?.();
          expect(response?.code).toBe('ERR_FORBIDDEN');
        }
      }
    });
  });
});
