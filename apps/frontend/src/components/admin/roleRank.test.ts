import { describe, it, expect } from 'vitest';
import { RoleKey } from '@/lib/shared-types';
import { assignableRoles, roleRank } from './roleRank';

describe('roleRank / assignableRoles', () => {
  it('ranks Owner as most senior and Driver as least senior', () => {
    expect(roleRank(RoleKey.OWNER)).toBeLessThan(roleRank(RoleKey.MANAGER));
    expect(roleRank(RoleKey.MANAGER)).toBeLessThan(roleRank(RoleKey.DRIVER));
  });

  it('a Manager cannot mint an Owner — Owner is excluded from assignable roles', () => {
    const options = assignableRoles(RoleKey.MANAGER);
    expect(options).not.toContain(RoleKey.OWNER);
  });

  it('a Manager cannot mint another Manager (peer rank is not strictly junior)', () => {
    const options = assignableRoles(RoleKey.MANAGER);
    expect(options).not.toContain(RoleKey.MANAGER);
  });

  it('a Manager can assign every role below Manager', () => {
    const options = assignableRoles(RoleKey.MANAGER);
    expect(options).toEqual([
      RoleKey.FINANCE,
      RoleKey.KEPALA_GUDANG,
      RoleKey.SUPERVISOR,
      // No LEADER_OUTLET: retired 2026-08-23 (migration 237), so it must not be
      // offerable to anyone. It remains in `RoleKey` and in the RBAC matrix for
      // reading historical rows that name it — this list is about what can be
      // GRANTED, which is now nothing.
      RoleKey.KOKI,
      RoleKey.KASIR,
      RoleKey.HR_ADMIN,
      RoleKey.DRIVER,
    ]);
  });

  it('the Owner can assign every other role', () => {
    const options = assignableRoles(RoleKey.OWNER);
    expect(options).toHaveLength(8); // every assignable role except Owner (leader_outlet is retired)
    expect(options).not.toContain(RoleKey.OWNER);
  });

  it('a Driver (least senior) has nothing it can assign', () => {
    expect(assignableRoles(RoleKey.DRIVER)).toEqual([]);
  });

  it('returns an empty list with no caller role (no session)', () => {
    expect(assignableRoles(null)).toEqual([]);
    expect(assignableRoles(undefined)).toEqual([]);
  });
});
