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

/**
 * Where an interface's hub card should actually send THIS person.
 *
 * `AppInterface.href` is one fixed route, but reaching an interface is
 * deliberately ANY-of the areas inside it — a Finance user with no
 * `dashboard.view` still belongs in the dashboard, "they simply work in
 * `/finance` once in" (see `INTERFACES` in `nav.ts`). The hub card ignored
 * that and pointed everyone at `/dashboard`, so a DRIVER (in for
 * `delivery.read`) and the KEPALA GUDANG (in for `purchasing.read`) clicked
 * "Dasbor" and were told "Anda tidak memiliki akses ke bagian ini." — a card
 * offering work that leads nowhere. Found 2026-09-01 by walking the hub as
 * each real job.
 *
 * So: keep `href` when the person can open it, otherwise the first entry in
 * that interface's own sidebar that they can. Falls back to `href` when
 * nothing matches, because a card that goes to a refusal is still better than
 * a card that goes nowhere — and that case means the interface gate and its
 * sections disagree, which is a nav-config bug to fix at the source.
 *
 * This is NOT the same job as `(auth)/landing.ts`, which picks ONE route for a
 * role at login and is deliberately a fixed map. This answers a different
 * question — "this person clicked THIS card, where do they go" — for every
 * interface, not just the one they land in.
 */
export function interfaceEntryHref(
  iface: AppInterface,
  can: (keyOrKeys?: PermissionKeyOrKeys) => boolean,
  /**
   * This role's own landing route (`(auth)/landing.ts`), when there is one.
   * Optional so the pure-nav tests can exercise the fallback on its own.
   */
  landingRoute?: string,
): string {
  const entries = iface.sections.flatMap((section) => section.items);

  // The interface's own front door, if this person is allowed through it. An
  // entry whose `href` matches carries the permission that guards that route;
  // an interface whose front door is not listed in its sections (the
  // single-screen ones) is reachable by definition — the interface gate was
  // the only check there was.
  const front = entries.find((entry) => entry.href === iface.href);
  if (!front || can(front.permission)) return iface.href;

  // THE ROLE'S OWN HOME FIRST, if it lives in this interface and they can open
  // it. Without this, the fallback below picks whatever happens to sit at the
  // top of the sidebar — which sent FINANCE to "Persetujuan Saya" instead of
  // Keuangan, because `/approvals` is listed first and they hold an approval
  // key. Right destination, wrong one for them. `landing.ts` already encodes
  // where each role actually works ("Kasir opens straight into POS"), so this
  // reuses that answer rather than inventing a second, worse one.
  if (landingRoute) {
    const home = entries.find((entry) => entry.href === landingRoute);
    if (home && can(home.permission)) return home.href;
  }

  return entries.find((entry) => can(entry.permission))?.href ?? iface.href;
}
