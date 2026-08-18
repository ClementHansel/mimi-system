'use client';

import { LogOut, Store, ShoppingBag, LockKeyhole } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { Button, TabsList, TabsTrigger } from '@/components/ui';
import { SyncStatusPill } from '@/components/ui/SyncStatusPill';
import { logout } from '@/lib/auth';
import { useSessionStore } from '@/stores/session-store';
import { usePosShiftStore } from './shift-store';
import { usePosShell } from './PosShellContext';

/**
 * F-POS-2 — POS's own top bar, replacing the app sidebar/header for this
 * surface (see `app/pos/layout.tsx` and `AppShell`'s chromeless-route
 * branch). Shape reviewed against AIRE's live till (brand + branch on the
 * left, tab nav centred, session controls on the right) — but this only
 * carries controls Mimi's product actually has:
 *
 * - No language toggle. `lib/i18n/index.tsx` is explicit: "Bahasa Indonesia
 *   is the only locale (BUILD-PLAN §6.9) — there is no language switcher and
 *   no second dictionary." There is nothing to toggle to.
 * - No theme toggle. This design system carries no dark-mode token set
 *   anywhere (`app/globals.css`, `app/layout.tsx`) — adding one is a
 *   design-system change for the whole app, not a POS shell change, and out
 *   of this ticket's scope (`app/pos/**`/`components/pos/**` only). Flagged
 *   as a follow-up rather than shipped as a button that does nothing.
 *
 * In both slots this instead surfaces controls Mimi's shell already has
 * elsewhere (`Header.tsx`): connectivity/sync status and sign-out.
 *
 * The centre tab row only appears once there is something real to switch
 * between — before an outlet is resolved and a shift is open, `<TabsList>`
 * would just be three dead links over a picker/shift-open screen. Gating on
 * the exact same `posLocation`/`currentShift` state `PosPage` gates its own
 * content on keeps the two from ever disagreeing about "are we operational
 * yet".
 */
export function PosTopBar() {
  const { t } = useI18n();
  const { posLocation } = usePosShell();
  const user = useSessionStore((s) => s.user);
  const currentShift = usePosShiftStore((s) => s.current);

  const locationName = posLocation.status === 'ready' ? posLocation.location.name : null;
  const operational = posLocation.status === 'ready' && !!currentShift;

  return (
    <header className="flex flex-none flex-wrap items-center justify-between gap-3 border-b border-border bg-surface-raised px-4 py-2.5">
      <div className="flex items-center gap-3">
        <span
          className="flex size-9 flex-none items-center justify-center rounded-md bg-brand-500 font-display text-sm font-bold text-white"
          aria-hidden
        >
          MC
        </span>
        <div className="leading-tight">
          <p className="font-display text-sm font-semibold text-text-primary">{t('nav.pos')}</p>
          <p className="text-xs text-text-muted">
            {t('pos.branchLabel', { name: locationName ?? t('pos.noLocation') })}
          </p>
        </div>
      </div>

      {operational && (
        <TabsList className="border-b-0">
          <TabsTrigger value="kasir">
            <span className="flex items-center gap-1.5">
              <Store className="size-4" aria-hidden />
              {t('pos.tabKasir')}
            </span>
          </TabsTrigger>
          <TabsTrigger value="online">
            <span className="flex items-center gap-1.5">
              <ShoppingBag className="size-4" aria-hidden />
              {t('pos.tabOnlineOrder')}
            </span>
          </TabsTrigger>
          <TabsTrigger value="shift">
            <span className="flex items-center gap-1.5">
              <LockKeyhole className="size-4" aria-hidden />
              {t('pos.tabShift')}
            </span>
          </TabsTrigger>
        </TabsList>
      )}

      <div className="flex items-center gap-3">
        <SyncStatusPill className="hidden sm:inline-flex" />
        <span className="hidden text-sm font-medium text-text-primary sm:inline">{user?.name}</span>
        <Button
          type="button"
          variant="ghost"
          size="touch"
          leftIcon={<LogOut className="size-4" aria-hidden />}
          onClick={() => logout()}
        >
          <span className="hidden sm:inline">{t('shell.logout')}</span>
        </Button>
      </div>
    </header>
  );
}
