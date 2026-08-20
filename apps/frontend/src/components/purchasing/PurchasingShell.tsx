'use client';

import { useMemo } from 'react';
import { ClipboardList, Truck, History, Building2 } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { usePermissions } from '@/lib/permissions';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs';
import { EmptyState } from '@/components/ui/EmptyState';
import { PurchaseRequestsPanel } from './PurchaseRequestsPanel';
import { PurchaseOrdersPanel } from './PurchaseOrdersPanel';
import { SupplierPriceHistoryPanel } from './SupplierPriceHistoryPanel';
import { SuppliersPanel } from './SuppliersPanel';

/**
 * F-PO `purchasing` (CONTRACTS §4.11: FR-PO-01..04, F-PUR-01..05; §4.6
 * FR-SUP-01..06). One page, three permission-gated tabs — mirrors
 * `FinanceShell`/`AdminShell`'s pattern (F07/F10): Purchase Requests -> POs
 * -> receiving all live on one desk, so tabs beat three separate route
 * loads. The Supplier Price History tab is gated on `supplier.price.read`
 * SEPARATELY from `purchasing.read` (D-20/Amendment 3) — an outlet role that
 * can see PR/PO status never sees this tab at all, and a direct navigation
 * or stale session still gets a real 403 handled inline by the panel, not a
 * silent empty table.
 *
 * This is nav-level visibility only; the server's `PermissionsGuard` + RLS
 * is the real boundary underneath every call each panel makes.
 */
export function PurchasingShell() {
  const { t } = useI18n();
  const { can } = usePermissions();

  const tabs = useMemo(
    () => [
      {
        value: 'requests',
        labelKey: 'purchasing.tabs.requests',
        icon: ClipboardList,
        visible: can('purchasing.read'),
        content: <PurchaseRequestsPanel />,
      },
      {
        value: 'orders',
        labelKey: 'purchasing.tabs.orders',
        icon: Truck,
        visible: can('purchasing.read'),
        content: <PurchaseOrdersPanel />,
      },
      {
        value: 'suppliers',
        labelKey: 'purchasing.tabs.suppliers',
        icon: Building2,
        visible: can('supplier.read'),
        content: <SuppliersPanel />,
      },
      {
        value: 'priceHistory',
        labelKey: 'purchasing.tabs.priceHistory',
        icon: History,
        visible: can('supplier.price.read'),
        content: <SupplierPriceHistoryPanel />,
      },
    ],
    [can],
  );

  const visibleTabs = tabs.filter((tab) => tab.visible);

  if (visibleTabs.length === 0) {
    return <EmptyState size="lg" title={t('permissionGate.noAccess')} />;
  }

  return (
    <Tabs defaultValue={visibleTabs[0]?.value}>
      <TabsList>
        {visibleTabs.map((tab) => (
          <TabsTrigger key={tab.value} value={tab.value}>
            <span className="inline-flex items-center gap-1.5">
              <tab.icon className="size-4" aria-hidden />
              {t(tab.labelKey)}
            </span>
          </TabsTrigger>
        ))}
      </TabsList>
      {visibleTabs.map((tab) => (
        <TabsContent key={tab.value} value={tab.value}>
          {tab.content}
        </TabsContent>
      ))}
    </Tabs>
  );
}
