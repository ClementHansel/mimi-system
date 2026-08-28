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
  it('has exactly 156 permission keys (CONTRACTS.md §3 as amended by D-18/D-19/D-20, + D-23, + W7 chat/employee-self/contract keys, + the two B-15 keys)', () => {
    // 137 at CONTRACTS.md's own last count (already stale relative to its table — see rbac.ts's
    // header) + 1: `settings.approval_mode.manage` (D-23, owner-decided, not yet folded into
    // CONTRACTS.md §3 — same documented-drift situation, flagged for the architect to reconcile),
    // + 3 for the `employee` interface (W7, owner 2026-08-21): `hr.employee.read.own`,
    // `payroll.loan.read.own`, `payroll.loan.request.own` — each grants access to the caller's
    // own record only, and each is universal across the 10 roles.
    // + 3 for employment contracts (W7): `hr.contract.read.own` (universal — your
    // own contract), `hr.contract.read` (office read-anyone), `hr.contract.manage`
    // (owner/HR write).
    // + 2 for B-15 (owner 2026-08-22): `approval.code.issue` and
    // `auth.lockout.clear`, the two keys behind the one-time approval code that
    // replaced `POST /auth/pin/verify`.
    expect(PERMISSION_KEY_COUNT).toBe(156);
    expect(new Set(PERMISSION_KEYS).size).toBe(156); // no duplicate keys
  });

  it('has exactly 11 roles, in contract column order', () => {
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
      // KOKI (2026-08-23) went in HERE, before SUPERADMIN, which is an
      // insertion — and this position IS the column index into every row of the
      // matrix, so it was only safe because all 150 rows were rewritten in the
      // same change. Adding a role without rewriting every row silently
      // re-maps every column after it; the `no accidental holes` test below and
      // the per-role spot checks are what would catch that.
      RoleKey.KOKI,
      RoleKey.SUPERADMIN,
    ]);
  });

  // ── the cook (koki) ───────────────────────────────────────────────────────
  //
  // A cook exists because an outlet shift is a supervisor, a cashier and TWO
  // COOKS. Before the role existed they were created as `leader_outlet`, so
  // these tests are mostly about what a cook must NOT have — that inheritance
  // is the bug being fixed, and a future "just add one more key" is exactly how
  // it would come back.
  describe('koki (Juru Masak)', () => {
    it('can do their own HR and the kitchen floor', () => {
      for (const key of [
        'hr.attendance.check',
        'hr.employee.read.own',
        'hr.contract.read.own',
        'payroll.slip.read.own',
        'chat.read.own',
        'waste.create',
        'inventory.balance.read',
        'inventory.area_transfer.create',
        'pos.daily_stock.read',
        'product.read',
      ] as const) {
        expect(can(RoleKey.KOKI, key)).toBe(true);
      }
    });

    it('cannot touch a till, cash, or any document workflow', () => {
      for (const key of [
        'pos.shift.open',
        'pos.sale.create',
        'pettycash.create',
        'purchasing.po.receive',
        'opname.submit',
        'replenishment.submit',
        'return.ship',
        'delivery.receive',
        'user.create',
        'hr.employee.read',
      ] as const) {
        expect(can(RoleKey.KOKI, key)).toBe(false);
      }
    });

    it('is strictly narrower than leader_outlet, which is what it replaced', () => {
      const koki = new Set(permissionsForRole(RoleKey.KOKI));
      const leader = new Set(permissionsForRole(RoleKey.LEADER_OUTLET));
      // Every cook permission is one outlet staff already had — a cook is a
      // subset, not a new axis of authority.
      for (const key of koki) expect(leader.has(key)).toBe(true);
      expect(koki.size).toBeLessThan(leader.size);
    });
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

  it('only owner (and the all-access superadmin) holds settings.approval_chain.manage', () => {
    for (const role of RBAC_ROLE_ORDER) {
      expect(can(role, 'settings.approval_chain.manage')).toBe(
        role === RoleKey.OWNER || role === RoleKey.SUPERADMIN,
      );
    }
  });

  it('superadmin holds every permission in the matrix', () => {
    // The whole point of the role: if a key is ever added with `false` in the
    // last column, this fails and names it rather than leaving a surface
    // mysteriously unreachable for the account meant to reach everything.
    const missing = PERMISSION_KEYS.filter((key) => !can(RoleKey.SUPERADMIN, key));
    expect(missing).toEqual([]);
  });

  it('owner can reach the outlet and driver surfaces (2026-08-18 owner request)', () => {
    // These five gate `/outlet` and `/driver` in the frontend nav; owner held
    // none of them, which is why both surfaces were missing from the hub.
    for (const key of [
      'replenishment.create',
      'opname.create',
      'waste.create',
      'pettycash.create',
      'delivery.drop.execute',
    ] as const) {
      expect(can(RoleKey.OWNER, key)).toBe(true);
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

  it("rejects a typo'd key at COMPILE time, not just at runtime", () => {
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
    // SUPERADMIN is expected in every `rolesWithPermission` result by
    // definition — the segregation-of-duties claim this test makes is about
    // the nine business roles, so it is excluded rather than the assertion
    // being weakened.
    expect(
      rolesWithPermission('payment.pay')
        .filter((r) => r !== RoleKey.SUPERADMIN)
        .sort(),
    ).toEqual([RoleKey.OWNER, RoleKey.FINANCE].sort());
  });
});
