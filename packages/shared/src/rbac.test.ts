import { describe, it, expect } from 'vitest';
import { RoleKey } from './enums';
import {
  PERMISSION_KEY_COUNT,
  PERMISSION_KEYS,
  RBAC_ROLE_ORDER,
  can,
  permissionsForRole,
  rolesWithPermission,
  type PermissionKey,
} from './rbac';

describe('RBAC matrix shape', () => {
  it('has exactly 138 permission keys (CONTRACTS.md §3 as amended by D-18/D-19/D-20, + D-23 settings.approval_mode.manage)', () => {
    // 137 at CONTRACTS.md's own last count (already stale relative to its table — see rbac.ts's
    // header) + 1: `settings.approval_mode.manage` (D-23, owner-decided, not yet folded into
    // CONTRACTS.md §3 — same documented-drift situation, flagged for the architect to reconcile).
    expect(PERMISSION_KEY_COUNT).toBe(138);
    expect(new Set(PERMISSION_KEYS).size).toBe(138); // no duplicate keys
  });

  it('has exactly 9 roles, in contract column order', () => {
    expect(RBAC_ROLE_ORDER).toEqual([
      RoleKey.OWNER,
      RoleKey.MANAGER,
      RoleKey.FINANCE,
      RoleKey.KEPALA_GUDANG,
      RoleKey.SUPERVISOR,
      RoleKey.LEADER_OUTLET,
      RoleKey.KASIR,
      RoleKey.HR_ADMIN,
      RoleKey.DRIVER,
    ]);
  });

  it('every key is defined for every role (no accidental holes)', () => {
    for (const key of PERMISSION_KEYS) {
      for (const role of RBAC_ROLE_ORDER) {
        expect(typeof can(role, key)).toBe('boolean');
      }
    }
  });
});

describe('can() spot checks against CONTRACTS.md §3', () => {
  it('owner and manager can do almost everything admin-side', () => {
    expect(can(RoleKey.OWNER, 'user.create')).toBe(true);
    expect(can(RoleKey.MANAGER, 'user.create')).toBe(true);
    expect(can(RoleKey.FINANCE, 'user.create')).toBe(false);
  });

  it('only owner holds settings.approval_chain.manage', () => {
    for (const role of RBAC_ROLE_ORDER) {
      expect(can(role, 'settings.approval_chain.manage')).toBe(role === RoleKey.OWNER);
    }
  });

  it('a kasir may create a sale but not approve a void', () => {
    expect(can(RoleKey.KASIR, 'pos.sale.create')).toBe(true);
    expect(can(RoleKey.KASIR, 'pos.void.approve')).toBe(false);
  });

  it('supervisor (outlet) approves cash variance; kepala gudang does not (D-19)', () => {
    expect(can(RoleKey.SUPERVISOR, 'pos.cash_variance.approve')).toBe(true);
    expect(can(RoleKey.KEPALA_GUDANG, 'pos.cash_variance.approve')).toBe(false);
  });

  it('D-20: supplier.directory.read reaches outlet roles; supplier.read (full, incl. price/termin) does not', () => {
    expect(can(RoleKey.SUPERVISOR, 'supplier.directory.read')).toBe(true);
    expect(can(RoleKey.LEADER_OUTLET, 'supplier.directory.read')).toBe(true);
    expect(can(RoleKey.SUPERVISOR, 'supplier.read')).toBe(false);
    expect(can(RoleKey.LEADER_OUTLET, 'supplier.read')).toBe(false);
  });

  it('D-18: payroll.statutory.enable is Owner/Manager only; .config is Finance/HR Admin', () => {
    expect(can(RoleKey.OWNER, 'payroll.statutory.enable')).toBe(true);
    expect(can(RoleKey.MANAGER, 'payroll.statutory.enable')).toBe(true);
    expect(can(RoleKey.HR_ADMIN, 'payroll.statutory.enable')).toBe(false);
    expect(can(RoleKey.FINANCE, 'payroll.statutory.config')).toBe(true);
    expect(can(RoleKey.HR_ADMIN, 'payroll.statutory.config')).toBe(true);
  });

  it('finance never touches offline-eligible approval keys (void/replenishment/waste)', () => {
    expect(can(RoleKey.FINANCE, 'pos.void.approve')).toBe(false);
    expect(can(RoleKey.FINANCE, 'replenishment.approve.supervisor')).toBe(false);
    expect(can(RoleKey.FINANCE, 'waste.approve')).toBe(false);
  });

  it('fails closed at runtime on a key outside the union (defense-in-depth for values arriving through an untyped boundary, e.g. reflected decorator metadata)', () => {
    // A literal typo here is now a compile error (that's the whole point of the
    // literal union) — the cast simulates a value that reached `can()` via a
    // runtime path TypeScript can't see through, not a hand-typed call site.
    expect(can(RoleKey.OWNER, 'this.key.does.not.exist' as PermissionKey)).toBe(false);
  });

  it('rejects a typo\'d key at COMPILE time, not just at runtime', () => {
    // @ts-expect-error - 'suplier.directory.read' is not a member of PermissionKey; this line
    // must fail to compile. If it ever compiles cleanly, PermissionKey has been re-widened.
    const typo: PermissionKey = 'suplier.directory.read';
    expect(typo).toBeDefined(); // keeps the variable "used" for lint; the real assertion is the ts-expect-error above
  });

  it('every role passes hr.attendance.check, notification.read.own, attachment.upload (all-✓ rows)', () => {
    for (const role of RBAC_ROLE_ORDER) {
      expect(can(role, 'hr.attendance.check')).toBe(true);
      expect(can(role, 'notification.read.own')).toBe(true);
      expect(can(role, 'attachment.upload')).toBe(true);
    }
  });
});

describe('permissionsForRole / rolesWithPermission', () => {
  it('driver holds a minimal key set (A-2)', () => {
    const driverKeys = permissionsForRole(RoleKey.DRIVER);
    expect(driverKeys).toContain('delivery.read');
    expect(driverKeys).toContain('delivery.drop.execute');
    expect(driverKeys).toContain('hr.attendance.check');
    expect(driverKeys).toContain('payroll.slip.read.own');
    expect(driverKeys).not.toContain('pos.sale.create');
    expect(driverKeys).not.toContain('accounting.journal.post');
  });

  it('rolesWithPermission is the inverse of can()', () => {
    for (const key of PERMISSION_KEYS) {
      const roles = rolesWithPermission(key);
      for (const role of RBAC_ROLE_ORDER) {
        expect(roles.includes(role)).toBe(can(role, key));
      }
    }
  });

  it('only finance and owner can pay a verified payment', () => {
    expect(rolesWithPermission('payment.pay').sort()).toEqual([RoleKey.OWNER, RoleKey.FINANCE].sort());
  });
});
