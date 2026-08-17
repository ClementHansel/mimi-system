'use client';

import { useI18n } from '@/lib/i18n';
import { DashboardShell } from '@/components/dashboard/DashboardShell';

/**
 * F03 `dashboard` (CONTRACTS §4.18, FR-DASH-01..04) — the Owner/Manager
 * landing page after login. All gating/branching (company-wide vs
 * single-outlet vs no-access) lives in `DashboardShell`, since which layout a
 * viewer gets is itself part of the RBAC decision here, not just per-tab
 * visibility.
 */
export default function DashboardPage() {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-4 p-4">
      <h1 className="font-display text-2xl font-semibold text-text-primary">{t('nav.dashboard')}</h1>
      <DashboardShell />
    </div>
  );
}
