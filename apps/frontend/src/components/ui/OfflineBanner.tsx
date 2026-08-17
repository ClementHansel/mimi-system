'use client';

import { WifiOff, Waypoints } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { fmtRelative } from '@/lib/dates';
import { cn } from '@/lib/utils';
import { useConnectivityStore } from '@/stores/connectivity-store';
import { SyncRetryButton } from './SyncStatusPill';

/**
 * The tier-degradation banner (SYNC-PROTOCOL §8). Renders nothing when the
 * tier is 'online'. 'lan' and 'isolated' get distinct tone/icon/copy because
 * they mean different things to the person reading it: 'lan' means "keep
 * working, decisions are just delayed"; 'isolated' means "you are fully on
 * your own until reconnect" — the wording (offline.* in id.ts) says so
 * explicitly rather than making the user infer it from a color.
 *
 * D-25b: this banner already keeps queue depth and last-sync time separate
 * from the tier description (never conflates "can't reach the server" with
 * "have unsynced data") — `SyncStatusPill`'s two pills are the always-visible
 * always-on version of the same split. The manual "Coba Sinkron" action
 * (`SyncRetryButton`) is surfaced here too since a degraded-connectivity
 * banner is exactly the moment someone reaches for a retry.
 */
export function OfflineBanner({ className }: { className?: string }) {
  const { t } = useI18n();
  const tier = useConnectivityStore((s) => s.tier);
  const queueDepth = useConnectivityStore((s) => s.queueDepth);
  const lastSyncAt = useConnectivityStore((s) => s.lastSyncAt);

  if (tier === 'online') return null;

  const isIsolated = tier === 'isolated';

  return (
    <div
      role="status"
      className={cn(
        'flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 text-sm',
        isIsolated ? 'bg-warning-50 text-warning-700' : 'bg-info-50 text-info-700',
        className,
      )}
    >
      <span className="flex items-center gap-2 font-medium">
        {isIsolated ? <WifiOff className="size-4" aria-hidden /> : <Waypoints className="size-4" aria-hidden />}
        {isIsolated ? t('offline.tierIsolated') : t('offline.tierLan')}
      </span>
      <span className="opacity-90">{isIsolated ? t('offline.isolatedDesc') : t('offline.lanDesc')}</span>
      {queueDepth > 0 && <span className="font-medium">{t('offline.queuedCount', { count: queueDepth })}</span>}
      <span className="opacity-70">{lastSyncAt ? t('offline.lastSync', { when: fmtRelative(lastSyncAt) }) : t('offline.neverSynced')}</span>
      <SyncRetryButton className="ml-auto" />
    </div>
  );
}
