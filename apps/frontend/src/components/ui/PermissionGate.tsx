'use client';

import type { ReactNode } from 'react';
import { ShieldAlert } from 'lucide-react';
import { usePermissions, type PermissionKeyOrKeys } from '@/lib/permissions';
import { useI18n } from '@/lib/i18n';
import { EmptyState } from './EmptyState';

/**
 * Render-gate a subtree by CONTRACTS.md §3 permission key(s). This is a UI
 * convenience only — real enforcement is always the server's
 * `PermissionsGuard` + RLS; hiding a button here must never be the only
 * thing standing between a role and an action.
 *
 * `permission` is ANY-of when given an array (see `hasPermission`).
 * `fallback` renders in place of `children` when denied; pass
 * `showMessage` for the standard "no access" empty state instead of
 * silently rendering nothing (the default, appropriate for hiding an
 * optional action button).
 */
export interface PermissionGateProps {
  permission: PermissionKeyOrKeys;
  children: ReactNode;
  fallback?: ReactNode;
  showMessage?: boolean;
}

export function PermissionGate({
  permission,
  children,
  fallback,
  showMessage,
}: PermissionGateProps) {
  const { can } = usePermissions();
  const { t } = useI18n();

  if (can(permission)) return <>{children}</>;
  if (fallback !== undefined) return <>{fallback}</>;
  if (showMessage)
    return <EmptyState icon={ShieldAlert} title={t('permissionGate.noAccess')} size="sm" />;
  return null;
}
