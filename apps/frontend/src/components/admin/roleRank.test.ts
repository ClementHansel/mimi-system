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
      RoleKey.LEADER_OUTLET,
      RoleKey.KASIR,
      RoleKey.HR_ADMIN,
      RoleKey.DRIVER,
    ]);
  });

  it('the Owner can assign every other role', () => {
    const options = assignableRoles(RoleKey.OWNER);
    expect(options).toHaveLength(8);
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
