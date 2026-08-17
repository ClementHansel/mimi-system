'use client';

import { useSessionStore } from '@/stores/session-store';
import type { PermissionKey } from '@/lib/shared-types';

/**
 * `can(key)` — the one place nav filtering, `PermissionGate`, and page-level
 * guards check RBAC. Reads the flat `permissions` array the backend already
 * computed for this user at login (CONTRACTS §4.1 `Me.permissions`) — the
 * enforcement authority is always the server's `PermissionsGuard` +
 * RLS (CONTRACTS §3 "Rules of use"); this is a UI-visibility check only, so a
 * hidden button is never the only thing standing between a role and an
 * action.
 *
 * A key can be a single permission or an array (ANY-of) — several nav
 * entries are visible to more than one of the 9 roles via different keys
 * (e.g. the Dashboard entry needs `dashboard.view` OR `dashboard.outlet.view`).
 * Typed against `@mimi/shared`'s `PermissionKey` (currently a `string` alias,
 * not a narrowed literal union — see that package's `rbac.ts`) so this stays
 * a same-vocabulary reference rather than a redefinition; a mistyped key
 * fails closed at runtime (denied) rather than at compile time.
 */
export type PermissionKeyOrKeys = PermissionKey | PermissionKey[];

export function hasPermission(permissions: string[], keyOrKeys?: PermissionKeyOrKeys): boolean {
  if (!keyOrKeys) return true;
  const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
  if (keys.length === 0) return true;
  return keys.some((k) => permissions.includes(k));
}

export function usePermissions(): {
  permissions: string[];
  roleKey: string | null;
  can: (keyOrKeys?: PermissionKeyOrKeys) => boolean;
} {
  const user = useSessionStore((s) => s.user);
  const permissions = user?.permissions ?? [];
  return {
    permissions,
    roleKey: user?.roleKey ?? null,
    can: (keyOrKeys) => hasPermission(permissions, keyOrKeys),
  };
}
