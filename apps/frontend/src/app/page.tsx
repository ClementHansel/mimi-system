'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { LayoutGrid } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { useSessionStore } from '@/stores/session-store';
import { usePermissions } from '@/lib/permissions';
import { interfaceEntryHref, reachableInterfaces } from '@/lib/hub';
import { EmptyState } from '@/components/ui/EmptyState';
import { HubTopBar } from '@/components/hub/HubTopBar';
import { WorkspaceCard } from '@/components/hub/WorkspaceCard';
import { getLandingRoute } from './(auth)/landing';

/**
 * The home hub — a directory of the interfaces this person can reach.
 *
 * Owner's rulings (2026-08-21): the system has seven distinct interfaces
 * (Dashboard, POS, Outlet, Gudang Pusat, Driver, Akun Saya, Dokumentasi) and
 * the hub shows one card per interface — no more. The previous version derived a card from
 * every nav entry, so it listed all fourteen routes (Persetujuan, Pembelian,
 * Keuangan, SDM, Administrasi…) as if each were a peer of POS. Those are areas
 * INSIDE the dashboard; they belong in its sidebar, and putting them here made
 * the home screen a second, flatter navigation menu — which is exactly what the
 * owner rejected. The interface list now lives in `lib/nav.ts` (`INTERFACES`),
 * so this page and the sidebar can never disagree about what an interface is.
 *
 * The hub is no longer owner-only. Since `employee` became its own interface,
 * an ordinary Kasir has two places to be — the till, and their own account —
 * and a Leader Outlet three, so anyone who can reach MORE THAN ONE interface
 * lands here. Someone with exactly one still never sees this page: a directory
 * of a single card is a pointless click on the way to work, so they are
 * redirected to their landing route (`(auth)/landing.ts`).
 *
 * Cards are permission-DERIVED (`usePermissions().can()`), never hand-listed,
 * which is what keeps the hub honest as roles change.
 */
export default function HomePage() {
  const { t } = useI18n();
  const router = useRouter();
  const user = useSessionStore((s) => s.user);
  const { can } = usePermissions();

  // `permission: undefined` (Akun Saya, Dokumentasi) means everyone — neither
  // reading the manual nor opening your own payslip is a privileged act.
  const interfaces = reachableInterfaces(can);
  // Computed before the effect so the redirect target is stable across renders
  // and the effect does not re-fire on every parent update.
  const redirectHref = user && interfaces.length <= 1 ? getLandingRoute(user) : null;

  useEffect(() => {
    if (redirectHref) router.replace(redirectHref);
  }, [redirectHref, router]);

  if (!user) return null;
  if (redirectHref) return null; // redirecting — never flash a hub they won't keep

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

      <main className="flex flex-1 flex-col items-center px-4 py-12 sm:px-6">
        <div className="flex w-full max-w-5xl flex-col gap-10">
          <div className="flex flex-col items-center gap-1.5 text-center">
            <p className="text-xs font-semibold uppercase tracking-widest text-brand-600">
              {t('hub.overline')}
            </p>
            <h1 className="font-display text-3xl font-bold text-text-primary sm:text-4xl">
              {t('hub.greeting', { name: firstName })}
            </h1>
            <p className="text-sm text-text-muted">
              {t('hub.roleAtOutlet', { role: t(`role.${user.roleKey}`), outlet: outletLabel })}
            </p>
            <p className="mt-2 text-base text-text-secondary">{t('hub.subtitle')}</p>
          </div>

          {interfaces.length === 0 ? (
            <EmptyState
              icon={LayoutGrid}
              title={t('hub.emptyTitle')}
              description={t('hub.emptyDescription')}
              size="lg"
            />
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {interfaces.map((iface) => (
                <WorkspaceCard
                  key={iface.id}
                  // Not `iface.href`: that is one fixed route, and reaching an
                  // interface is ANY-of the areas inside it, so a driver or a
                  // kepala gudang was being sent to a page they cannot open.
                  href={interfaceEntryHref(iface, can)}
                  icon={iface.icon}
                  title={t(iface.labelKey)}
                  // One sentence per interface, keyed by its `lib/nav.ts` id so
                  // a new interface only needs its copy added alongside its
                  // entry — `translate()` warns loudly on a missing key rather
                  // than failing silently.
                  description={t(`hub.surface.${iface.id}`)}
                />
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
