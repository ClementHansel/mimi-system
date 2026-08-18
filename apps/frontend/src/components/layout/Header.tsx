'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Menu, Bell, LogOut, UserCircle, ChevronDown } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { useSessionStore } from '@/stores/session-store';
import { useNavStore } from '@/stores/nav-store';
import { logout } from '@/lib/auth';
import { SyncStatusPill, SyncRetryButton } from '@/components/ui/SyncStatusPill';
import { cn } from '@/lib/utils';

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return (
    (parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '')
  ).toUpperCase();
}

export function Header() {
  const { t } = useI18n();
  const user = useSessionStore((s) => s.user);
  const setMobileMenuOpen = useNavStore((s) => s.setMobileMenuOpen);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClickAway(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    document.addEventListener('mousedown', onClickAway);
    return () => document.removeEventListener('mousedown', onClickAway);
  }, []);

  return (
    <header className="flex h-14 flex-none items-center gap-3 border-b border-border bg-surface-raised px-4">
      <button
        type="button"
        onClick={() => setMobileMenuOpen(true)}
        className="rounded-md p-2 text-text-secondary hover:bg-surface-sunken lg:hidden"
        aria-label={t('shell.toggleSidebar')}
      >
        <Menu className="size-5" />
      </button>

      <div className="flex-1" />

      <SyncStatusPill className="hidden sm:inline-flex" />
      <SyncRetryButton className="hidden sm:inline-flex" />

      <button
        type="button"
        className="relative rounded-md p-2 text-text-secondary hover:bg-surface-sunken"
        aria-label={t('shell.notifications')}
      >
        <Bell className="size-5" />
      </button>

      <div ref={menuRef} className="relative">
        <button
          type="button"
          onClick={() => setMenuOpen((o) => !o)}
          className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-surface-sunken"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          <span className="flex size-8 items-center justify-center rounded-full bg-brand-100 text-sm font-semibold text-brand-700">
            {user ? initials(user.name) : <UserCircle className="size-5" />}
          </span>
          <span className="hidden flex-col items-start leading-tight sm:flex">
            <span className="text-sm font-medium text-text-primary">{user?.name}</span>
            <span className="text-xs text-text-muted">{user ? t(`role.${user.roleKey}`) : ''}</span>
          </span>
          <ChevronDown className="hidden size-4 text-text-muted sm:block" />
        </button>

        {menuOpen && (
          <div
            role="menu"
            className={cn(
              'absolute right-0 top-full z-20 mt-1 w-48 rounded-md border border-border bg-surface-raised py-1 shadow-md',
            )}
          >
            <Link
              href="/me"
              role="menuitem"
              onClick={() => setMenuOpen(false)}
              className="flex items-center gap-2 px-3 py-2 text-sm text-text-primary hover:bg-surface-sunken"
            >
              <UserCircle className="size-4" /> {t('shell.myAccount')}
            </Link>
            <button
              type="button"
              role="menuitem"
              onClick={() => logout()}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-danger-600 hover:bg-danger-50"
            >
              <LogOut className="size-4" /> {t('shell.logout')}
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
