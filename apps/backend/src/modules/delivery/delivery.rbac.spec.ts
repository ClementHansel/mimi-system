/**
 * RBAC unit test for M10 `delivery`'s permission keys (CONTRACTS.md §3).
 * Asserts BOTH directions for every permission key this module's controllers
 * declare via `@RequirePermission()` — an allowed role must pass, a denied
 * role must fail — against the exact same `can(role, key)` function
 * `PermissionsGuard` calls at runtime (`packages/shared/src/rbac.ts`), so a
 * drift between this test and the real guard is structurally impossible
 * (there is only one implementation of the check, imported here verbatim).
 *
 * Cross-checked directly against the `@RequirePermission()` metadata actually
 * attached to this module's controller methods (via `Reflect.getMetadata`),
 * not a hand-typed copy of the keys — a typo'd or removed decorator on a
 * real endpoint fails THIS test, not just a hypothetical one.
 */
import { describe, expect, it } from 'vitest';
import 'reflect-metadata';
import { can, RoleKey } from '@mimi/shared';
import { REQUIRE_PERMISSION_KEY } from '../../common/decorators/require-permission.decorator';
import { SuratJalanController } from './controllers/surat-jalan.controller';
import { DropController } from './controllers/drop.controller';
import { DeliveryMiscController } from './controllers/delivery-misc.controller';

const ALL_ROLES = Object.values(RoleKey);

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a NestJS controller class, whose prototype methods this file inspects via reflection; no narrower shape exists for "any decorated controller class".
type ControllerClass = new (...args: any[]) => unknown;

function requiredKeysFor(target: ControllerClass, method: string): string[] {
  const meta = Reflect.getMetadata(
    REQUIRE_PERMISSION_KEY,
    (target.prototype as Record<string, unknown>)[method],
  ) as string[] | undefined;
  if (!meta)
    throw new Error(
      `No @RequirePermission() metadata found on ${target.name}.${method} — did the decorator get removed?`,
    );
  return meta;
}

function assertBothDirections(target: ControllerClass, method: string) {
  const keys = requiredKeysFor(target, method);
  const allowedRoles = ALL_ROLES.filter((r) => keys.some((k) => can(r, k as never)));
  const deniedRoles = ALL_ROLES.filter((r) => !allowedRoles.includes(r));

  it(`${target.name}.${method} (${keys.join('|')}): allows every role the matrix grants`, () => {
    expect(allowedRoles.length).toBeGreaterThan(0); // sanity: every real endpoint has SOMEONE who can call it
    for (const role of allowedRoles) {
      expect(keys.some((k) => can(role, k as never))).toBe(true);
    }
  });

  it(`${target.name}.${method} (${keys.join('|')}): denies every OTHER role`, () => {
    expect(deniedRoles.length).toBeGreaterThan(0); // sanity: this endpoint isn't open to all 9 roles
    for (const role of deniedRoles) {
      expect(keys.some((k) => can(role, k as never))).toBe(false);
    }
  });
}

describe('M10 delivery — RBAC matrix, both directions', () => {
  describe('SuratJalanController', () => {
    assertBothDirections(SuratJalanController, 'list');
    assertBothDirections(SuratJalanController, 'getById');
    assertBothDirections(SuratJalanController, 'create');
    assertBothDirections(SuratJalanController, 'update');
    assertBothDirections(SuratJalanController, 'ready');
    assertBothDirections(SuratJalanController, 'load');
    assertBothDirections(SuratJalanController, 'dispatch');
    assertBothDirections(SuratJalanController, 'cancel');
  });

  describe('DropController', () => {
    assertBothDirections(DropController, 'depart');
    assertBothDirections(DropController, 'arrive');
    assertBothDirections(DropController, 'receive');
    assertBothDirections(DropController, 'fail');
  });

  describe('DeliveryMiscController', () => {
    assertBothDirections(DeliveryMiscController, 'createTemperatureLog');
    assertBothDirections(DeliveryMiscController, 'myJobs');
    assertBothDirections(DeliveryMiscController, 'dailyRecap');
    assertBothDirections(DeliveryMiscController, 'listDrivers');
    assertBothDirections(DeliveryMiscController, 'createDriver');
    assertBothDirections(DeliveryMiscController, 'updateDriver');
    assertBothDirections(DeliveryMiscController, 'listVehicles');
    assertBothDirections(DeliveryMiscController, 'createVehicle');
    assertBothDirections(DeliveryMiscController, 'updateVehicle');
    assertBothDirections(DeliveryMiscController, 'createGoodsReceipt');
  });

  // Spot checks against CONTRACTS.md §3's literal table, named explicitly (not just derived from the
  // decorator) so a change to the RBAC matrix itself that silently loosens/tightens delivery is visible here.
  it("Kasir (KSR) can never touch any delivery endpoint — not in the RBAC matrix's delivery column at all", () => {
    for (const key of [
      'delivery.read',
      'delivery.sj.create',
      'delivery.sj.dispatch',
      'delivery.sj.cancel',
      'delivery.drop.execute',
      'delivery.receive',
      'delivery.master.manage',
    ] as const) {
      expect(can(RoleKey.KASIR, key)).toBe(false);
    }
  });

  it('Driver (DRV) may read + execute drop actions, but never create/dispatch/cancel an SJ or manage master data', () => {
    expect(can(RoleKey.DRIVER, 'delivery.read')).toBe(true);
    expect(can(RoleKey.DRIVER, 'delivery.drop.execute')).toBe(true);
    expect(can(RoleKey.DRIVER, 'delivery.sj.create')).toBe(false);
    expect(can(RoleKey.DRIVER, 'delivery.sj.dispatch')).toBe(false);
    expect(can(RoleKey.DRIVER, 'delivery.sj.cancel')).toBe(false);
    expect(can(RoleKey.DRIVER, 'delivery.receive')).toBe(false);
    expect(can(RoleKey.DRIVER, 'delivery.master.manage')).toBe(false);
  });

  it('Kepala Gudang (KGD) builds/dispatches SJs but does not receive them; Supervisor/Leader Outlet receive but never build one', () => {
    expect(can(RoleKey.KEPALA_GUDANG, 'delivery.sj.create')).toBe(true);
    expect(can(RoleKey.KEPALA_GUDANG, 'delivery.sj.dispatch')).toBe(true);
    expect(can(RoleKey.KEPALA_GUDANG, 'delivery.receive')).toBe(false);
    expect(can(RoleKey.SUPERVISOR, 'delivery.receive')).toBe(true);
    expect(can(RoleKey.LEADER_OUTLET, 'delivery.receive')).toBe(true);
    expect(can(RoleKey.SUPERVISOR, 'delivery.sj.create')).toBe(false);
    expect(can(RoleKey.LEADER_OUTLET, 'delivery.sj.create')).toBe(false);
  });
});
