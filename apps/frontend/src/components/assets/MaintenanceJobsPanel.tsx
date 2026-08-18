'use client';

import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useSessionStore } from '@/stores/session-store';
import { Button, DataTable, Select, StatusBadge, PermissionGate, toast } from '@/components/ui';
import type { DataTableColumn } from '@/components/ui';
import { fmtDate } from '@/lib/dates';
import { formatMoney } from '@/lib/formatters';
import { getJobs, startJob, verifyJob } from './lib/assets-api';
import { CompleteJobModal } from './CompleteJobModal';
import type { Job } from './lib/types';

const STATUSES = ['scheduled', 'due', 'in_progress', 'done', 'verified', 'skipped'] as const;

/** Tab 3 — every maintenance job (FR-PMS-02/04): filter, start, complete (proof photo wajib), and Supervisor/Manager verify. */
export function MaintenanceJobsPanel() {
  const { t } = useI18n();
  const locations = useSessionStore((s) => s.user?.locations ?? []);
  const [locationId, setLocationId] = useState('');
  const [status, setStatus] = useState('');
  const [rows, setRows] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [completing, setCompleting] = useState<Job | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  function reload() {
    setLoading(true);
    getJobs({ locationId: locationId || undefined, status: status || undefined })
      .then((r) => setRows(r.rows))
      .catch(() => toast({ title: t('table.error'), variant: 'danger' }))
      .finally(() => setLoading(false));
  }
  useEffect(reload, [locationId, status]);

  async function handleStart(job: Job) {
    setBusyId(job.id);
    try {
      await startJob(job.id);
      reload();
    } catch {
      toast({ title: t('table.error'), variant: 'danger' });
    } finally {
      setBusyId(null);
    }
  }

  async function handleVerify(job: Job) {
    setBusyId(job.id);
    try {
      await verifyJob(job.id);
      toast({ title: t('assets.jobs.verifySuccess'), variant: 'success' });
      reload();
    } catch {
      toast({ title: t('table.error'), variant: 'danger' });
    } finally {
      setBusyId(null);
    }
  }

  const columns: DataTableColumn<Job>[] = [
    { key: 'jobNumber', header: t('assets.jobs.columnNumber') },
    { key: 'assetName', header: t('assets.jobs.columnAsset') },
    {
      key: 'type',
      header: t('assets.jobs.columnType'),
      render: (r) => t(`assets.jobType.${r.type}`),
    },
    { key: 'dueDate', header: t('assets.due.dueDate'), render: (r) => fmtDate(r.dueDate) },
    {
      key: 'assignedToName',
      header: t('assets.register.columnAssignedTo'),
      render: (r) => r.assignedToName ?? '—',
    },
    {
      key: 'cost',
      header: t('assets.jobs.cost'),
      align: 'right',
      render: (r) => formatMoney(r.cost),
    },
    {
      key: 'status',
      header: t('common.status'),
      render: (r) => <StatusBadge domain="maintenanceJob" status={r.status} />,
    },
    {
      key: 'actions',
      header: t('common.actions'),
      render: (r) => (
        <div className="flex gap-2">
          {r.status === 'due' && (
            <PermissionGate permission="asset.job.execute">
              <Button
                size="sm"
                variant="outline"
                loading={busyId === r.id}
                onClick={() => handleStart(r)}
              >
                {t('assets.jobs.startButton')}
              </Button>
            </PermissionGate>
          )}
          {(r.status === 'in_progress' || r.status === 'due') && (
            <PermissionGate permission="asset.job.execute">
              <Button size="sm" onClick={() => setCompleting(r)}>
                {t('assets.jobs.completeButton')}
              </Button>
            </PermissionGate>
          )}
          {r.status === 'done' && (
            <PermissionGate permission="asset.job.verify">
              <Button
                size="sm"
                variant="outline"
                loading={busyId === r.id}
                onClick={() => handleVerify(r)}
              >
                {t('assets.jobs.verifyButton')}
              </Button>
            </PermissionGate>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <Select
          label={t('common.location')}
          value={locationId}
          onValueChange={setLocationId}
          options={locations.map((l) => ({ value: l.id, label: l.name }))}
          placeholder={t('common.all')}
          wrapperClassName="w-44"
        />
        <Select
          label={t('common.status')}
          value={status}
          onValueChange={setStatus}
          options={STATUSES.map((s) => ({ value: s, label: t(`status.maintenanceJob.${s}`) }))}
          placeholder={t('common.all')}
          wrapperClassName="w-44"
        />
      </div>

      <DataTable
        columns={columns}
        data={{ rows, total: rows.length, page: 1, pageSize: Math.max(rows.length, 1) }}
        keyField={(r) => r.id}
        loading={loading}
        emptyDescription={t('assets.jobs.empty')}
      />

      {completing && (
        <CompleteJobModal
          job={completing}
          onClose={() => setCompleting(null)}
          onDone={() => {
            setCompleting(null);
            reload();
          }}
        />
      )}
    </div>
  );
}
