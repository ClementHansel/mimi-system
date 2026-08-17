'use client';

import { useI18n } from '@/lib/i18n';
import { OfflineBanner } from '@/components/ui';
import { WarehouseShell } from '@/components/warehouse/WarehouseShell';

/**
 * F05 `warehouse` — the central warehouse's working screen (Balikpapan) for
 * Kepala Gudang and warehouse staff (BUILD-PLAN W4-08). The tab shell itself
 * (permission-filtered tabs, FinanceShell-style) lives in `WarehouseShell` —
 * kept out of this file so the shell can be reasoned about/tested on its
 * own, same split `FinanceShell`/`app/finance/page.tsx` uses. Kepala Gudang
 * is not a central role — `Me.locations`/`Me.permissions` are already scoped
 * server-side to the warehouse plus the outlets it ships to, so no
 * client-side location filtering happens beyond picking the warehouse entry
 * (`useWarehouseLocation`, used inside the individual panels).
 */
export default function WarehousePage() {
  const { t } = useI18n();

  return (
    <div className="flex flex-col gap-4 p-4">
      <OfflineBanner />
      <h1 className="font-display text-2xl font-semibold text-text-primary">{t('nav.warehouse')}</h1>
      <WarehouseShell />
    </div>
  );
}
