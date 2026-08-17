'use client';

import { useI18n } from '@/lib/i18n';
import { DeliverySuratJalanList } from './DeliverySuratJalanList';

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
 */
export function DeliveryShell() {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-4 p-4">
      {/* AppShell already owns the single OfflineBanner for this (non-chromeless) route. */}
      <div>
        <h1 className="font-display text-2xl font-semibold text-text-primary">{t('delivery.title')}</h1>
        <p className="text-sm text-text-muted">{t('delivery.subtitle')}</p>
      </div>
      <DeliverySuratJalanList />
    </div>
  );
}
