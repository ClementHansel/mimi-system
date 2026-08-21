import { INTERFACES, type AppInterface } from './nav';
import type { PermissionKeyOrKeys } from './permissions';

/**
 * Who the hub (`/`, `app/page.tsx`) is for.
 *
 * It used to be two named roles (owner, superadmin) and everyone else was
 * redirected past it. That stopped being right the moment `employee` became
 * its own interface (owner, 2026-08-21): a Kasir now genuinely has more than
 * one place to be — the till, and their own account — so they need the same
 * chooser the owner has. A Leader Outlet has three.
 *
 * So the rule is structural, not a role list: you get the hub when you can
 * reach MORE THAN ONE interface. Reach exactly one, and a directory of one
 * card would be a pointless click on the way to work, so that person is
 * redirected straight into it.
 */
export function reachableInterfaces(
  can: (keyOrKeys?: PermissionKeyOrKeys) => boolean,
): AppInterface[] {
  // `permission: undefined` means everyone (`employee`, `docs`) — see `nav.ts`.
  return INTERFACES.filter((iface) => !iface.permission || can(iface.permission));
}

/** True when the hub is worth showing: two or more interfaces to choose between. */
export function hasHub(can: (keyOrKeys?: PermissionKeyOrKeys) => boolean): boolean {
  return reachableInterfaces(can).length > 1;
}
