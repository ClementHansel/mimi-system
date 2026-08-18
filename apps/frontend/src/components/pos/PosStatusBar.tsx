'use client';

import { Store } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/Button';
import { SyncStatusPill } from '@/components/ui/SyncStatusPill';
import { useConnectivityStore } from '@/stores/connectivity-store';

/**
 * The always-visible legibility strip for this surface (brief: "Offline
 * state must be legible at all times — queue depth, last sync, and what is
 * currently unavailable. A cashier needs to know whether their sales are
 * safe, not discover a problem at end of shift.").
 *
 * `OfflineBanner` (mounted once by `AppShell`, above every route) already
 * covers the LAN/isolated tier explanation + queue count + last-sync time;
 * this bar adds the two things specific to POS: the outlet name (so a
 * multi-tablet outlet always knows which device it's looking at) and, when
 * not fully online, an explicit "sales visible on other tablets only after
 * reconnect" caveat (SYNC-PROTOCOL §8 row 1) so a cashier never assumes a
 * sale rung up here is already visible elsewhere.
 *
 * `onChangeLocation` (F02-FIX) is only passed when the active outlet came
 * from a picker rather than a single device-assigned location (D-05
 * head-office roles, or a supervisor with several assigned outlets) — a
 * single-outlet cashier device keeps today's fixed display, but anyone who
 * chose their outlet must always be able to see and change that choice so
 * they're never confused about which outlet they're ringing sales into.
 *
 * F-POS-2: `onChangeLocation` being present or absent is also exactly "did
 * this outlet come from a pick or an assignment" — the same boolean the
 * owner asked this bar to explain in plain language (mirroring AIRE's
 * "Operating branch: X — from your open shift" line), so `reasonKey` is
 * derived from it rather than threaded through as a second prop that could
 * drift out of sync with the button's own presence.
 */
export function PosStatusBar({
  locationName,
  onChangeLocation,
}: {
  locationName: string | null;
  onChangeLocation?: () => void;
}) {
  const { t } = useI18n();
  const tier = useConnectivityStore((s) => s.tier);
  const reasonKey = onChangeLocation ? 'pos.branchReasonChosen' : 'pos.branchReasonAssigned';

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface-raised px-4 py-2.5">
      <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm font-medium text-text-primary">
        <span className="flex items-center gap-2">
          <Store className="size-4 text-text-muted" aria-hidden />
          {locationName ?? t('pos.noLocation')}
        </span>
        {locationName && (
          <span className="text-xs font-normal text-text-muted">{t(reasonKey)}</span>
        )}
        {onChangeLocation && (
          <Button variant="ghost" size="sm" onClick={onChangeLocation}>
            {t('pos.changeOutlet')}
          </Button>
        )}
      </span>
      <div className="flex items-center gap-3">
        {tier !== 'online' && (
          <span className="text-xs text-warning-700">{t('pos.notCrossVisible')}</span>
        )}
        <SyncStatusPill />
      </div>
    </div>
  );
}
