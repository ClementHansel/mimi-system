'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarRange, List, Radio, Route as RouteIcon } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { usePermissions } from '@/lib/permissions';
import { EmptyState } from '@/components/ui/EmptyState';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs';
import { DeliverySuratJalanList } from './DeliverySuratJalanList';
import { LiveTrackingPanel } from './LiveTrackingPanel';
import { DispatchAssignScreen } from './DispatchAssignScreen';
// Imported ACROSS surfaces on purpose. `RecapPanel` reads the recap through
// `components/warehouse/lib/warehouse-api.ts` (`GET /reports/daily-recap`), so
// moving the file here would either drag that client along or duplicate it.
// Same precedent as `SjCreateForm`, which this folder already imports from
// `components/warehouse`.
import { RecapPanel } from '@/components/warehouse/RecapPanel';

/**
 * F-DELIVERY — the dispatcher's own top-level surface for M10 `delivery`
 * (CONTRACTS §4.10): before this ticket, the only screens against this
 * module were `components/warehouse/SuratJalanPanel.tsx` (one tab inside the
 * multi-purpose `/warehouse` shell) and `/driver` (the driver's own mobile
 * job list, F13). Neither is a dedicated central-dispatch view. This shell
 * is deliberately thin — the actual list/create/detail logic lives in
 * `DeliverySuratJalanList` + `CreateSuratJalanModal` +
 * `SuratJalanDetailDrawer` so the route itself stays a one-line composition
 * root, matching `app/purchasing/page.tsx`'s shell pattern.
 *
 * Four tabs — the whole of "what goes out today", in one place. The Surat Jalan
 * list (plan and dispatch) and the live board (watch what is already out) are
 * split rather than stacked because the live board POLLS — mounting it
 * alongside the list would have every dispatcher refetching the fleet every 30s
 * while doing paperwork that has nothing to do with it. "Penugasan" (assign
 * driver/truck, order the drops) and "Rekap Harian" (the day's SJ/drop totals)
 * joined them on the owner's 2026-08-27 ruling that the three "need to be
 * combined like dashboard": they were three sidebar entries describing one job,
 * so answering "is today covered?" meant opening all three and comparing by
 * eye.
 *
 * EACH TAB KEEPS ITS OWN URL (`/delivery`, `/delivery/assign`,
 * `/delivery/rekap`) and switching tabs rewrites it (`router.replace`, so tab
 * flipping does not fill the back stack). That is what stops "combined" from
 * meaning "no longer linkable": the recap is exactly the screen someone pastes
 * into a chat message, and it stayed a real address.
 *
 * "Penugasan" (assign driver/truck + reorder drops) used to be its own sidebar
 * item and route, `/delivery/assign`. Owner, 2026-08-27: "this should be
 * displayed as a tab inside pengiriman (dispatcher)" — folded in here as a
 * third, independently permission-gated tab, same shape as
 * `components/admin/AdminShell.tsx` (visible tabs computed from `can()`,
 * `EmptyState` if none apply — though for this shell that only happens if
 * `delivery.read` itself was somehow lost after the page already rendered,
 * since reaching `/delivery` at all already required it).
 * `/delivery/assign` keeps resolving (`app/delivery/assign/page.tsx` mounts
 * this same shell with `initialTab="assign"`) for deep links.
 */
type Tab = 'list' | 'live' | 'assign' | 'rekap';

/** The tab -> address map, and the reason a tab switch is also a navigation. */
const TAB_PATHS: Record<Tab, string> = {
  list: '/delivery',
  live: '/delivery',
  assign: '/delivery/assign',
  rekap: '/delivery/rekap',
};

export function DeliveryShell({ initialTab = 'list' }: { initialTab?: Tab }) {
  const { t } = useI18n();
  const { can } = usePermissions();
  const router = useRouter();

  const tabs = useMemo(
    () => [
      {
        value: 'list' as const,
        labelKey: 'delivery.title',
        icon: List,
        // Reaching `/delivery` at all already required `delivery.read` (nav
        // gating), so the list tab has no further gate of its own.
        visible: true,
        content: <DeliverySuratJalanList />,
      },
      {
        value: 'live' as const,
        labelKey: 'delivery.live.title',
        icon: Radio,
        visible: can('delivery.read'),
        content: <LiveTrackingPanel />,
      },
      {
        value: 'assign' as const,
        labelKey: 'deliveryAssign.title',
        icon: RouteIcon,
        // Reassigning a driver/truck or reordering a route is an edit, not a
        // read — gated the same key the old standalone route used
        // (`delivery.sj.create`), not `delivery.read`.
        visible: can('delivery.sj.create'),
        content: <DispatchAssignScreen />,
      },
      {
        value: 'rekap' as const,
        labelKey: 'warehouse.tabs.recap',
        icon: CalendarRange,
        // Was `/warehouse/rekap`, one of Gudang Pusat's sidebar panels, gated
        // on this same key — folded in here so the day's totals sit beside the
        // Surat Jalan they are totals OF, instead of being a separate screen
        // to cross-check by hand.
        visible: can('report.logistics.read'),
        content: <RecapPanel />,
      },
    ],
    [can],
  );

  const visibleTabs = tabs.filter((tabDef) => tabDef.visible);
  const [tab, setTab] = useState<Tab>(
    visibleTabs.some((tabDef) => tabDef.value === initialTab)
      ? initialTab
      : (visibleTabs[0]?.value ?? 'list'),
  );

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* AppShell already owns the single OfflineBanner for this (non-chromeless) route. */}
      <div>
        <h1 className="font-display text-2xl font-semibold text-text-primary">
          {t('delivery.title')}
        </h1>
        <p className="text-sm text-text-muted">{t('delivery.subtitle')}</p>
      </div>

      {visibleTabs.length === 0 ? (
        <EmptyState size="lg" title={t('permissionGate.noAccess')} />
      ) : (
        <Tabs
          value={tab}
          onValueChange={(v) => {
            const next = v as Tab;
            setTab(next);
            // Keep the address bar honest. `replace`, not `push`: flipping
            // between four tabs should not mean four presses of Back to leave
            // the screen. `live` shares `/delivery` with `list` — it is the same
            // planning surface, and giving the polling board its own URL would
            // invite someone to leave it open as a wall display, which is a
            // different feature.
            const href = TAB_PATHS[next];
            if (href !== TAB_PATHS[tab]) router.replace(href);
          }}
        >
          <TabsList>
            {visibleTabs.map((tabDef) => (
              <TabsTrigger key={tabDef.value} value={tabDef.value}>
                <span className="inline-flex items-center gap-1.5">
                  <tabDef.icon className="size-4" aria-hidden />
                  {t(tabDef.labelKey)}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>
          {visibleTabs.map((tabDef) => (
            <TabsContent key={tabDef.value} value={tabDef.value}>
              {tabDef.content}
            </TabsContent>
          ))}
        </Tabs>
      )}
    </div>
  );
}
