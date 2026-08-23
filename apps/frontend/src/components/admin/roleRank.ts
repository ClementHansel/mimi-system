import { RoleKey } from '@/lib/shared-types';
import { id } from '@/lib/i18n/id';

/**
 * Seniority order, most senior first — follows `packages/shared/src/rbac.ts`'s
 * `RBAC_ROLE_ORDER` (CONTRACTS.md §3's column order) except where column order
 * and authority genuinely disagree; see `KOKI` below. Used ONLY to filter the
 * role-assignment picker in the Users admin screen; the authoritative rule —
 * "cannot assign a role ranked ≥ caller's own" (CONTRACTS §4.2
 * `PUT /api/users/:id/role`) — is enforced server-side regardless of what
 * this offers, so a mismatch here is a bad picker, never a security hole.
 */
export const ROLE_SENIORITY: readonly RoleKey[] = [
  RoleKey.OWNER,
  RoleKey.MANAGER,
  RoleKey.FINANCE,
  RoleKey.KEPALA_GUDANG,
  RoleKey.SUPERVISOR,
  RoleKey.LEADER_OUTLET,
  // Outlet floor staff, alongside the cashier. This is the ONE place the order
  // deliberately diverges from `RBAC_ROLE_ORDER`, where `KOKI` sits
  // second-to-last: that array's positions are matrix COLUMN INDEXES and a new
  // role has to be appended there, while this array is about AUTHORITY. Putting
  // a cook last would have made them the only role a Driver could assign, which
  // is a nonsense the seniority filter should not produce.
  RoleKey.KOKI,
  RoleKey.KASIR,
  RoleKey.HR_ADMIN,
  RoleKey.DRIVER,
] as const;

/** Lower = more senior. An unrecognized role key sorts as most junior (never assignable-looking to anyone). */
export function roleRank(role: string): number {
  const idx = ROLE_SENIORITY.indexOf(role as RoleKey);
  return idx === -1 ? ROLE_SENIORITY.length : idx;
}

/** Roles the caller may pick in the "assign role" UI — strictly less senior than their own. */
export function assignableRoles(callerRoleKey: string | null | undefined): RoleKey[] {
  if (!callerRoleKey) return [];
  const callerRank = roleRank(callerRoleKey);
  return ROLE_SENIORITY.filter((r) => roleRank(r) > callerRank);
}

export function roleLabel(roleKey: string): string {
  return (id.role as Record<string, string>)[roleKey] ?? roleKey;
}
