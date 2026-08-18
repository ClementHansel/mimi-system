'use client';

import { CheckCircle2, Loader2, Clock, Wifi, WifiOff, RotateCw } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { fmtRelative } from '@/lib/dates';
import { cn } from '@/lib/utils';
import { useConnectivityStore } from '@/stores/connectivity-store';
import { useManualConnectivityCheck } from '@/components/layout/useManualConnectivityCheck';

/**
 * D-25b (owner-decided): connectivity and sync are TWO independent,
 * always-visible states — never collapsed into one badge. Before this
 * ticket, this file computed a single `offline | syncing | queued | synced`
 * state, which meant "offline" always won over the actual outbox depth: a
 * fully-drained-but-offline device and an online-with-a-huge-backlog device
 * both looked however the OTHER dimension happened to render. That is
 * exactly the "single combined indicator" the owner called out as what
 * erodes staff trust, so this now renders two pills side by side:
 *
 *  - `ConnectivityPill` — is the CLOUD reachable right now. Derived from
 *    `tier`, collapsing 'lan' into "offline": in LAN-only mode the device is
 *    talking to the paired branch node, not the cloud, so from "can I reach
 *    the server" the honest answer is still no (`OfflineBanner` still spells
 *    out the LAN nuance in full sentences for whoever reads past the pill).
 *  - `SyncPill` — does local data match the cloud, i.e. is the outbox
 *    drained. Computed from `queueDepth`/`isSyncing` ONLY, deliberately
 *    ignoring `tier`, so "offline and fully drained" renders as synced and
 *    "online with a backlog" renders as queued.
 *
 * Both carry icon + colour + label per NFR-04 (never colour-only, for
 * glare-washed tablets and minimally-trained staff). `SyncRetryButton` (the
 * "Coba Sinkron" manual action, also exported here so `OfflineBanner` can
 * reuse it) forces a fresh check of both — see `useManualConnectivityCheck`
 * for exactly what "force" means against the runtime's actual public API.
 */

function ConnectivityPill({ online }: { online: boolean }) {
  const { t } = useI18n();
  const Icon = online ? Wifi : WifiOff;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium',
        online ? 'bg-success-50 text-success-700' : 'bg-stone-100 text-stone-600',
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      {online ? t('sync.online') : t('sync.offline')}
    </span>
  );
}

function SyncPill({ isSyncing, queueDepth }: { isSyncing: boolean; queueDepth: number }) {
  const { t } = useI18n();
  const state: 'syncing' | 'queued' | 'synced' = isSyncing
    ? 'syncing'
    : queueDepth > 0
      ? 'queued'
      : 'synced';

  const META = {
    syncing: { icon: Loader2, classes: 'bg-info-50 text-info-700', label: t('sync.syncing') },
    queued: {
      icon: Clock,
      classes: 'bg-warning-50 text-warning-700',
      label: t('sync.queued', { count: queueDepth }),
    },
    synced: {
      icon: CheckCircle2,
      classes: 'bg-success-50 text-success-700',
      label: t('sync.synced'),
    },
  } as const;
  const { icon: Icon, classes, label } = META[state];

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium',
        classes,
      )}
    >
      <Icon className={cn('size-3.5', state === 'syncing' && 'animate-spin')} aria-hidden />
      {label}
    </span>
  );
}

/**
 * The D-25b manual action: re-checks connectivity, then attempts a sync, and
 * shows the in-progress state and the honest outcome (including a failure
 * reason when one is available). Shared by `SyncStatusPill` (always in the
 * header) and `OfflineBanner` (the degraded-tier banner, where the same
 * action is most likely to be reached for).
 */
export function SyncRetryButton({ className }: { className?: string }) {
  const { t } = useI18n();
  const { status, errorKey, run } = useManualConnectivityCheck();
  const checking = status === 'checking';

  return (
    <div className={cn('inline-flex flex-wrap items-center gap-2', className)}>
      <button
        type="button"
        onClick={() => void run()}
        disabled={checking}
        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-raised px-2.5 py-1 text-xs font-medium text-text-primary hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-60"
      >
        <RotateCw className={cn('size-3.5', checking && 'animate-spin')} aria-hidden />
        {checking ? t('offline.retrying') : t('offline.retrySync')}
      </button>
      {status === 'success' && (
        <span className="text-xs font-medium text-success-700">{t('offline.retrySuccess')}</span>
      )}
      {status === 'error' && (
        <span className="text-xs font-medium text-danger-600">
          {t(`offline.retryFailedReason.${errorKey ?? 'unknown'}`)}
        </span>
      )}
    </div>
  );
}

/**
 * Compact header pair: connectivity pill + sync pill (see file docblock).
 * Meant to live in the header at all times, unlike `OfflineBanner` which
 * only appears when degraded.
 */
export function SyncStatusPill({ className }: { className?: string }) {
  const { t } = useI18n();
  const tier = useConnectivityStore((s) => s.tier);
  const queueDepth = useConnectivityStore((s) => s.queueDepth);
  const isSyncing = useConnectivityStore((s) => s.isSyncing);
  const lastSyncAt = useConnectivityStore((s) => s.lastSyncAt);

  const title = lastSyncAt
    ? t('offline.lastSync', { when: fmtRelative(lastSyncAt) })
    : t('offline.neverSynced');

  return (
    <span title={title} className={cn('inline-flex flex-wrap items-center gap-1.5', className)}>
      <ConnectivityPill online={tier === 'online'} />
      <SyncPill isSyncing={isSyncing} queueDepth={queueDepth} />
    </span>
  );
}
