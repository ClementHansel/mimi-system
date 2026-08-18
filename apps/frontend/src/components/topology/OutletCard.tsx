'use client';

import { useState } from 'react';
import {
  Tablet,
  Smartphone,
  Printer,
  Laptop,
  Router,
  Waypoints,
  HardDrive,
  type LucideIcon,
} from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  StatusBadge,
  DataTable,
  Badge,
} from '@/components/ui';
import type { DataTableColumn } from '@/components/ui';
import { fmtRelative } from '@/lib/dates';
import { nodeDisplayState } from './lib/rollup';
import type { TopologyLocation, TopologyDevice } from './lib/types';
import { DeviceDetailDrawer } from './DeviceDetailDrawer';

const CATEGORY_ICON: Record<TopologyDevice['category'], LucideIcon> = {
  tablet: Tablet,
  pos_terminal: Smartphone,
  printer: Printer,
  laptop: Laptop,
  router: Router,
  branch_node: Waypoints,
  other: HardDrive,
};

/**
 * One Pusat/outlet row of the D-13 topology tree: rolled-up status header,
 * the D-26 node-state read (none / pairing-pending / paired — see
 * `lib/rollup.ts`), and the device list underneath. `retired` devices are
 * hidden per CONTRACTS §7.4 ("hidden by default"); `unpaired` still shows
 * (an operator legitimately wants to see "this tablet was unpaired last
 * week", it's just excluded from the online/stale/offline counts already,
 * server-side).
 */
export function OutletCard({ location }: { location: TopologyLocation }) {
  const { t } = useI18n();
  const [openDevice, setOpenDevice] = useState<TopologyDevice | null>(null);

  const visibleDevices = location.devices.filter((d) => d.status !== 'retired');
  const nodeState = nodeDisplayState(location);

  const columns: DataTableColumn<TopologyDevice>[] = [
    {
      key: 'name',
      header: t('topology.device.columnName'),
      render: (d) => {
        const Icon = CATEGORY_ICON[d.category] ?? HardDrive;
        return (
          <span className="inline-flex items-center gap-2">
            <Icon className="size-4 text-text-muted" aria-hidden />
            {d.name}
          </span>
        );
      },
    },
    {
      key: 'category',
      header: t('topology.device.columnCategory'),
      render: (d) => t(`topology.device.category.${d.category}`),
    },
    {
      key: 'status',
      header: t('topology.device.columnStatus'),
      render: (d) => <StatusBadge domain="device" status={d.status} size="sm" />,
    },
    {
      key: 'appVersion',
      header: t('topology.device.columnAppVersion'),
      render: (d) => d.appVersion ?? '—',
    },
    {
      key: 'queueDepth',
      header: t('topology.device.columnQueueDepth'),
      align: 'right',
      render: (d) => String(d.queueDepth),
    },
    {
      key: 'lastSeenAt',
      header: t('topology.device.columnLastSeen'),
      render: (d) => fmtRelative(d.lastSeenAt),
    },
  ];

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base">{location.location.name}</CardTitle>
          <StatusBadge domain="topologyOutlet" status={location.outletStatus} size="sm" />
          <Badge variant="neutral" size="sm">
            {t('topology.outlet.deviceCount', { count: location.counts.total })}
          </Badge>
        </div>
        <NodeIndicator location={location} nodeState={nodeState} />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <SyncHealthStrip location={location} />
        <DataTable
          columns={columns}
          data={{
            rows: visibleDevices,
            total: visibleDevices.length,
            page: 1,
            pageSize: Math.max(visibleDevices.length, 1),
          }}
          keyField={(d) => d.id}
          onRowClick={(d) => setOpenDevice(d)}
          emptyTitle={t('topology.device.empty')}
        />
      </CardContent>
      <DeviceDetailDrawer
        device={openDevice}
        location={location}
        onClose={() => setOpenDevice(null)}
      />
    </Card>
  );
}

function NodeIndicator({
  location,
  nodeState,
}: {
  location: TopologyLocation;
  nodeState: ReturnType<typeof nodeDisplayState>;
}) {
  const { t } = useI18n();

  if (nodeState === 'none') {
    return <span className="text-xs text-text-muted">{t('topology.outlet.node.none')}</span>;
  }
  if (nodeState === 'pairing_pending') {
    return <StatusBadge domain="topologyOutlet" status="degraded" size="sm" className="text-xs" />;
  }
  const node = location.node!;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <Waypoints className="size-3.5 text-text-muted" aria-hidden />
      <span>{t('topology.outlet.node.label', { name: node.name })}</span>
      <StatusBadge domain="device" status={node.status} size="sm" />
    </span>
  );
}

function SyncHealthStrip({ location }: { location: TopologyLocation }) {
  const { t } = useI18n();
  const h = location.syncHealth;
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 rounded-md bg-surface-sunken px-3 py-2 text-xs text-text-secondary">
      <span>
        {t('topology.outlet.syncHealth.queueDepth')}:{' '}
        <strong className="text-text-primary">{h.queueDepth}</strong>
      </span>
      <span>
        {t('topology.outlet.syncHealth.quarantineDepth')}:{' '}
        <strong className="text-text-primary">{h.quarantineDepth}</strong>
      </span>
      <span>
        {t('topology.outlet.syncHealth.lastSyncAt')}:{' '}
        <strong className="text-text-primary">
          {h.lastSyncAt ? fmtRelative(h.lastSyncAt) : t('topology.outlet.syncHealth.neverSynced')}
        </strong>
      </span>
      {h.conflictsOpen > 0 && (
        <span className="text-danger-600">
          {t('topology.outlet.syncHealth.conflictsOpen')}: <strong>{h.conflictsOpen}</strong>
        </span>
      )}
      {h.exceptionsOpen > 0 && (
        <span className="text-warning-700">
          {t('topology.outlet.syncHealth.exceptionsOpen')}: <strong>{h.exceptionsOpen}</strong>
        </span>
      )}
      {h.offlineAuthPending > 0 && (
        <span className="text-warning-700">
          {t('topology.outlet.syncHealth.offlineAuthPending')}:{' '}
          <strong>{h.offlineAuthPending}</strong>
        </span>
      )}
    </div>
  );
}
