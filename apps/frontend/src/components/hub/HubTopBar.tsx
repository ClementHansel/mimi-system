'use client';

import { LogOut } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { logout } from '@/lib/auth';

export interface HubTopBarProps {
  userName: string;
  roleLabel: string;
}

/**
 * F-HUB-2 — the chooser's ONLY chrome: a slim bar, not the app shell's
 * Sidebar+Header. Brand mark left; who's signed in, their role, and
 * sign-out right — matching the reference hub
 * (`aire/apps/frontend/src/app/hub/page.tsx`) shape without importing
 * anything from it.
 *
 * No theme toggle: `app/globals.css`'s design-tokens header states dark mode
 * is out of scope for Mimi Chicken OS ("tokens are defined once, no
 * `prefers-color-scheme` branch") — unlike AIRE, there is no theme system
 * here to surface a toggle for. Flagged in the ticket report as a deliberate
 * deviation from the reference model rather than an oversight.
 */
export function HubTopBar({ userName, roleLabel }: HubTopBarProps) {
  const { t } = useI18n();
  return (
    <header className="flex h-14 flex-none items-center justify-between border-b border-border px-4 sm:px-6">
      <div className="flex items-center gap-2">
        <span className="flex size-8 flex-none items-center justify-center rounded-md bg-brand-500 font-display text-sm font-bold text-white">
          MC
        </span>
        <span className="hidden font-display text-base font-semibold text-text-primary sm:inline">
          {t('shell.appName')}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <div className="hidden flex-col items-end leading-tight sm:flex">
          <span className="text-sm font-medium text-text-primary">{userName}</span>
          <span className="text-xs text-text-muted">{roleLabel}</span>
        </div>
        <button
          type="button"
          onClick={() => logout()}
          className="flex min-h-touch items-center gap-1.5 rounded-md px-3 text-sm font-medium text-text-secondary hover:bg-surface-sunken hover:text-danger-600"
        >
          <LogOut className="size-4" aria-hidden />
          <span>{t('shell.logout')}</span>
        </button>
      </div>
    </header>
  );
}
