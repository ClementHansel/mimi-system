'use client';

import type { ReactNode } from 'react';
import { useI18n } from '@/lib/i18n';
import { Drawer, StatusBadge } from '@/components/ui';
import { fmtDateTime } from '@/lib/dates';
import type { TopologyDevice, TopologyLocation } from './lib/types';

/**
 * Per-device detail (ticket: "last seen, app version, queue depth, and
 * whether it is paired to a branch node"). The tree endpoint doesn't carry a
 * per-device `nodeId` (only `TopologyLocation.node`), so "paired to a
 * branch node" is read at the outlet level — every device under an outlet
 * with a live node routes LAN-first through it; see `lib/rollup.ts` and the
 * report note on this endpoint-shape gap.
 *
 * Storage is deliberately NOT rendered here — CONTRACTS heartbeat payload
 * ships `storage.usedMb/quotaMb` as a hardcoded `0/0` stub today, so showing
 * it would read as "every tablet has 0 MB used", which is wrong, not just
 * unhelpful. `topology.device.storageNote` explains the omission instead of
 * silently dropping the field.
 */
export function DeviceDetailDrawer({
  device,
  location,
  onClose,
}: {
  device: TopologyDevice | null;
  location: TopologyLocation;
  onClose: () => void;
}) {
  const { t } = useI18n();

  return (
    <Drawer open={!!device} onClose={onClose} title={device ? device.name : t('topology.device.detailTitle')} side="right" size="sm">
      {device && (
        <dl className="flex flex-col gap-4 text-sm">
          <Row label={t('common.status')}>
            <StatusBadge domain="device" status={device.status} />
          </Row>
          <Row label={t('topology.device.columnCategory')}>{t(`topology.device.category.${device.category}`)}</Row>
          <Row label={t('topology.device.lastSeen')}>{fmtDateTime(device.lastSeenAt)}</Row>
          <Row label={t('topology.device.appVersion')}>{device.appVersion ?? '—'}</Row>
          <Row label={t('topology.device.queueDepth')}>{device.queueDepth}</Row>
          <Row label={t('topology.device.ipAddress')}>{device.ipAddress ?? '—'}</Row>
          <Row label={t('topology.device.pairedToNode')}>
            {location.node
              ? t('topology.device.pairedToNodeYes', { name: location.node.name })
              : t('topology.device.pairedToNodeNo')}
          </Row>
          <p className="rounded-md bg-surface-sunken p-3 text-xs text-text-muted">{t('topology.device.storageNote')}</p>
        </dl>
      )}
    </Drawer>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs font-medium uppercase tracking-wide text-text-muted">{label}</dt>
      <dd className="text-text-primary">{children}</dd>
    </div>
  );
}
