'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { LayoutDashboard, ShoppingCart, BookOpen, LayoutGrid } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { useSessionStore, type SessionUser } from '@/stores/session-store';
import { usePermissions, type PermissionKeyOrKeys } from '@/lib/permissions';
import { NAV_SECTIONS, ALL_NAV_ITEMS } from '@/lib/nav';
import { EmptyState } from '@/components/ui/EmptyState';
import { HubTopBar } from '@/components/hub/HubTopBar';
import { WorkspaceCard } from '@/components/hub/WorkspaceCard';
import { getLandingRoute } from './(auth)/landing';

/**
 * F-HUB-2 — the home hub, rebuilt as a standalone WORKSPACE CHOOSER (owner
 * review against AIRE's live hub: the F-BRAND version that shipped earlier
 * kept the full app sidebar and a card per permitted destination — "a
 * second navigation menu, not a simplification"). This page now renders with
 * NO sidebar and no app chrome (see `AppShell`'s `CHROMELESS_ROUTES`) —
 * just `HubTopBar` and a centred greeting + at most 3 large workspace cards.
 *
 * The 3 workspaces are fixed (Dasbor / Kasir / Dokumentasi), but each one's
 * VISIBILITY and target href are still derived live from `lib/nav.ts` +
 * `usePermissions().can()` — never hand-listed — so a cashier can never see
 * a Dasbor card they have no permission to use:
 *
 *  - Kasir  = visible iff the user can reach `lib/nav.ts`'s `pos` entry.
 *  - Dasbor = visible iff the user can reach any OTHER NAV_SECTIONS entry —
 *    "everything that lives behind the sidebar today" per the ticket —
 *    EXCEPT `me` ("Akun Saya"). `me`'s permission (`payroll.slip.read.own`)
 *    is near-universal (every employee can see their own payslip), so
 *    counting it here would make "Dasbor" spuriously visible for every
 *    Kasir and defeat the single-workspace auto-redirect below, which the
 *    ticket specifically motivates with "a typical cashier". `me` still
 *    gets a chance to matter as the last-resort redirect target for an
 *    account with neither Dasbor nor Kasir access (see `redirectHref`).
 *  - Dokumentasi = always visible. User manuals aren't modeled as a
 *    permission in `lib/nav.ts` (they're not an RBAC-gated app surface), and
 *    reading them isn't privileged, so there is nothing to derive here.
 *
 * A user with exactly one of {Dasbor, Kasir} available never sees the
 * chooser at all — this component redirects straight there. Documentation
 * is deliberately NOT counted toward that "exactly one" check: it's a
 * reference resource, not a place to work, so its constant presence
 * shouldn't stop a cashier standing at a till from landing straight in POS.
 */

const DASBOR_EXCLUDED_IDS = new Set(['pos', 'me']);

/** First NAV_SECTIONS destination (outside POS/`me`) this user can reach —
 * preferring their role's normal landing route (`(auth)/landing.ts`) so the
 * Dasbor card takes an Owner to `/dashboard`, a Kepala Gudang to
 * `/warehouse`, etc., exactly like the old hero card did — falling back to
 * the first reachable item in nav order for any role/permission combo whose
 * landing route isn't itself one of that role's visible items. */
function findDasborTarget(user: SessionUser, can: (k?: PermissionKeyOrKeys) => boolean): string | undefined {
  const landingHref = getLandingRoute(user);
  let fallback: string | undefined;
  for (const section of NAV_SECTIONS) {
    for (const item of section.items) {
      if (DASBOR_EXCLUDED_IDS.has(item.id) || !can(item.permission)) continue;
      if (item.href === landingHref) return item.href;
      fallback ??= item.href;
    }
  }
  return fallback;
}

export default function HomePage() {
  const { t } = useI18n();
  const router = useRouter();
  const user = useSessionStore((s) => s.user);
  const { can } = usePermissions();

  const posItem = ALL_NAV_ITEMS.find((i) => i.id === 'pos');
  const meItem = ALL_NAV_ITEMS.find((i) => i.id === 'me');
  const kasirVisible = !!posItem && can(posItem.permission);
  const meVisible = !!meItem && can(meItem.permission);
  const dasborTarget = user ? findDasborTarget(user, can) : undefined;

  const operationalCount = (dasborTarget ? 1 : 0) + (kasirVisible ? 1 : 0);
  const redirectHref =
    operationalCount === 1
      ? kasirVisible
        ? (posItem?.href ?? '/pos')
        : dasborTarget
      : operationalCount === 0 && meVisible
        ? (meItem?.href ?? '/me')
        : null;

  // AppShell withholds children until hydrated + authenticated, so `user`
  // is expected non-null by the time this runs; the effect still guards
  // against a null `redirectHref` so it never fires for a null user (whose
  // dasborTarget/operationalCount above resolve to the "show nothing"
  // shape) or for the normal multi-workspace case.
  useEffect(() => {
    if (redirectHref) router.replace(redirectHref);
  }, [redirectHref, router]);

  if (!user) return null;
  if (redirectHref) return null; // redirecting — never flash a one-card chooser

  // `session-store` guarantees `locations` is an array before it lets a
  // session hydrate, but default here too: a missing array used to throw
  // mid-render and hand the visitor Next's client-side-exception screen,
  // which is a far worse failure than showing "all outlets".
  const locations = user.locations ?? [];
  const outletLabel =
    locations.length === 0
      ? t('hub.allOutlets')
      : locations.length === 1
        ? locations[0]!.name
        : t('hub.multipleOutlets', { count: locations.length });

  const firstName = user.name.trim().split(/\s+/)[0] ?? user.name;

  return (
    <div className="flex min-h-dvh flex-col bg-surface">
      <HubTopBar userName={user.name} roleLabel={t(`role.${user.roleKey}`)} />

      <main className="flex flex-1 flex-col items-center justify-center px-4 py-12 sm:px-6">
        <div className="flex w-full max-w-4xl flex-col items-center gap-8">
          <div className="flex flex-col items-center gap-1.5 text-center">
            <p className="text-xs font-semibold uppercase tracking-widest text-brand-600">{t('hub.overline')}</p>
            <h1 className="font-display text-3xl font-bold text-text-primary sm:text-4xl">
              {t('hub.greeting', { name: firstName })}
            </h1>
            <p className="text-sm text-text-muted">
              {t('hub.roleAtOutlet', { role: t(`role.${user.roleKey}`), outlet: outletLabel })}
            </p>
            <p className="mt-2 text-base text-text-secondary">{t('hub.subtitle')}</p>
          </div>

          {!dasborTarget && !kasirVisible && (
            <EmptyState icon={LayoutGrid} title={t('hub.emptyTitle')} description={t('hub.emptyDescription')} size="lg" />
          )}

          <div className="grid w-full grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {dasborTarget && (
              <WorkspaceCard
                href={dasborTarget}
                icon={LayoutDashboard}
                title={t('nav.dashboard')}
                description={t('hub.workspace.dasbor.description')}
              />
            )}
            {kasirVisible && (
              <WorkspaceCard
                href={posItem?.href ?? '/pos'}
                icon={ShoppingCart}
                title={t('nav.pos')}
                description={t('hub.workspace.kasir.description')}
              />
            )}
            <WorkspaceCard
              href="/docs"
              icon={BookOpen}
              title={t('hub.workspace.dokumentasi.title')}
              description={t('hub.workspace.dokumentasi.description')}
            />
          </div>
        </div>
      </main>
    </div>
  );
}
