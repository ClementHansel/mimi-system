import { RoleKey, type Me } from '@/lib/shared-types';

/**
 * Role-appropriate post-login landing route (F01 done-criterion: "redirect to
 * a role-appropriate landing page"). A fixed map rather than "first nav item
 * the role can see" — deterministic and matches how each role actually works
 * day to day (Kasir opens straight into POS, not a dashboard they can't act
 * on). This is UI convenience only: landing on the wrong page is never a
 * security concern because every page enforces its own access (PermissionGate
 * + the server), it would just be a bad first impression.
 */
const ROLE_LANDING: Record<string, string> = {
  [RoleKey.OWNER]: '/',
  [RoleKey.MANAGER]: '/dashboard',
  [RoleKey.FINANCE]: '/finance',
  [RoleKey.KEPALA_GUDANG]: '/warehouse',
  [RoleKey.SUPERVISOR]: '/outlet',
  [RoleKey.LEADER_OUTLET]: '/outlet',
  [RoleKey.KASIR]: '/pos',
  [RoleKey.HR_ADMIN]: '/hr',
  [RoleKey.DRIVER]: '/driver',
  // A cook works the outlet screen — what to prep, what is in stock, what
  // spoiled. Same surface as the supervisor, a much narrower set of actions on
  // it (`waste.create` is what makes it reachable at all; see lib/nav.ts).
  [RoleKey.KOKI]: '/outlet',
  // Owner and Super Admin land on the HUB, not a single surface: they are the
  // two roles that see every interface, so the directory is their home rather
  // than a detour (app/page.tsx redirects every other role past it).
  [RoleKey.SUPERADMIN]: '/',
};

/** Fallback for an unrecognized/future role key — `/me` is the one surface every employee can reach. */
const DEFAULT_LANDING = '/me';

export function getLandingRoute(user: Pick<Me, 'roleKey'>): string {
  return ROLE_LANDING[user.roleKey] ?? DEFAULT_LANDING;
}
