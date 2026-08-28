/**
 * RBAC wiring for `VoucherController` — the same shape
 * `modules/inventory/inventory.rbac.spec.ts` uses, and for the same two
 * reasons a service-level test cannot cover:
 *
 *  1. Each route carries the EXACT permission key intended. A typo'd or
 *     missing `@RequirePermission()` is a real, shippable bug, and on THIS
 *     controller it is a shippable bug that mints money: `issue` accidentally
 *     annotated `voucher.manage` would still work, still pass every service
 *     test, and quietly hand coupon minting to whoever holds `manage`.
 *  2. The REAL `PermissionsGuard` + the REAL `RBAC_MATRIX` + this
 *     controller's REAL reflected metadata, exercised together exactly as a
 *     request would hit them, for every role in both directions. Nothing is
 *     mocked.
 *
 * The headline assertions the brief asks for — a kasir refused
 * `voucher.issue`, an owner allowed — fall out of the exhaustive sweep, but
 * they are also asserted by name at the bottom so a regression names itself
 * instead of appearing as one row of a parameterised failure.
 */
import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RBAC_MATRIX, RoleKey, type PermissionKey } from '@mimi/shared';

import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { REQUIRE_PERMISSION_KEY } from '../../common/decorators/require-permission.decorator';
import { VoucherController } from './voucher.controller';

const guard = new PermissionsGuard(new Reflector());

// `any` args deliberately: these handlers are never CALLED here (only
// reflected on via `getHandler()`), and the controller's concrete method
// signatures are incompatible with any single function type purely because of
// parameter contravariance — not a real type-safety concern for a value only
// passed to `Reflect.getMetadata`.
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
    getClass: () => VoucherController,
  } as unknown as ExecutionContext;
}

function requiredKeysOf(handler: AnyHandler): PermissionKey[] | undefined {
  return Reflect.getMetadata(REQUIRE_PERMISSION_KEY, handler) as PermissionKey[] | undefined;
}

function methodsOf(): Record<string, AnyHandler> {
  return VoucherController.prototype as unknown as Record<string, AnyHandler>;
}

const ALL_ROLES = Object.values(RoleKey);

/** Every route on this controller and the key it must carry. */
const ROUTES = [
  ['listBatches', 'voucher.read'],
  ['createBatch', 'voucher.manage'],
  ['getBatch', 'voucher.read'],
  ['updateBatch', 'voucher.manage'],
  ['issue', 'voucher.issue'],
  ['closeBatch', 'voucher.manage'],
  ['listBatchVouchers', 'voucher.read'],
  ['check', 'voucher.redeem'],
  ['voidVoucher', 'voucher.manage'],
] as const;

describe('VoucherController — RBAC wiring against the real matrix', () => {
  it.each(ROUTES)('%s carries exactly @RequirePermission(%s)', (methodName, expectedKey) => {
    const handler = methodsOf()[methodName]!;
    expect(requiredKeysOf(handler)).toEqual([expectedKey]);
  });

  it('covers every route the controller declares — no route added without a key', () => {
    // Guards against the failure this whole file exists for: a NEW endpoint
    // shipped with no `@RequirePermission()` at all would pass every
    // assertion above (they only check the routes they name) while being
    // reachable by anyone with a session.
    const declared = Object.getOwnPropertyNames(VoucherController.prototype).filter(
      (name) => name !== 'constructor',
    );
    expect(new Set(declared)).toEqual(new Set(ROUTES.map(([name]) => name)));
    for (const name of declared) {
      expect(requiredKeysOf(methodsOf()[name]!)).toBeDefined();
    }
  });

  describe.each(ROUTES)(
    '%s (@RequirePermission(%s)) — all roles, both directions',
    (methodName, permissionKey) => {
      const handler = methodsOf()[methodName]!;

      it.each(ALL_ROLES)('role %s matches the matrix exactly', (roleKey) => {
        const expectedAllowed = RBAC_MATRIX[permissionKey][roleKey];
        const ctx = contextFor(handler, roleKey);
        if (expectedAllowed) {
          expect(guard.canActivate(ctx)).toBe(true);
        } else {
          expect(() => guard.canActivate(ctx)).toThrow();
        }
      });
    },
  );
});

describe('the two boundaries that cost money if they move', () => {
  it('a KASIR cannot mint vouchers', () => {
    // `voucher.issue` creates bearer instruments. A cashier taking a coupon is
    // the job; a cashier printing one is not.
    const ctx = contextFor(methodsOf().issue!, RoleKey.KASIR);
    expect(() => guard.canActivate(ctx)).toThrow();
  });

  it('an OWNER can mint vouchers', () => {
    expect(guard.canActivate(contextFor(methodsOf().issue!, RoleKey.OWNER))).toBe(true);
  });

  it('a KASIR CAN check a code at the till', () => {
    // The one voucher key that has to reach the outlet floor — refusing it
    // would mean a cashier who cannot answer "is this coupon good?" with a
    // customer standing there.
    expect(guard.canActivate(contextFor(methodsOf().check!, RoleKey.KASIR))).toBe(true);
  });

  it('a KASIR cannot void a voucher or edit a batch', () => {
    expect(() => guard.canActivate(contextFor(methodsOf().voidVoucher!, RoleKey.KASIR))).toThrow();
    expect(() => guard.canActivate(contextFor(methodsOf().createBatch!, RoleKey.KASIR))).toThrow();
  });

  it('a DRIVER, KOKI and HR_ADMIN cannot even list batches', () => {
    // `voucher.read` lists a batch's unspent CODES — that is a list of live
    // coupon numbers, and none of these three roles ever handles one.
    for (const role of [RoleKey.DRIVER, RoleKey.KOKI, RoleKey.HR_ADMIN]) {
      expect(() => guard.canActivate(contextFor(methodsOf().listBatches!, role))).toThrow();
    }
  });
});
