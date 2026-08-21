'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronsLeft, ChevronsRight, Home } from 'lucide-react';
import { INTERFACES, interfaceForPath, type NavSection } from '@/lib/nav';
import { usePermissions } from '@/lib/permissions';
import { useI18n } from '@/lib/i18n';
import { useSessionStore } from '@/stores/session-store';
import { hasHub } from '@/lib/hub';
import { useNavStore } from '@/stores/nav-store';
import { cn } from '@/lib/utils';

/**
 * Role-aware, INTERFACE-aware sidebar.
 *
 * It renders the sidebar of the interface the current route belongs to
 * (`interfaceForPath`), not one global nav tree: inside the dashboard that is
 * the head-office tree; inside Gudang Pusat it is the stock floor plus Surat
 * Jalan; Outlet, Driver and Dokumentasi are single-screen. Before this, every
 * route showed all 14 links, so a Kepala Gudang on the warehouse floor was one
 * tap from Payroll and the dashboard's areas read as peers of POS.
 *
 * SHARED surfaces (`/delivery`, `/me/chat`) resolve against
 * `currentInterfaceId` — the interface you were last unambiguously in — so
 * opening Surat Jalan from the office keeps the office sidebar and opening it
 * from gudang keeps gudang's. Without that, one of the two would have to be
 * declared the owner and the other would be teleported out of its interface
 * mid-task.
 *
 * A HOME row back to the hub appears for anyone who can reach more than one
 * interface (`hasHub`) — which, since `employee` became an interface of its
 * own, is nearly everyone: a Kasir has the till and their own account. Someone
 * with exactly one interface gets no Home row, because `/` would only bounce
 * them back to where they already are.
 *
 * That single row replaced an "Antarmuka Lain" switcher group: with a hub for
 * everyone, listing the other interfaces in the sidebar too was the same
 * directory rendered twice.
 *
 * Entries still come from `lib/nav.ts`; this component only resolves, filters
 * by permission, and renders.
 */
export function Sidebar({ variant = 'desktop' }: { variant?: 'desktop' | 'mobile' }) {
  const pathname = usePathname() ?? '/';
  const { can } = usePermissions();
  const { t } = useI18n();
  const user = useSessionStore((s) => s.user);
  const collapsed = useNavStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useNavStore((s) => s.toggleSidebar);
  const setMobileMenuOpen = useNavStore((s) => s.setMobileMenuOpen);

  const isCollapsed = variant === 'desktop' && collapsed;
  const showHome = !!user && hasHub(can);

  const currentInterfaceId = useNavStore((s) => s.currentInterfaceId);
  const setCurrentInterfaceId = useNavStore((s) => s.setCurrentInterfaceId);

  const active = interfaceForPath(pathname, currentInterfaceId);

  // A route no interface claims (there should be none, but a new page can land
  // before its nav entry does) falls back to the dashboard's sections rather
  // than an empty sidebar.
  const iface = active ?? INTERFACES[0]!;

  // Remember where we are so the next shared surface resolves to this
  // interface. Written in an effect, never during render — the store is shared
  // with the mobile drawer, which renders the same component.
  useEffect(() => {
    if (active) setCurrentInterfaceId(active.id);
  }, [active, setCurrentInterfaceId]);

  const sections: NavSection[] =
    iface.sections.length > 0
      ? iface.sections
          .map((section) => ({
            ...section,
            items: section.items.filter((item) => can(item.permission)),
          }))
          .filter((section) => section.items.length > 0)
      : [
          // Single-screen interface: one unlabeled section holding the
          // interface itself, so the user can still see where they are.
          {
            id: iface.id,
            labelKey: '',
            items: [
              {
                id: iface.id,
                labelKey: iface.labelKey,
                href: iface.href,
                icon: iface.icon,
                permission: iface.permission ?? [],
              },
            ],
          },
        ];

  return (
    <nav
      className={cn(
        'flex h-full flex-col border-r border-border bg-surface-raised transition-[width]',
        variant === 'desktop' ? (isCollapsed ? 'w-16' : 'w-64') : 'w-full',
      )}
      aria-label={t('shell.appName')}
    >
      {variant === 'desktop' && (
        <div
          className={cn(
            'flex items-center gap-2 border-b border-border px-4 py-4',
            isCollapsed && 'justify-center px-2',
          )}
        >
          <span className="flex size-8 flex-none items-center justify-center rounded-md bg-brand-500 font-display text-sm font-bold text-white">
            MC
          </span>
          {!isCollapsed && (
            <div className="flex min-w-0 flex-col leading-tight">
              <span className="truncate font-display text-base font-semibold text-text-primary">
                {t('shell.appName')}
              </span>
              {/* Which of the six interfaces you are in — the hub's card and
                  this label are the same name, so switching never feels like
                  landing in an unrelated app. */}
              <span className="truncate text-xs text-text-muted">{t(iface.labelKey)}</span>
            </div>
          )}
        </div>
      )}

      <div className="flex-1 overflow-y-auto py-3">
        {showHome && (
          <div className="mb-1 border-b border-border px-2 pb-2">
            <Link
              href="/"
              onClick={() => setMobileMenuOpen(false)}
              title={isCollapsed ? t('nav.home') : undefined}
              className={cn(
                'flex items-center gap-3 rounded-md px-2.5 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-sunken hover:text-text-primary',
                isCollapsed && 'justify-center',
              )}
            >
              <Home className="size-5 flex-none" aria-hidden />
              {!isCollapsed && <span className="truncate">{t('nav.home')}</span>}
            </Link>
          </div>
        )}

        {sections.map((section) => (
          <div key={section.id} className="mb-2 px-2">
            {!isCollapsed && section.labelKey && (
              <p className="px-2.5 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
                {t(section.labelKey)}
              </p>
            )}
            <ul className="flex flex-col gap-0.5">
              {section.items.map((item) => {
                const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
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
                        isActive
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
