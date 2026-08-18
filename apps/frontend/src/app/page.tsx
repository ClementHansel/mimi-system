'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { BookOpen, LayoutGrid } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { useSessionStore } from '@/stores/session-store';
import { usePermissions } from '@/lib/permissions';
import { NAV_SECTIONS } from '@/lib/nav';
import { EmptyState } from '@/components/ui/EmptyState';
import { HubTopBar } from '@/components/hub/HubTopBar';
import { WorkspaceCard } from '@/components/hub/WorkspaceCard';
import { getLandingRoute } from './(auth)/landing';

/**
 * The home hub — an INTERFACE DIRECTORY for the all-access roles, and nothing
 * at all for everyone else.
 *
 * Owner's ruling (2026-08-18): "owner and superadmin should see every
 * interface; all other accounts are redirected to their own interface." That
 * replaces the previous three-card workspace chooser (Dasbor / Kasir /
 * Dokumentasi), which showed abstract groupings rather than the actual
 * surfaces and, for a Kepala Gudang with several permitted areas, amounted to
 * a second navigation menu.
 *
 * So there are now exactly two behaviours:
 *
 *  - OWNER / SUPERADMIN land here and get one card per unique interface,
 *    grouped under the same sections as the sidebar so the two never disagree.
 *  - Everyone else never sees this page: they are redirected to their role's
 *    landing route (`(auth)/landing.ts`) — a Kasir into POS, a Driver into
 *    their job list, a Kepala Gudang into the warehouse.
 *
 * The card list is DERIVED from `lib/nav.ts` + `usePermissions().can()`, never
 * hand-listed. That is what keeps this page correct as surfaces are added, and
 * it is why granting owner the five permissions it was missing
 * (`replenishment.create`/`opname.create`/`waste.create`/`pettycash.create`/
 * `delivery.drop.execute`, migration 222) is what actually made `/outlet` and
 * `/driver` appear here — rather than this file naming them.
 */

/** Roles that get the hub. Everyone else is redirected past it. */
const HUB_ROLES = new Set(['owner', 'superadmin']);

/** `/docs` is a real interface but deliberately not in `lib/nav.ts` (it is not
 * an RBAC-gated app surface — reading the manual is not privileged), so it is
 * appended here rather than being invented as a nav entry with a fake
 * permission. */
const DOCS_HREF = '/docs';

export default function HomePage() {
  const { t } = useI18n();
  const router = useRouter();
  const user = useSessionStore((s) => s.user);
  const { can } = usePermissions();

  const isHubRole = !!user && HUB_ROLES.has(user.roleKey);
  // Computed before the effect so the redirect target is stable across renders
  // and the effect does not re-fire on every parent update.
  const redirectHref = user && !isHubRole ? getLandingRoute(user) : null;

  useEffect(() => {
    if (redirectHref) router.replace(redirectHref);
  }, [redirectHref, router]);

  if (!user) return null;
  if (redirectHref) return null; // redirecting — never flash a hub they won't keep

  // Only sections with at least one permitted interface are rendered, so a
  // future role that reaches the hub without holding everything still gets a
  // clean page rather than a run of empty headings.
  const sections = NAV_SECTIONS.map((section) => ({
    id: section.id,
    label: t(section.labelKey),
    items: section.items.filter((item) => can(item.permission)),
  })).filter((section) => section.items.length > 0);

  const totalInterfaces = sections.reduce((n, s) => n + s.items.length, 0);

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
        <div className="flex w-full max-w-6xl flex-col gap-10">
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
            <p className="mt-2 text-base text-text-secondary">
              {t('hub.subtitleAll', { count: totalInterfaces })}
            </p>
          </div>

          {totalInterfaces === 0 && (
            <EmptyState
              icon={LayoutGrid}
              title={t('hub.emptyTitle')}
              description={t('hub.emptyDescription')}
              size="lg"
            />
          )}

          {sections.map((section) => (
            <section key={section.id} className="flex flex-col gap-4">
              <h2 className="text-xs font-semibold uppercase tracking-widest text-text-muted">
                {section.label}
              </h2>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {section.items.map((item) => (
                  <WorkspaceCard
                    key={item.id}
                    href={item.href}
                    icon={item.icon}
                    title={t(item.labelKey)}
                    // One sentence per surface, keyed by the nav item's own id
                    // so a new surface only needs its copy added alongside its
                    // nav entry — `translate()` warns loudly on a missing key
                    // rather than failing silently.
                    description={t(`hub.surface.${item.id}`)}
                  />
                ))}
              </div>
            </section>
          ))}

          <section className="flex flex-col gap-4">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-text-muted">
              {t('hub.section.referensi')}
            </h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <WorkspaceCard
                href={DOCS_HREF}
                icon={BookOpen}
                title={t('hub.workspace.dokumentasi.title')}
                description={t('hub.workspace.dokumentasi.description')}
              />
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
