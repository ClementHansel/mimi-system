'use client';

import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  DataTable,
  Badge,
  Select,
  PermissionGate,
} from '@/components/ui';
import type { DataTableColumn } from '@/components/ui';
import { fmtRelative, fmtDate } from '@/lib/dates';
import { getSyncConflicts, getReconciliations } from './lib/topology-api';
import { ConflictDetailDrawer } from './ConflictDetailDrawer';
import { ReconciliationDetailDrawer } from './ReconciliationDetailDrawer';
import type { SyncConflictRow, ReconciliationRow } from './lib/types';

const QUEUE_OPTIONS = ['conflict', 'exception', 'finance', 'hr'] as const;

/**
 * Conflict and exception queues from `kernel/sync`, plus stock divergences —
 * the reconciliation problems that need a human.
 *
 * No longer read-only (owner, 2026-08-21: "all these need to be clickable and
 * show the details. and able to do something related to that to resolve it").
 * F12 shipped this as visibility only, which left an operator staring at
 * `duplicate_receipt on goods_receipts` with nowhere to go. Both tables are now
 * row-clickable into a drawer that explains the row and offers the action that
 * actually fits it — dismissal with a reason where the engine already settled
 * the race, and a route into the owning document where only a human recount or
 * an approval can settle it. The endpoints (`sync.conflict.resolve`) existed
 * all along; nothing called them.
 */
export function SyncHealthPanel() {
  const { t } = useI18n();
  const [queue, setQueue] = useState('');
  const [conflicts, setConflicts] = useState<{ rows: SyncConflictRow[]; total: number } | null>(
    null,
  );
  const [conflictsLoading, setConflictsLoading] = useState(true);
  const [reconciliations, setReconciliations] = useState<{
    rows: ReconciliationRow[];
    total: number;
  } | null>(null);
  const [reconLoading, setReconLoading] = useState(true);
  const [openConflict, setOpenConflict] = useState<SyncConflictRow | null>(null);
  const [openRecon, setOpenRecon] = useState<ReconciliationRow | null>(null);
  // Bumped after a successful resolve so both tables refetch — a row that was
  // just dismissed must not linger in a queue whose whole purpose is "what is
  // still outstanding".
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    setConflictsLoading(true);
    getSyncConflicts({ status: 'open', queue: queue || undefined, pageSize: 50 })
      .then((r) => setConflicts(r))
      .catch(() => setConflicts({ rows: [], total: 0 }))
      .finally(() => setConflictsLoading(false));
  }, [queue, reloadToken]);

  useEffect(() => {
    setReconLoading(true);
    getReconciliations({ status: 'open', pageSize: 50 })
      .then((r) => setReconciliations(r))
      .catch(() => setReconciliations({ rows: [], total: 0 }))
      .finally(() => setReconLoading(false));
  }, [reloadToken]);

  const conflictColumns: DataTableColumn<SyncConflictRow>[] = [
    {
      key: 'kind',
      header: t('topology.sync.columnKind'),
      // `double_count` told an operator nothing. The engine's token stays
      // available in the drawer; the table reads as a sentence.
      render: (r) => t(`topology.sync.kind.${r.kind}`),
    },
    {
      key: 'queue',
      header: t('topology.sync.columnQueue'),
      render: (r) => (
        <Badge variant="neutral" size="sm">
          {r.queue}
        </Badge>
      ),
    },
    { key: 'entity', header: t('topology.sync.columnEntity') },
    {
      key: 'physicalEffectSuspected',
      header: t('topology.sync.columnPhysicalEffect'),
      render: (r) =>
        r.physicalEffectSuspected ? (
          <Badge variant="danger" size="sm">
            {t('topology.sync.physicalEffectYes')}
          </Badge>
        ) : (
          t('topology.sync.physicalEffectNo')
        ),
    },
    {
      key: 'createdAt',
      header: t('topology.sync.columnDetected'),
      render: (r) => fmtRelative(r.createdAt),
    },
  ];

  const reconColumns: DataTableColumn<ReconciliationRow>[] = [
    { key: 'locationName', header: t('topology.sync.columnLocation') },
    { key: 'itemName', header: t('topology.sync.columnItem') },
    {
      key: 'storageAreaName',
      header: t('topology.sync.columnStorageArea'),
      render: (r) => r.storageAreaName ?? '—',
    },
    { key: 'expectedQty', header: t('topology.sync.columnExpectedQty'), align: 'right' },
    { key: 'storedQty', header: t('topology.sync.columnStoredQty'), align: 'right' },
    { key: 'divergence', header: t('topology.sync.columnDivergence'), align: 'right' },
    {
      key: 'detectedAt',
      header: t('topology.sync.columnDetected'),
      render: (r) => fmtDate(r.detectedAt),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
          <CardTitle>{t('topology.sync.conflictsTitle')}</CardTitle>
          <Select
            value={queue}
            onValueChange={setQueue}
            size="sm"
            wrapperClassName="w-40"
            options={[
              { value: '', label: t('topology.sync.filterQueue') },
              ...QUEUE_OPTIONS.map((q) => ({ value: q, label: q })),
            ]}
          />
        </CardHeader>
        <CardContent>
          <DataTable
            columns={conflictColumns}
            data={{
              rows: conflicts?.rows ?? [],
              total: conflicts?.total ?? 0,
              page: 1,
              pageSize: 50,
            }}
            keyField={(r) => r.id}
            loading={conflictsLoading}
            onRowClick={(r) => setOpenConflict(r)}
            emptyTitle={t('topology.sync.conflictsEmpty')}
          />
        </CardContent>
      </Card>

      <PermissionGate permission="sync.status.read">
        <Card>
          <CardHeader>
            <CardTitle>{t('topology.sync.reconciliationsTitle')}</CardTitle>
          </CardHeader>
          <CardContent>
            <DataTable
              columns={reconColumns}
              data={{
                rows: reconciliations?.rows ?? [],
                total: reconciliations?.total ?? 0,
                page: 1,
                pageSize: 50,
              }}
              keyField={(r) => r.id}
              loading={reconLoading}
              onRowClick={(r) => setOpenRecon(r)}
              emptyTitle={t('topology.sync.reconciliationsEmpty')}
            />
          </CardContent>
        </Card>
      </PermissionGate>

      {openConflict && (
        <ConflictDetailDrawer
          conflict={openConflict}
          onClose={() => setOpenConflict(null)}
          onResolved={() => {
            setOpenConflict(null);
            setReloadToken((n) => n + 1);
          }}
        />
      )}

      {openRecon && (
        <ReconciliationDetailDrawer
          row={openRecon}
          onClose={() => setOpenRecon(null)}
          onResolved={() => {
            setOpenRecon(null);
            setReloadToken((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}
