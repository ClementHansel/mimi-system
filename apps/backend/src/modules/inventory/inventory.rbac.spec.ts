/**
 * RBAC wiring test for M07's controller (CONTRACTS.md §4.7's permission
 * column + §3's matrix) — two things a service-level test can't catch:
 *
 *  1. Each route carries the EXACT permission key CONTRACTS §4.7 names (a
 *     typo'd or missing `@RequirePermission()` is a real, shippable bug —
 *     this is the wiring, not the matrix data).
 *  2. The REAL `PermissionsGuard` + REAL (unmocked) `can()`/`RBAC_MATRIX`,
 *     driven by the REAL reflected metadata off `InventoryController`'s
 *     actual methods, denies every role CONTRACTS §3 marks `·` and allows
 *     every role it marks `✓` — for EVERY one of the 9 roles, both
 *     directions, on every one of this module's 5 permission keys. Nothing
 *     here is mocked: this is the guard class + the matrix data + this
 *     controller's own decorators, exercised together exactly as a real
 *     request would hit them.
 */
import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RBAC_MATRIX, RoleKey, type PermissionKey } from '@mimi/shared';

import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { REQUIRE_PERMISSION_KEY } from '../../common/decorators/require-permission.decorator';
import { InventoryController } from './inventory.controller';

const guard = new PermissionsGuard(new Reflector());

// `any` args deliberately: these handlers are never CALLED here (only
// reflected on via `getHandler()`), and the controller's own concrete method
// signatures are otherwise incompatible with any single function-type shape
// (each takes different params) purely because of parameter contravariance —
// not a real type-safety concern for a value that's only ever passed to
// `Reflect.getMetadata`.
type AnyHandler = (...args: any[]) => unknown; // eslint-disable-line @typescript-eslint/no-explicit-any

function contextFor(handler: AnyHandler, roleKey: RoleKey): ExecutionContext {
  const request = { user: { sub: 'test-user', roleKey } };
  return {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}), getNext: () => ({}) }),
    getHandler: () => handler,
    getClass: () => InventoryController,
  } as unknown as ExecutionContext;
}

function requiredKeysOf(handler: AnyHandler): PermissionKey[] | undefined {
  return Reflect.getMetadata(REQUIRE_PERMISSION_KEY, handler) as PermissionKey[] | undefined;
}

function methodsOf(ctrl: typeof InventoryController): Record<string, AnyHandler> {
  return ctrl.prototype as unknown as Record<string, AnyHandler>;
}

const ALL_ROLES = Object.values(RoleKey);

describe('M07 inventory controller — RBAC wiring against the real matrix (CONTRACTS.md §4.7/§3)', () => {
  it.each([
    ['balances', 'inventory.balance.read'],
    ['summary', 'inventory.balance.read'],
    ['movements', 'inventory.movement.read'],
    ['lowStock', 'inventory.balance.read'],
    ['minStock', 'inventory.balance.read'],
    ['upsertMinStock', 'inventory.minstock.manage'],
    ['suggestions', 'inventory.suggestion.read'],
    ['areaTransfer', 'inventory.area_transfer.create'],
    ['history', 'inventory.movement.read'],
  ] as const)('%s carries exactly @RequirePermission(%s)', (methodName, expectedKey) => {
    const handler = methodsOf(InventoryController)[methodName]!;
    expect(requiredKeysOf(handler)).toEqual([expectedKey]);
  });

  describe.each([
    ['balances', 'inventory.balance.read'],
    ['movements', 'inventory.movement.read'],
    ['upsertMinStock', 'inventory.minstock.manage'],
    ['areaTransfer', 'inventory.area_transfer.create'],
    ['suggestions', 'inventory.suggestion.read'],
  ] as const)('%s (@RequirePermission(%s)) — every one of the 9 roles, both directions', (methodName, permissionKey) => {
    const handler = methodsOf(InventoryController)[methodName]!;

    it.each(ALL_ROLES)('role %s matches CONTRACTS §3 exactly', (roleKey) => {
      const expectedAllowed = RBAC_MATRIX[permissionKey][roleKey];
      const ctx = contextFor(handler, roleKey);

      if (expectedAllowed) {
        expect(guard.canActivate(ctx)).toBe(true);
      } else {
        expect(() => guard.canActivate(ctx)).toThrow();
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

  it('sanity: inventory.area_transfer.create is denied for Owner/Manager/Kasir but allowed for Kepala Gudang/Supervisor/Leader Outlet (CONTRACTS §3 exact row)', () => {
    const handler = methodsOf(InventoryController).areaTransfer!;
    expect(guard.canActivate(contextFor(handler, RoleKey.KEPALA_GUDANG))).toBe(true);
    expect(guard.canActivate(contextFor(handler, RoleKey.SUPERVISOR))).toBe(true);
    expect(guard.canActivate(contextFor(handler, RoleKey.LEADER_OUTLET))).toBe(true);
    expect(() => guard.canActivate(contextFor(handler, RoleKey.OWNER))).toThrow();
    expect(() => guard.canActivate(contextFor(handler, RoleKey.MANAGER))).toThrow();
    expect(() => guard.canActivate(contextFor(handler, RoleKey.KASIR))).toThrow();
  });

  it('sanity: inventory.minstock.manage is denied for Kasir/Supervisor/Leader Outlet but allowed for Owner/Manager/Kepala Gudang (CONTRACTS §3 exact row)', () => {
    const handler = methodsOf(InventoryController).upsertMinStock!;
    expect(guard.canActivate(contextFor(handler, RoleKey.OWNER))).toBe(true);
    expect(guard.canActivate(contextFor(handler, RoleKey.MANAGER))).toBe(true);
    expect(guard.canActivate(contextFor(handler, RoleKey.KEPALA_GUDANG))).toBe(true);
    expect(() => guard.canActivate(contextFor(handler, RoleKey.KASIR))).toThrow();
    expect(() => guard.canActivate(contextFor(handler, RoleKey.SUPERVISOR))).toThrow();
    expect(() => guard.canActivate(contextFor(handler, RoleKey.LEADER_OUTLET))).toThrow();
  });
});
