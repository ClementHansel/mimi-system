'use client';

import type { ReactNode } from 'react';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { useOutletLocation } from './lib/use-outlet-location';
import { OutletLocationProvider } from './lib/outlet-location-context';

/**
 * The frame every `/outlet/*` page sits in: resolve WHICH OUTLET once, then
 * mount the page's panel with that outlet settled.
 *
 * WHY THE FLOWS ARE SEPARATE ROUTES NOW (owner, 2026-08-27: "in outlet, these
 * top tab need to be changed into outlet sidebar"). They used to be eight tabs
 * on one page. Tabs are the wrong control for these: they are not eight views
 * of one thing, they are eight different jobs, several of them done at
 * different times of day by different people. As tabs they were unlinkable
 * (nothing could point at "Stok Opname"), unbookmarkable, lost on every reload,
 * and all eight panels' worth of nav was crammed into a row that wrapped on a
 * till-sized screen. As sidebar entries each one has a URL, keeps its place,
 * and reads as the list of things this outlet does.
 *
 * WHY RESOLUTION LIVES HERE AND NOT IN EACH PAGE. It is the one piece of state
 * all eight share, and the one that was previously got wrong: a central role
 * has `Me.locations: []` (D-05), so a page that assumes an assigned outlet
 * shows an empty screen forever. Putting it in the shell means a new
 * `/outlet/*` page cannot forget it, and below `OutletLocationProvider` the id
 * is a plain `string` rather than something each panel has to null-check —
 * which is exactly how the original bug got in.
 */
export function OutletShell({
  titleKey,
  children,
}: {
  /** i18n key for the page heading — the one flow this route is for. */
  titleKey: string;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const outlet = useOutletLocation();

  const heading = (
    <h1 className="font-display text-2xl font-semibold text-text-primary">{t(titleKey)}</h1>
  );

  if (outlet.status === 'loading') {
    return (
      <div className="flex flex-col gap-4 p-4">
        {heading}
        <p className="text-sm text-text-secondary">{t('common.loading')}</p>
      </div>
    );
  }

  // Terminal and retryable — never an indefinite spinner. The outlet list is a
  // server call (`location.read`-filtered), so it can fail like any other.
  if (outlet.status === 'error') {
    return (
      <div className="flex flex-col gap-4 p-4">
        {heading}
        <EmptyState
          size="lg"
          title={t('outlet.location.loadFailedTitle')}
          description={t('outlet.location.loadFailedDescription')}
        />
        <Button variant="outline" className="self-start" onClick={outlet.retry}>
          {t('common.retry')}
        </Button>
      </div>
    );
  }

  // A central role has no assigned outlet, so it picks one. This is the branch
  // that used to be an endless loading skeleton.
  if (outlet.status === 'choose') {
    return (
      <div className="flex flex-col gap-4 p-4">
        {heading}
        <div className="flex max-w-md flex-col gap-2 rounded-md border border-border p-4">
          <p className="font-medium text-text-primary">{t('outlet.location.chooseTitle')}</p>
          <p className="text-sm text-text-secondary">{t('outlet.location.chooseDescription')}</p>
          <ul className="mt-1 flex flex-col gap-1">
            {outlet.options.map((o) => (
              <li key={o.id}>
                <Button
                  variant="outline"
                  className="w-full justify-start"
                  onClick={() => outlet.select(o.id)}
                >
                  {o.name}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* AppShell already owns the single OfflineBanner for this (non-chromeless) route. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        {heading}
        {/* Which outlet this flow is acting on. Shown on EVERY page, not only
            where it is switchable: these screens edit stock, waste and petty
            cash, so "which outlet am I touching" must never be a guess — and
            now that each flow is its own URL, an owner can arrive on one
            directly without having passed a picker. */}
        <div className="flex items-center gap-2 text-sm">
          <span className="text-text-secondary">{t('outlet.location.current')}</span>
          <span className="font-medium text-text-primary">{outlet.location.name}</span>
          {outlet.canChange && (
            <Button size="sm" variant="outline" onClick={outlet.change}>
              {t('outlet.location.change')}
            </Button>
          )}
        </div>
      </div>

      <OutletLocationProvider location={outlet.location}>{children}</OutletLocationProvider>
    </div>
  );
}
