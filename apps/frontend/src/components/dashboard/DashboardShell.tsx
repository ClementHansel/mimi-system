'use client';

import { useState } from 'react';
import { RefreshCcw } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { usePermissions } from '@/lib/permissions';
import { useSessionStore } from '@/stores/session-store';
import { toDateInput } from '@/lib/dates';
import { Button } from '@/components/ui/Button';
import { DateRangePicker, type DateRangeValue } from '@/components/ui/DateRangePicker';
import { EmptyState } from '@/components/ui/EmptyState';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs';
import { toast } from '@/components/ui/Toast';
import { ScopeBanner } from './ScopeBanner';
import { OverviewCards } from './OverviewCards';
import { TrendPanel } from './TrendPanel';
import { OpsStatusPanel } from './OpsStatusPanel';
import { InventoryPanel } from './InventoryPanel';
import { OutletsPanel } from './OutletsPanel';
import { TopProductsPanel } from './TopProductsPanel';
import { StaffKpiPanel } from './StaffKpiPanel';
import { OutletDrilldownContent } from './OutletDrilldownContent';
import { SalesReportPanel } from './SalesReportPanel';
import { MarketingReportPanel } from './MarketingReportPanel';
import { dashboardApi } from './lib/dashboard-api';
import { useOverview } from './lib/use-overview';
import { errMsg } from '@/lib/api-error';

function addDays(base: Date, days: number): string {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return toDateInput(d);
}

/**
 * F03 `dashboard` — the Owner/Manager landing page (CONTRACTS §4.18,
 * FR-DASH-01..04). Gating splits on the two dashboard permission keys
 * (§3 RBAC matrix), not on a role name — that matrix is the one source of
 * truth for who gets which view:
 *
 *  - `dashboard.view` (Owner, Manager — always central roles per
 *    `scope.service.ts`, `locationScope === null`): full company-wide
 *    dashboard — overview, all outlets, trend, top products, staff KPI, ops
 *    status, manual refresh.
 *  - `dashboard.outlet.view` WITHOUT `dashboard.view` (Supervisor — the only
 *    role holding one but not the other): every other dashboard endpoint
 *    403s for them server-side, so their entire "dashboard" IS the
 *    single-outlet drill-down for their own assigned location. There is no
 *    aggregate fallback to build here — showing one would either 403 or
 *    (worse) silently be scoped data mislabeled as company-wide.
 *
 * `ScopeBanner` is mounted unconditionally at the top of both branches so
 * the figures' scope is never ambiguous (the ticket's core requirement).
 *
 * BOTH branches carry the Penjualan (sales) and Pemasaran (marketing) report
 * tabs, and they are the same two components either way — the difference is
 * one prop. A central role gets them with no `lockedLocationId`, so the panels
 * render their own "Semua Outlet / <outlet>" filter; a Supervisor gets them
 * pinned to their own location with no picker at all. Those tabs read §4.19
 * `report` routes, not §4.18 `dashboard` ones, so they are gated on
 * `report.sales.read` independently of the two dashboard keys above — see
 * `CompanyDashboard`/`OutletDashboard`.
 */
export function DashboardShell() {
  const { t } = useI18n();
  const { can } = usePermissions();
  const user = useSessionStore((s) => s.user);

  const canCompanyView = can('dashboard.view');
  const canOutletView = can('dashboard.outlet.view');

  const today = new Date();
  const [range, setRange] = useState<DateRangeValue>({
    from: addDays(today, -6),
    to: addDays(today, 0),
  });

  if (canCompanyView) {
    return <CompanyDashboard range={range} onRangeChange={setRange} />;
  }

  if (canOutletView) {
    const myLocation = user?.locations[0] ?? null;
    if (!myLocation) {
      return <EmptyState size="lg" title={t('dashboard.noOutletAssigned')} />;
    }
    return (
      <div className="flex flex-col gap-4">
        <ScopeBanner scope="outlet" outletName={myLocation.name} outletCity={myLocation.city} />
        <OutletDashboard location={myLocation} range={range} onRangeChange={setRange} />
      </div>
    );
  }

  return <EmptyState size="lg" title={t('permissionGate.noAccess')} />;
}

/**
 * A Supervisor's whole dashboard — one outlet, and only that outlet.
 *
 * This used to be a bare `OutletDrilldownContent`. It is tabbed now because
 * the same person who runs the outlet is the one asked "how did we do this
 * week", and the drill-down answers only "how are we doing right now": it is
 * a single-DAY tile plus an hourly curve, with no date range and no way to
 * get the numbers off the screen.
 *
 * Every tab here is pinned to `location.id` via `lockedLocationId`, so the
 * panels render no outlet picker at all. That pin is a UI convenience, NOT
 * the security boundary — `SalesReportService.assertLocationInScope` rejects
 * a locationId outside the caller's `user_locations` regardless of what this
 * component sends, and omitting the param would return exactly this one
 * outlet anyway. `ScopeBanner scope="outlet"` stays mounted above all of it
 * (see `DashboardShell`'s own note) so a figure here is never mistaken for a
 * company-wide one.
 */
function OutletDashboard({
  location,
  range,
  onRangeChange,
}: {
  location: { id: string; name: string; city: string };
  range: DateRangeValue;
  onRangeChange: (v: DateRangeValue) => void;
}) {
  const { t } = useI18n();
  const { can } = usePermissions();
  const from = range.from ?? addDays(new Date(), -6);
  const to = range.to ?? addDays(new Date(), 0);
  // A Supervisor holds `report.sales.read` (CONTRACTS §3) — but gate on the
  // key, not on the role, so this stays correct if the matrix moves.
  const canSalesReport = can('report.sales.read');

  if (!canSalesReport) {
    return <OutletDrilldownContent locationId={location.id} />;
  }

  return (
    <Tabs defaultValue="overview">
      <TabsList>
        <TabsTrigger value="overview">{t('dashboard.tabs.overview')}</TabsTrigger>
        <TabsTrigger value="sales">{t('dashboard.tabs.sales')}</TabsTrigger>
        <TabsTrigger value="marketing">{t('dashboard.tabs.marketing')}</TabsTrigger>
      </TabsList>

      <TabsContent value="overview">
        <OutletDrilldownContent locationId={location.id} />
      </TabsContent>

      <TabsContent value="sales">
        <div className="flex flex-col gap-4">
          <DateRangePicker label={t('dateRange.label')} value={range} onChange={onRangeChange} />
          <SalesReportPanel
            from={from}
            to={to}
            lockedLocationId={location.id}
            lockedLocationName={location.name}
          />
        </div>
      </TabsContent>

      <TabsContent value="marketing">
        <div className="flex flex-col gap-4">
          <DateRangePicker label={t('dateRange.label')} value={range} onChange={onRangeChange} />
          <MarketingReportPanel
            from={from}
            to={to}
            lockedLocationId={location.id}
            lockedLocationName={location.name}
          />
        </div>
      </TabsContent>
    </Tabs>
  );
}

function CompanyDashboard({
  range,
  onRangeChange,
}: {
  range: DateRangeValue;
  onRangeChange: (v: DateRangeValue) => void;
}) {
  const { t } = useI18n();
  const { can } = usePermissions();
  const [refreshing, setRefreshing] = useState(false);
  // The Sales/Marketing tabs are §4.19 `report` reads, NOT §4.18 `dashboard`
  // ones — a different permission key, so they are gated on their own rather
  // than riding along on `dashboard.view`. Both central roles that reach this
  // branch hold it today; the check is what keeps that a fact about the RBAC
  // matrix instead of an assumption baked into the layout.
  const canSalesReport = can('report.sales.read');
  const from = range.from ?? addDays(new Date(), -6);
  const to = range.to ?? addDays(new Date(), 0);
  const { data: overview, loading: overviewLoading, reload } = useOverview(from, to);

  async function handleRefresh() {
    setRefreshing(true);
    try {
      const results = await dashboardApi.refresh();
      const failed = results.filter((r) => !r.ok);
      if (failed.length > 0) {
        toast({
          title: t('dashboard.refreshPartialFailure', { count: failed.length }),
          variant: 'danger',
        });
      } else {
        toast({ title: t('dashboard.refreshSuccess'), variant: 'success' });
      }
      reload();
    } catch (err) {
      toast({ title: errMsg(err, t('table.error')), variant: 'danger' });
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <ScopeBanner scope="company" className="flex-1" />
        <Button
          variant="outline"
          size="sm"
          leftIcon={<RefreshCcw className="size-4" />}
          loading={refreshing}
          onClick={handleRefresh}
        >
          {t('dashboard.refreshButton')}
        </Button>
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">{t('dashboard.tabs.overview')}</TabsTrigger>
          {canSalesReport && <TabsTrigger value="sales">{t('dashboard.tabs.sales')}</TabsTrigger>}
          {canSalesReport && (
            <TabsTrigger value="marketing">{t('dashboard.tabs.marketing')}</TabsTrigger>
          )}
          <TabsTrigger value="outlets">{t('dashboard.tabs.outlets')}</TabsTrigger>
          <TabsTrigger value="topProducts">{t('dashboard.tabs.topProducts')}</TabsTrigger>
          <TabsTrigger value="staffKpi">{t('dashboard.tabs.staffKpi')}</TabsTrigger>
          {/* Gudang has a stock screen and every outlet has one; the office had
              none, so the roles whose job is COMPARING branches could only ever
              see a single location at a time. owner, superadmin and supervisor
              all hold inventory.* permissions with nowhere here to spend them. */}
          <TabsTrigger value="inventory">{t('dashboard.tabs.inventory')}</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <div className="flex flex-col gap-4">
            <DateRangePicker label={t('dateRange.label')} value={range} onChange={onRangeChange} />
            <OverviewCards data={overview} loading={overviewLoading} />
            <TrendPanel from={from} to={to} />
            <div>
              <h3 className="mb-2 font-display text-lg font-semibold text-text-primary">
                {t('dashboard.tabs.opsStatus')}
              </h3>
              <OpsStatusPanel />
            </div>
          </div>
        </TabsContent>

        {canSalesReport && (
          <TabsContent value="sales">
            <div className="flex flex-col gap-4">
              <DateRangePicker
                label={t('dateRange.label')}
                value={range}
                onChange={onRangeChange}
              />
              {/* No `lockedLocationId`: a central role's scope is every outlet,
                  so the panel shows its own "Semua Outlet / <outlet>" filter and
                  omitting the param means "everything I am entitled to". */}
              <SalesReportPanel from={from} to={to} />
            </div>
          </TabsContent>
        )}

        {canSalesReport && (
          <TabsContent value="marketing">
            <div className="flex flex-col gap-4">
              <DateRangePicker
                label={t('dateRange.label')}
                value={range}
                onChange={onRangeChange}
              />
              <MarketingReportPanel from={from} to={to} />
            </div>
          </TabsContent>
        )}

        <TabsContent value="outlets">
          <OutletsPanel />
        </TabsContent>

        <TabsContent value="inventory">
          <InventoryPanel />
        </TabsContent>

        <TabsContent value="topProducts">
          <div className="flex flex-col gap-4">
            <DateRangePicker label={t('dateRange.label')} value={range} onChange={onRangeChange} />
            <TopProductsPanel from={from} to={to} />
          </div>
        </TabsContent>

        <TabsContent value="staffKpi">
          <div className="flex flex-col gap-4">
            <DateRangePicker label={t('dateRange.label')} value={range} onChange={onRangeChange} />
            <StaffKpiPanel from={from} to={to} />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
