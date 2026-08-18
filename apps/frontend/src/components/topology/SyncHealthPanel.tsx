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
import type { SyncConflictRow, ReconciliationRow } from './lib/types';

const QUEUE_OPTIONS = ['conflict', 'exception', 'finance', 'hr'] as const;

/**
 * "Conflict and exception queues from kernel/sync ... surface reconciliation
 * problems that need a human" — read-only visibility for this ticket
 * (resolving/dismissing is CONTRACTS §4.23's `sync.conflict.resolve` and
 * routes into the owning domain screen per `resolveInUrl`, out of F12's
 * scope here).
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

  useEffect(() => {
    setConflictsLoading(true);
    getSyncConflicts({ status: 'open', queue: queue || undefined, pageSize: 50 })
      .then((r) => setConflicts(r))
      .catch(() => setConflicts({ rows: [], total: 0 }))
      .finally(() => setConflictsLoading(false));
  }, [queue]);

  useEffect(() => {
    setReconLoading(true);
    getReconciliations({ status: 'open', pageSize: 50 })
      .then((r) => setReconciliations(r))
      .catch(() => setReconciliations({ rows: [], total: 0 }))
      .finally(() => setReconLoading(false));
  }, []);

  const conflictColumns: DataTableColumn<SyncConflictRow>[] = [
    { key: 'kind', header: t('topology.sync.columnKind') },
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
              emptyTitle={t('topology.sync.reconciliationsEmpty')}
            />
          </CardContent>
        </Card>
      </PermissionGate>
    </div>
  );
}
