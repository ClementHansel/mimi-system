'use client';

import { ClipboardCheck, Truck, Boxes, PackageCheck, Undo2, CalendarRange } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { Tabs, TabsList, TabsTrigger, TabsContent, OfflineBanner, PermissionGate } from '@/components/ui';
import { ApprovalQueuePanel } from '@/components/warehouse/ApprovalQueuePanel';
import { SuratJalanPanel } from '@/components/warehouse/SuratJalanPanel';
import { StockPanel } from '@/components/warehouse/StockPanel';
import { ReceivingPanel } from '@/components/warehouse/ReceivingPanel';
import { ReturnPanel } from '@/components/warehouse/ReturnPanel';
import { RecapPanel } from '@/components/warehouse/RecapPanel';

/**
 * F05 `warehouse` — the central warehouse's working screen (Balikpapan) for
 * Kepala Gudang and warehouse staff (BUILD-PLAN W4-08). Same tabbed-shell
 * pattern as F04 `outlet` (W4-07): each tab is its own panel component,
 * gated by the CONTRACTS §3 permission that flow actually requires. Kepala
 * Gudang is not a central role — `Me.locations`/`Me.permissions` are already
 * scoped server-side to the warehouse plus the outlets it ships to, so no
 * client-side location filtering happens beyond picking the warehouse entry
 * (`useWarehouseLocation`).
 */
export default function WarehousePage() {
  const { t } = useI18n();

  return (
    <div className="flex flex-col gap-4 p-4">
      <OfflineBanner />
      <h1 className="font-display text-2xl font-semibold text-text-primary">{t('nav.warehouse')}</h1>

      <Tabs defaultValue="approvalQueue">
        <TabsList className="flex-wrap">
          <TabsTrigger value="approvalQueue">
            <span className="inline-flex items-center gap-1.5"><ClipboardCheck className="size-4" aria-hidden />{t('warehouse.tabs.approvalQueue')}</span>
          </TabsTrigger>
          <TabsTrigger value="suratJalan">
            <span className="inline-flex items-center gap-1.5"><Truck className="size-4" aria-hidden />{t('warehouse.tabs.suratJalan')}</span>
          </TabsTrigger>
          <TabsTrigger value="stock">
            <span className="inline-flex items-center gap-1.5"><Boxes className="size-4" aria-hidden />{t('warehouse.tabs.stock')}</span>
          </TabsTrigger>
          <TabsTrigger value="receiving">
            <span className="inline-flex items-center gap-1.5"><PackageCheck className="size-4" aria-hidden />{t('warehouse.tabs.receiving')}</span>
          </TabsTrigger>
          <TabsTrigger value="return">
            <span className="inline-flex items-center gap-1.5"><Undo2 className="size-4" aria-hidden />{t('warehouse.tabs.return')}</span>
          </TabsTrigger>
          <TabsTrigger value="recap">
            <span className="inline-flex items-center gap-1.5"><CalendarRange className="size-4" aria-hidden />{t('warehouse.tabs.recap')}</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="approvalQueue">
          <PermissionGate permission="replenishment.approve.warehouse" showMessage>
            <ApprovalQueuePanel />
          </PermissionGate>
        </TabsContent>
        <TabsContent value="suratJalan">
          <PermissionGate permission={['delivery.sj.create', 'delivery.read']} showMessage>
            <SuratJalanPanel />
          </PermissionGate>
        </TabsContent>
        <TabsContent value="stock">
          <PermissionGate permission="inventory.balance.read" showMessage>
            <StockPanel />
          </PermissionGate>
        </TabsContent>
        <TabsContent value="receiving">
          <PermissionGate permission={['purchasing.po.receive', 'purchasing.read']} showMessage>
            <ReceivingPanel />
          </PermissionGate>
        </TabsContent>
        <TabsContent value="return">
          <PermissionGate permission={['return.create', 'return.read']} showMessage>
            <ReturnPanel />
          </PermissionGate>
        </TabsContent>
        <TabsContent value="recap">
          <PermissionGate permission="report.logistics.read" showMessage>
            <RecapPanel />
          </PermissionGate>
        </TabsContent>
      </Tabs>
    </div>
  );
}
