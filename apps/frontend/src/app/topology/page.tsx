'use client';

import { Waypoints } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { Tabs, TabsList, TabsTrigger, TabsContent, PermissionGate } from '@/components/ui';
import { TopologyTreePanel } from '@/components/topology/TopologyTreePanel';
import { SyncHealthPanel } from '@/components/topology/SyncHealthPanel';

/**
 * F12 `topology` (BUILD-PLAN W5-03, CONTRACTS §4.21-§4.23/§7) — the device
 * and connectivity monitor: the live Pusat -> Kota -> Outlet -> Node ->
 * Device tree with rolled-up status, plus per-outlet sync health and the
 * conflict/exception queues that need a human. Replaces the Wave-1
 * `RoutePlaceholder`.
 */
export default function TopologyPage() {
  const { t } = useI18n();

  return (
    <div className="flex flex-col gap-4 p-4">
      <h1 className="inline-flex items-center gap-2 font-display text-2xl font-semibold text-text-primary">
        <Waypoints className="size-6" aria-hidden />
        {t('topology.title')}
      </h1>

      <PermissionGate permission="topology.read" showMessage>
        <Tabs defaultValue="tree">
          <TabsList>
            <TabsTrigger value="tree">{t('topology.tabs.tree')}</TabsTrigger>
            <TabsTrigger value="sync">{t('topology.tabs.sync')}</TabsTrigger>
          </TabsList>

          <TabsContent value="tree">
            <TopologyTreePanel />
          </TabsContent>
          <TabsContent value="sync">
            <PermissionGate permission="sync.status.read" showMessage>
              <SyncHealthPanel />
            </PermissionGate>
          </TabsContent>
        </Tabs>
      </PermissionGate>
    </div>
  );
}
