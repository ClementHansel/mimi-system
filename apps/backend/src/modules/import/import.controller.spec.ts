/**
 * The bulk importer's per-entity permission gate.
 *
 * WHY THIS FILE EXISTS: `ImportController` is the only controller in the app
 * that carries no `@RequirePermission`, because the key it needs varies by the
 * `:entity` route param (`item.manage` for items and item categories,
 * `product.manage` for menu products) and that decorator's keys are fixed at
 * declaration time. It checks `can()` in each handler instead, and
 * `test/rbac-endpoint-sweep.spec.ts` allow-lists the three routes on the
 * strength of that.
 *
 * An allowlist entry backed by nothing is a hole with a comment over it. These
 * tests are what make it a real gate: they pin down that a role WITHOUT the
 * entity's permission is refused on every one of the three routes, and — the
 * part that actually matters — that the gate is per ENTITY, so holding
 * `item.manage` does not get you write access to the POS menu.
 */
import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { RoleKey, can } from '@mimi/shared';
import type { JwtAccessPayload } from '../../common/jwt/jwt-payload.interface';
import { ImportController } from './import.controller';
import { ImportService } from './import.service';
import { entityDef } from './import-schema';

function userWithRole(roleKey: RoleKey): JwtAccessPayload {
  return { sub: 'u-1', username: `${roleKey}-1`, roleKey, locationIds: [] };
}

/** Only `permissionFor` is exercised here — the gate resolves its key through it and nothing else. */
function controller(): ImportController {
  const service = {
    permissionFor: (entity: Parameters<typeof entityDef>[0]) => entityDef(entity).permission,
    template: vi.fn(() => 'code,name\n'),
  } as unknown as ImportService;
  return new ImportController(service);
}

const res = () =>
  ({ setHeader: vi.fn(), send: vi.fn() }) as unknown as Parameters<
    ImportController['getTemplate']
  >[0];

describe('ImportController — per-entity permission gate', () => {
  it('the seeded roles behind this gate are the ones the matrix actually grants', () => {
    // Guards the premise of every assertion below: if the RBAC matrix changed
    // so that kasir held `item.manage`, these tests would still pass while
    // testing nothing. Fail loudly here instead.
    expect(can(RoleKey.KEPALA_GUDANG, 'item.manage')).toBe(true);
    expect(can(RoleKey.KEPALA_GUDANG, 'product.manage')).toBe(false);
    expect(can(RoleKey.OWNER, 'product.manage')).toBe(true);
    expect(can(RoleKey.KASIR, 'item.manage')).toBe(false);
    // Same premise-guard for the five 2026-08-27 entities' roles, below.
    expect(can(RoleKey.HR_ADMIN, 'hr.employee.manage')).toBe(true);
    expect(can(RoleKey.HR_ADMIN, 'hr.shift.manage')).toBe(true);
    expect(can(RoleKey.HR_ADMIN, 'payroll.component.manage')).toBe(true);
    expect(can(RoleKey.HR_ADMIN, 'accounting.coa.manage')).toBe(false);
    expect(can(RoleKey.HR_ADMIN, 'asset.manage')).toBe(false);
    expect(can(RoleKey.FINANCE, 'accounting.coa.manage')).toBe(true);
    expect(can(RoleKey.FINANCE, 'payroll.component.manage')).toBe(true);
    expect(can(RoleKey.FINANCE, 'hr.employee.manage')).toBe(false);
    expect(can(RoleKey.FINANCE, 'asset.manage')).toBe(false);
    expect(can(RoleKey.MANAGER, 'asset.manage')).toBe(true);
    expect(can(RoleKey.MANAGER, 'accounting.coa.manage')).toBe(false);
  });

  it('refuses a role holding NEITHER permission on all three routes', () => {
    const c = controller();
    const kasir = userWithRole(RoleKey.KASIR);

    expect(() => c.getTemplate(res(), 'items', kasir)).toThrow(ForbiddenException);
    // preview/commit reject before ever touching the request body or the file.
    expect(c.preview({} as never, 'items', undefined, kasir)).rejects.toThrow(ForbiddenException);
    expect(c.commit({} as never, 'items', undefined, kasir)).rejects.toThrow(ForbiddenException);
  });

  it('refuses a role holding none of the FIVE 2026-08-27 entity permissions, on all five routes', () => {
    const c = controller();
    const kasir = userWithRole(RoleKey.KASIR);

    for (const entity of [
      'chart_of_accounts',
      'employees',
      'work_shifts',
      'assets',
      'salary_components',
    ] as const) {
      expect(() => c.getTemplate(res(), entity, kasir)).toThrow(ForbiddenException);
    }
  });

  it('is gated PER ENTITY across the HR admin — holds employees/shifts/payroll-components, not accounting/assets/items/products', () => {
    const c = controller();
    const hrAdmin = userWithRole(RoleKey.HR_ADMIN);

    expect(() => c.getTemplate(res(), 'employees', hrAdmin)).not.toThrow();
    expect(() => c.getTemplate(res(), 'work_shifts', hrAdmin)).not.toThrow();
    expect(() => c.getTemplate(res(), 'salary_components', hrAdmin)).not.toThrow();
    expect(() => c.getTemplate(res(), 'chart_of_accounts', hrAdmin)).toThrow(ForbiddenException);
    expect(() => c.getTemplate(res(), 'assets', hrAdmin)).toThrow(ForbiddenException);
    expect(() => c.getTemplate(res(), 'items', hrAdmin)).toThrow(ForbiddenException);
    expect(() => c.getTemplate(res(), 'products', hrAdmin)).toThrow(ForbiddenException);
  });

  it('is gated PER ENTITY across Finance — holds chart_of_accounts/payroll-components, not employees/shifts/assets', () => {
    const c = controller();
    const finance = userWithRole(RoleKey.FINANCE);

    expect(() => c.getTemplate(res(), 'chart_of_accounts', finance)).not.toThrow();
    expect(() => c.getTemplate(res(), 'salary_components', finance)).not.toThrow();
    expect(() => c.getTemplate(res(), 'employees', finance)).toThrow(ForbiddenException);
    expect(() => c.getTemplate(res(), 'work_shifts', finance)).toThrow(ForbiddenException);
    expect(() => c.getTemplate(res(), 'assets', finance)).toThrow(ForbiddenException);
  });

  it('is gated PER ENTITY — `item.manage` does not unlock the POS menu', () => {
    const c = controller();
    // Kepala gudang runs the warehouse: it holds `item.manage` and must be able
    // to import items, but menu products and their prices are not its call.
    const gudang = userWithRole(RoleKey.KEPALA_GUDANG);

    expect(() => c.getTemplate(res(), 'items', gudang)).not.toThrow();
    expect(() => c.getTemplate(res(), 'item_categories', gudang)).not.toThrow();
    expect(() => c.getTemplate(res(), 'products', gudang)).toThrow(ForbiddenException);
  });

  it('lets a role holding the entity permission through', () => {
    const c = controller();
    const owner = userWithRole(RoleKey.OWNER);
    expect(() => c.getTemplate(res(), 'products', owner)).not.toThrow();
    expect(() => c.getTemplate(res(), 'items', owner)).not.toThrow();
  });

  it('names the permission it wanted, so a refusal is actionable', () => {
    const c = controller();
    try {
      c.getTemplate(res(), 'products', userWithRole(RoleKey.KASIR));
      throw new Error('expected a ForbiddenException');
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenException);
      const body = (err as ForbiddenException).getResponse() as {
        code: string;
        details: { required: string };
      };
      expect(body.code).toBe('ERR_FORBIDDEN');
      expect(body.details.required).toBe('product.manage');
    }
  });

  it('rejects an unknown :entity before any permission logic runs', () => {
    const c = controller();
    // A bad param must not fall through to a permission lookup that would throw
    // an unrelated error — the caller needs "no such entity", not "forbidden".
    //
    // This used to pass 'suppliers', which became a REAL entity on 2026-08-27
    // and quietly turned the test into a no-op assertion about a valid name.
    // `supplier_prices` is deliberately chosen instead: it is a plausible-
    // sounding entity that must NEVER exist here (prices live in
    // `supplier_items` with append-only history, FR-SUP-04), so if someone
    // ever adds it this test failing is the right alarm.
    expect(() => c.getTemplate(res(), 'supplier_prices', userWithRole(RoleKey.OWNER))).toThrow(
      /supplier_prices/,
    );
  });
});
