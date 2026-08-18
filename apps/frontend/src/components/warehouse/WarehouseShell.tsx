'use client';

import { useMemo } from 'react';
import {
  ClipboardCheck,
  Route,
  Boxes,
  PackageCheck,
  ListChecks,
  Trash2,
  Undo2,
  CalendarRange,
} from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { usePermissions } from '@/lib/permissions';
import { Tabs, TabsList, TabsTrigger, TabsContent, EmptyState } from '@/components/ui';
import { ApprovalQueuePanel } from './ApprovalQueuePanel';
import { OutboundPanel } from './OutboundPanel';
import { StockPanel } from './StockPanel';
import { ReceivingPanel } from './ReceivingPanel';
import { StockOpnamePanel } from './StockOpnamePanel';
import { WastePanel } from './WastePanel';
import { ReturnPanel } from './ReturnPanel';
import { RecapPanel } from './RecapPanel';

/**
 * F05 `warehouse` — the central warehouse's working screen (Balikpapan) for
 * Kepala Gudang and warehouse staff (BUILD-PLAN W4-08, upgraded under
 * F-WAREHOUSE). Brought up to `FinanceShell`'s tab-shell pattern (F07): tabs
 * are filtered by `can()` up front instead of always rendering every trigger
 * and gating only the content — a role with none of these permissions never
 * sees a dead tab, and sees one clear "no access" state instead of N of
 * them. Server-side `PermissionsGuard` + RLS is still the real boundary;
 * this is nav-level visibility only, same caveat `FinanceShell` documents.
 *
 * Coverage per the ticket brief: stock on hand + min-stock signalling
 * (`StockPanel`), the replenishment approve/amend/reject queue plus turning
 * an approved request into fulfilment (`ApprovalQueuePanel`), goods
 * receiving against POs (`ReceivingPanel`), stock opname counts
 * (`StockOpnamePanel`) and waste (`WastePanel`), retur to supplier/from
 * outlet (`ReturnPanel`), the daily recap (`RecapPanel`), and outbound
 * (`OutboundPanel` — a read-only rollup that POINTS to `/delivery` rather
 * than duplicating that surface's Surat Jalan create/manage lifecycle; see
 * that component's header for why).
 */
export function WarehouseShell() {
  const { t } = useI18n();
  const { can } = usePermissions();

  const tabs = useMemo(
    () => [
      {
        value: 'approvalQueue',
        labelKey: 'warehouse.tabs.approvalQueue',
        icon: ClipboardCheck,
        visible: can('replenishment.approve.warehouse'),
        content: <ApprovalQueuePanel />,
      },
      {
        value: 'stock',
        labelKey: 'warehouse.tabs.stock',
        icon: Boxes,
        visible: can('inventory.balance.read'),
        content: <StockPanel />,
      },
      {
        value: 'receiving',
        labelKey: 'warehouse.tabs.receiving',
        icon: PackageCheck,
        visible: can(['purchasing.po.receive', 'purchasing.read']),
        content: <ReceivingPanel />,
      },
      {
        value: 'opname',
        labelKey: 'warehouse.tabs.opname',
        icon: ListChecks,
        visible: can(['opname.read', 'opname.create']),
        content: <StockOpnamePanel />,
      },
      {
        value: 'waste',
        labelKey: 'warehouse.tabs.waste',
        icon: Trash2,
        visible: can(['waste.read', 'waste.create']),
        content: <WastePanel />,
      },
      {
        value: 'return',
        labelKey: 'warehouse.tabs.return',
        icon: Undo2,
        visible: can(['return.create', 'return.read']),
        content: <ReturnPanel />,
      },
      {
        value: 'suratJalan',
        labelKey: 'warehouse.tabs.suratJalan',
        icon: Route,
        visible: can(['delivery.sj.create', 'delivery.read']),
        content: <OutboundPanel />,
      },
      {
        value: 'recap',
        labelKey: 'warehouse.tabs.recap',
        icon: CalendarRange,
        visible: can('report.logistics.read'),
        content: <RecapPanel />,
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
      <TabsList className="flex-wrap">
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
