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
import { ApiError } from '@/lib/api';
import { ScopeBanner } from './ScopeBanner';
import { OverviewCards } from './OverviewCards';
import { TrendPanel } from './TrendPanel';
import { OpsStatusPanel } from './OpsStatusPanel';
import { InventoryPanel } from './InventoryPanel';
import { OutletsPanel } from './OutletsPanel';
import { TopProductsPanel } from './TopProductsPanel';
import { StaffKpiPanel } from './StaffKpiPanel';
import { OutletDrilldownContent } from './OutletDrilldownContent';
import { dashboardApi } from './lib/dashboard-api';
import { useOverview } from './lib/use-overview';

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
        <OutletDrilldownContent locationId={myLocation.id} />
      </div>
    );
  }

  return <EmptyState size="lg" title={t('permissionGate.noAccess')} />;
}

function CompanyDashboard({
  range,
  onRangeChange,
}: {
  range: DateRangeValue;
  onRangeChange: (v: DateRangeValue) => void;
}) {
  const { t } = useI18n();
  const [refreshing, setRefreshing] = useState(false);
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
      toast({ title: err instanceof ApiError ? err.message : t('table.error'), variant: 'danger' });
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
