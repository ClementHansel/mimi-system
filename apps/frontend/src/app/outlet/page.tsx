'use client';

import { ClipboardList, Truck, Boxes, ListChecks, Trash2, Wallet } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { Tabs, TabsList, TabsTrigger, TabsContent, OfflineBanner, PermissionGate } from '@/components/ui';
import { ReplenishmentPanel } from '@/components/outlet/ReplenishmentPanel';
import { ReceivingPanel } from '@/components/outlet/ReceivingPanel';
import { StockPanel } from '@/components/outlet/StockPanel';
import { OpnamePanel } from '@/components/outlet/OpnamePanel';
import { WastePanel } from '@/components/outlet/WastePanel';
import { PettyCashPanel } from '@/components/outlet/PettyCashPanel';

/**
 * F04 `outlet` — the daily working screen for Leader/Staff Outlet and
 * Supervisor Cabang (BUILD-PLAN W4-07). One tabbed shell over the six flows
 * the ticket asks for; each tab is its own panel component, gated by the
 * CONTRACTS §3 permission that flow actually requires so a role only sees
 * what it can act on (server-side RBAC is still the real boundary —
 * `PermissionGate` only hides the UI).
 */
export default function OutletPage() {
  const { t } = useI18n();

  return (
    <div className="flex flex-col gap-4 p-4">
      <OfflineBanner />
      <h1 className="font-display text-2xl font-semibold text-text-primary">{t('nav.outlet')}</h1>

      <Tabs defaultValue="replenishment">
        <TabsList className="flex-wrap">
          <TabsTrigger value="replenishment">
            <span className="inline-flex items-center gap-1.5"><ClipboardList className="size-4" aria-hidden />{t('outlet.tabs.replenishment')}</span>
          </TabsTrigger>
          <TabsTrigger value="receiving">
            <span className="inline-flex items-center gap-1.5"><Truck className="size-4" aria-hidden />{t('outlet.tabs.receiving')}</span>
          </TabsTrigger>
          <TabsTrigger value="stock">
            <span className="inline-flex items-center gap-1.5"><Boxes className="size-4" aria-hidden />{t('outlet.tabs.stock')}</span>
          </TabsTrigger>
          <TabsTrigger value="opname">
            <span className="inline-flex items-center gap-1.5"><ListChecks className="size-4" aria-hidden />{t('outlet.tabs.opname')}</span>
          </TabsTrigger>
          <TabsTrigger value="waste">
            <span className="inline-flex items-center gap-1.5"><Trash2 className="size-4" aria-hidden />{t('outlet.tabs.waste')}</span>
          </TabsTrigger>
          <TabsTrigger value="pettyCash">
            <span className="inline-flex items-center gap-1.5"><Wallet className="size-4" aria-hidden />{t('outlet.tabs.pettyCash')}</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="replenishment">
          <PermissionGate permission={['replenishment.read', 'replenishment.create']} showMessage>
            <ReplenishmentPanel />
          </PermissionGate>
        </TabsContent>
        <TabsContent value="receiving">
          <PermissionGate permission={['delivery.receive', 'delivery.read']} showMessage>
            <ReceivingPanel />
          </PermissionGate>
        </TabsContent>
        <TabsContent value="stock">
          <PermissionGate permission="inventory.balance.read" showMessage>
            <StockPanel />
          </PermissionGate>
        </TabsContent>
        <TabsContent value="opname">
          <PermissionGate permission={['opname.read', 'opname.create']} showMessage>
            <OpnamePanel />
          </PermissionGate>
        </TabsContent>
        <TabsContent value="waste">
          <PermissionGate permission={['waste.read', 'return.read']} showMessage>
            <WastePanel />
          </PermissionGate>
        </TabsContent>
        <TabsContent value="pettyCash">
          <PermissionGate permission="pettycash.read" showMessage>
            <PettyCashPanel />
          </PermissionGate>
        </TabsContent>
      </Tabs>
    </div>
  );
}
