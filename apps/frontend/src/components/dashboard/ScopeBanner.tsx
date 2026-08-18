import { Building2, Store } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { DashboardScope } from './lib/types';

/**
 * FR-DASH's non-negotiable requirement: "scope is visible in the numbers."
 * Every dashboard body must be preceded by this banner so a Supervisor never
 * mistakes their one-outlet figures for the company total, and an Owner never
 * mistakes a drill-down for the whole business.
 *
 * `scope` is derived from the viewer's PERMISSIONS (`dashboard.view` →
 * 'company', `dashboard.outlet.view`-only → 'outlet'), never guessed from the
 * response payload — `CONTRACTS.md`'s RBAC matrix (§3) makes central-role
 * membership (Owner/Manager/Finance/HR Admin, `scope.service.ts`) the only
 * source of truth for "does this account see every outlet or just its own."
 */
export interface ScopeBannerProps {
  scope: DashboardScope;
  /** Required when `scope === 'outlet'` — the one outlet these figures cover. */
  outletName?: string | null;
  outletCity?: string | null;
  className?: string;
}

export function ScopeBanner({ scope, outletName, outletCity, className }: ScopeBannerProps) {
  const { t } = useI18n();
  const isCompany = scope === 'company';

  return (
    <div
      role="status"
      className={cn(
        'flex items-center gap-3 rounded-lg border px-4 py-3',
        isCompany ? 'border-brand-200 bg-brand-50' : 'border-warning-200 bg-warning-50',
        className,
      )}
    >
      <span
        className={cn(
          'flex size-9 flex-none items-center justify-center rounded-full',
          isCompany ? 'bg-brand-100 text-brand-700' : 'bg-warning-100 text-warning-700',
        )}
      >
        {isCompany ? (
          <Building2 className="size-5" aria-hidden />
        ) : (
          <Store className="size-5" aria-hidden />
        )}
      </span>
      <div className="flex flex-col">
        <span
          className={cn('text-sm font-semibold', isCompany ? 'text-brand-800' : 'text-warning-800')}
        >
          {isCompany
            ? t('dashboard.scope.companyTitle')
            : t('dashboard.scope.outletTitle', {
                name: outletName || t('dashboard.scope.unknownOutlet'),
              })}
        </span>
        <span className="text-xs text-text-secondary">
          {isCompany
            ? t('dashboard.scope.companyHint')
            : t('dashboard.scope.outletHint', { city: outletCity || '—' })}
        </span>
      </div>
    </div>
  );
}
