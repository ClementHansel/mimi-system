'use client';

import Link from 'next/link';
import { LayoutGrid } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { useSessionStore } from '@/stores/session-store';
import { usePermissions } from '@/lib/permissions';
import { NAV_SECTIONS, type NavItem } from '@/lib/nav';
import { EmptyState } from '@/components/ui/EmptyState';
import { getLandingRoute } from './(auth)/landing';

/**
 * F-BRAND home hub — the role-aware launchpad the owner asked for ("a home
 * to navigate to POS, Dasbor, Gudang — like AIRE's homepage"). Replaces the
 * old stub that always bounced to `/dashboard`; `/login` now redirects here
 * for every role instead of a per-role route.
 *
 * Every card's href/permission/label comes from `lib/nav.ts` — the single
 * source of truth the sidebar itself reads — filtered through the exact
 * same `usePermissions().can()` check `Sidebar` uses, so this can never
 * drift into showing a destination the sidebar (or the server) would deny.
 * This file adds NO second nav list; the only new data here is the hub's
 * own copy (`hub.*` in `lib/i18n/id.ts`) and the hero-vs-grid layout below.
 *
 * "Primary job" hero: `getLandingRoute` (`app/(auth)/landing.ts`) already
 * encodes which single destination is each role's day-to-day work (Kasir →
 * POS, Owner/Manager → Dasbor, Kepala Gudang → Gudang Pusat, …). Whichever
 * visible nav item matches that route is promoted to one large hero card;
 * everything else the role can reach renders as a smaller card, grouped by
 * `NAV_SECTIONS` section exactly like the sidebar groups them. For a Kasir
 * — who can only ever reach POS and their own "Akun Saya" — this naturally
 * produces the "essentially one enormous Kasir target" the owner asked for,
 * without a role-specific branch anywhere in this file.
 */
export default function HomePage() {
  const { t } = useI18n();
  const user = useSessionStore((s) => s.user);
  const { can } = usePermissions();

  // AppShell withholds children until hydrated + authenticated, so `user`
  // is expected non-null here; guard anyway rather than assume.
  if (!user) return null;

  // Plain loop (not a mutation captured inside .filter/.map) so TS's control
  // flow analysis narrows `heroItem` normally below, and so the "first
  // permission-visible item matching the role's landing route" search reads
  // as what it is rather than a filter side effect.
  const heroHref = getLandingRoute(user);
  let heroItem: NavItem | undefined;
  for (const section of NAV_SECTIONS) {
    for (const item of section.items) {
      if (item.href === heroHref && can(item.permission)) {
        heroItem = item;
        break;
      }
    }
    if (heroItem) break;
  }

  const secondarySections = NAV_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((item) => can(item.permission) && item.id !== heroItem?.id),
  })).filter((section) => section.items.length > 0);

  // Central roles (Owner/Manager/Finance/HR Admin) carry an empty
  // `locations` array by design — no outlet restriction, not "unassigned"
  // (`auth.service.ts`: "central roles with no user_locations rows") — so
  // the empty case reads as "Semua Lokasi", never as an incomplete setup.
  const outletLabel =
    user.locations.length === 0
      ? t('hub.allOutlets')
      : user.locations.length === 1
        ? user.locations[0]!.name
        : t('hub.multipleOutlets', { count: user.locations.length });

  const firstName = user.name.trim().split(/\s+/)[0] ?? user.name;
  const HeroIcon = heroItem?.icon ?? null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-brand-600">{t('hub.subtitle')}</p>
        <h1 className="font-display text-2xl font-semibold text-text-primary sm:text-3xl">
          {t('hub.greeting', { name: firstName })}
        </h1>
        <p className="text-sm text-text-secondary">
          {t('hub.roleAtOutlet', { role: t(`role.${user.roleKey}`), outlet: outletLabel })} · {t('hub.chooseWork')}
        </p>
      </div>

      {heroItem && HeroIcon && (
        <Link
          href={heroItem.href}
          className="group flex items-center gap-5 rounded-xl border border-brand-700 bg-gradient-to-br from-brand-500 to-brand-700 p-6 text-white shadow-md transition-transform focus-visible:scale-[1.005] sm:p-8"
        >
          <span className="flex size-14 flex-none items-center justify-center rounded-2xl bg-white/15 sm:size-16">
            <HeroIcon className="size-7 sm:size-8" aria-hidden />
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-white/70">{t('hub.primaryBadge')}</span>
            <h2 className="font-display text-xl font-bold sm:text-2xl">{t(heroItem.labelKey)}</h2>
            <p className="max-w-md text-sm text-white/85">{t(`hub.cardDescription.${heroItem.id}`)}</p>
          </div>
        </Link>
      )}

      {!heroItem && secondarySections.length === 0 && (
        <EmptyState
          icon={LayoutGrid}
          title={t('hub.emptyTitle')}
          description={t('hub.emptyDescription')}
          size="lg"
        />
      )}

      {secondarySections.map((section) => (
        <div key={section.id} className="flex flex-col gap-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">{t(section.labelKey)}</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {section.items.map((item) => {
              const Icon = item.icon;
              return (
                <Link
                  key={item.id}
                  href={item.href}
                  className="group flex min-h-touch-lg items-center gap-4 rounded-lg border border-border bg-surface-raised p-4 shadow-xs transition-colors hover:border-brand-300 hover:bg-brand-50"
                >
                  <span className="flex size-11 flex-none items-center justify-center rounded-lg bg-brand-50 text-brand-600 group-hover:bg-brand-100">
                    <Icon className="size-5" aria-hidden />
                  </span>
                  <div className="flex min-w-0 flex-col">
                    <span className="font-medium text-text-primary">{t(item.labelKey)}</span>
                    <span className="truncate text-sm text-text-muted">{t(`hub.cardDescription.${item.id}`)}</span>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
