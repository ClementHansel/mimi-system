'use client';

import { Boxes, CalendarClock, Wrench } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { Tabs, TabsList, TabsTrigger, TabsContent, PermissionGate } from '@/components/ui';
import { AssetRegisterPanel } from '@/components/assets/AssetRegisterPanel';
import { MaintenanceDuePanel } from '@/components/assets/MaintenanceDuePanel';
import { MaintenanceJobsPanel } from '@/components/assets/MaintenanceJobsPanel';

/**
 * F09 `assets` (BUILD-PLAN W4-09) — asset register, maintenance schedules,
 * due reminders, completing a maintenance job with proof photos and
 * condition notes (FR-PMS-01..04). One tabbed shell over the three flows,
 * each gated by the CONTRACTS §3 permission it actually needs.
 */
export default function AssetsPage() {
  const { t } = useI18n();

  return (
    <div className="flex flex-col gap-4 p-4">
      <h1 className="font-display text-2xl font-semibold text-text-primary">{t('nav.assets')}</h1>

      <Tabs defaultValue="register">
        <TabsList className="flex-wrap">
          <TabsTrigger value="register">
            <span className="inline-flex items-center gap-1.5">
              <Boxes className="size-4" aria-hidden />
              {t('assets.tabs.register')}
            </span>
          </TabsTrigger>
          <TabsTrigger value="due">
            <span className="inline-flex items-center gap-1.5">
              <CalendarClock className="size-4" aria-hidden />
              {t('assets.tabs.due')}
            </span>
          </TabsTrigger>
          <TabsTrigger value="jobs">
            <span className="inline-flex items-center gap-1.5">
              <Wrench className="size-4" aria-hidden />
              {t('assets.tabs.jobs')}
            </span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="register">
          <PermissionGate permission="asset.read" showMessage>
            <AssetRegisterPanel />
          </PermissionGate>
        </TabsContent>
        <TabsContent value="due">
          <PermissionGate permission="asset.read" showMessage>
            <MaintenanceDuePanel />
          </PermissionGate>
        </TabsContent>
        <TabsContent value="jobs">
          <PermissionGate permission="asset.read" showMessage>
            <MaintenanceJobsPanel />
          </PermissionGate>
        </TabsContent>
      </Tabs>
    </div>
  );
}
