'use client';

import { useState } from 'react';
import { List, Radio } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { Button, PermissionGate } from '@/components/ui';
import { cn } from '@/lib/utils';
import { DeliverySuratJalanList } from './DeliverySuratJalanList';
import { LiveTrackingPanel } from './LiveTrackingPanel';

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
 * Two tabs since the tracking ticket: the Surat Jalan list (plan and dispatch)
 * and the live board (watch what is already out). They are split rather than
 * stacked because the live board POLLS — mounting it alongside the list would
 * have every dispatcher refetching the fleet every 30s while doing paperwork
 * that has nothing to do with it.
 */
type Tab = 'list' | 'live';

export function DeliveryShell() {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('list');

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* AppShell already owns the single OfflineBanner for this (non-chromeless) route. */}
      <div>
        <h1 className="font-display text-2xl font-semibold text-text-primary">
          {t('delivery.title')}
        </h1>
        <p className="text-sm text-text-muted">{t('delivery.subtitle')}</p>
      </div>

      <div className="flex flex-wrap gap-2 border-b border-border pb-2" role="tablist">
        <Button
          role="tab"
          aria-selected={tab === 'list'}
          variant={tab === 'list' ? 'secondary' : 'ghost'}
          size="sm"
          leftIcon={<List className="size-4" />}
          className={cn(tab === 'list' && 'font-semibold')}
          onClick={() => setTab('list')}
        >
          {t('delivery.title')}
        </Button>
        <Button
          role="tab"
          aria-selected={tab === 'live'}
          variant={tab === 'live' ? 'secondary' : 'ghost'}
          size="sm"
          leftIcon={<Radio className="size-4" />}
          className={cn(tab === 'live' && 'font-semibold')}
          onClick={() => setTab('live')}
        >
          {t('delivery.live.title')}
        </Button>
      </div>

      {tab === 'list' && <DeliverySuratJalanList />}
      {tab === 'live' && (
        <PermissionGate permission="delivery.read">
          <LiveTrackingPanel />
        </PermissionGate>
      )}
    </div>
  );
}
