import { RoleKey } from '@/lib/shared-types';
import { id } from '@/lib/i18n/id';

/**
 * Seniority order, most senior first — mirrors `packages/shared/src/rbac.ts`'s
 * `RBAC_ROLE_ORDER` (CONTRACTS.md §3's column order). Used ONLY to filter the
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
