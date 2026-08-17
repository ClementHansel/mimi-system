'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronsLeft, ChevronsRight } from 'lucide-react';
import { NAV_SECTIONS } from '@/lib/nav';
import { usePermissions } from '@/lib/permissions';
import { useI18n } from '@/lib/i18n';
import { useNavStore } from '@/stores/nav-store';
import { cn } from '@/lib/utils';

/**
 * Role-aware sidebar. Every entry comes from `lib/nav.ts` (frozen after G1) —
 * this component only filters by permission and renders; it never defines
 * nav items itself, so Wave 4–5 never need to touch it to add a screen.
 */
export function Sidebar({ variant = 'desktop' }: { variant?: 'desktop' | 'mobile' }) {
  const pathname = usePathname();
  const { can } = usePermissions();
  const { t } = useI18n();
  const collapsed = useNavStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useNavStore((s) => s.toggleSidebar);
  const setMobileMenuOpen = useNavStore((s) => s.setMobileMenuOpen);

  const isCollapsed = variant === 'desktop' && collapsed;

  const sections = NAV_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((item) => can(item.permission)),
  })).filter((section) => section.items.length > 0);

  return (
    <nav
      className={cn(
        'flex h-full flex-col border-r border-border bg-surface-raised transition-[width]',
        variant === 'desktop' ? (isCollapsed ? 'w-16' : 'w-64') : 'w-full',
      )}
      aria-label={t('shell.appName')}
    >
      {variant === 'desktop' && (
        <div className={cn('flex items-center gap-2 border-b border-border px-4 py-4', isCollapsed && 'justify-center px-2')}>
          <span className="flex size-8 flex-none items-center justify-center rounded-md bg-brand-500 font-display text-sm font-bold text-white">
            MC
          </span>
          {!isCollapsed && <span className="truncate font-display text-base font-semibold text-text-primary">{t('shell.appName')}</span>}
        </div>
      )}

      <div className="flex-1 overflow-y-auto py-3">
        {sections.map((section) => (
          <div key={section.id} className="mb-2 px-2">
            {!isCollapsed && (
              <p className="px-2.5 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
                {t(section.labelKey)}
              </p>
            )}
            <ul className="flex flex-col gap-0.5">
              {section.items.map((item) => {
                const active = pathname === item.href || pathname?.startsWith(`${item.href}/`);
                const Icon = item.icon;
                return (
                  <li key={item.id}>
                    <Link
                      href={item.href}
                      onClick={() => setMobileMenuOpen(false)}
                      title={isCollapsed ? t(item.labelKey) : undefined}
                      className={cn(
                        'flex items-center gap-3 rounded-md px-2.5 py-2 text-sm font-medium transition-colors',
                        isCollapsed && 'justify-center',
                        active
                          ? 'bg-brand-50 text-brand-700'
                          : 'text-text-secondary hover:bg-surface-sunken hover:text-text-primary',
                      )}
                    >
                      <Icon className="size-5 flex-none" aria-hidden />
                      {!isCollapsed && <span className="truncate">{t(item.labelKey)}</span>}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>

      {variant === 'desktop' && (
        <button
          type="button"
          onClick={toggleSidebar}
          className="flex items-center justify-center gap-2 border-t border-border py-3 text-sm text-text-muted hover:bg-surface-sunken hover:text-text-primary"
          aria-label={t('shell.toggleSidebar')}
        >
          {isCollapsed ? <ChevronsRight className="size-4" /> : <ChevronsLeft className="size-4" />}
        </button>
      )}
    </nav>
  );
}
