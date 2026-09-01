'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, PlayCircle } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { Modal, DataTable, StatusBadge, toast, Button, PermissionGate } from '@/components/ui';
import type { DataTableColumn } from '@/components/ui';
import { fmtDate } from '@/lib/dates';
import { ApiError } from '@/lib/api';
import {
  listWarehouseQueue,
  getReplenishment,
  approveReplenishment,
  rejectReplenishment,
  processReplenishment,
} from './lib/warehouse-api';
import { ReplenishmentApproveForm, type AmendmentInput } from './ReplenishmentApproveForm';
import type { Replenishment } from './lib/types';

/**
 * The Kepala Gudang approval queue — replenishment requests waiting on the
 * warehouse step of the two-step chain (§5.1: Supervisor first, then KGD).
 * Shows who requested, what, and the Supervisor's decision (via
 * `ApprovalTimeline` inside the detail form) before KGD acts. Amend-reason
 * gate lives in `ReplenishmentApproveForm`.
 */
export function ApprovalQueuePanel() {
  const { t } = useI18n();
  const [rows, setRows] = useState<Replenishment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [detail, setDetail] = useState<Replenishment | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [approvedRows, setApprovedRows] = useState<Replenishment[]>([]);
  const [approvedLoading, setApprovedLoading] = useState(true);
  const [approvedError, setApprovedError] = useState<string | undefined>(undefined);
  const [processingId, setProcessingId] = useState<string | null>(null);

  function reload() {
    setLoading(true);
    setError(undefined);
    listWarehouseQueue('awaiting_approval')
      .then((res) => setRows(res.rows))
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : t('table.error')))
      .finally(() => setLoading(false));
  }

  function reloadApproved() {
    setApprovedLoading(true);
    setApprovedError(undefined);
    listWarehouseQueue('approved')
      .then((res) => setApprovedRows(res.rows))
      .catch((err: unknown) =>
        setApprovedError(err instanceof ApiError ? err.message : t('table.error')),
      )
      .finally(() => setApprovedLoading(false));
  }

  useEffect(reload, []);
  useEffect(reloadApproved, []);

  async function handleProcess(row: Replenishment) {
    setProcessingId(row.id);
    try {
      await processReplenishment(row.id);
      toast({ title: t('warehouse.approvalQueue.processed'), variant: 'success' });
      reloadApproved();
    } catch {
      toast({ title: t('table.error'), variant: 'danger' });
    } finally {
      setProcessingId(null);
    }
  }

  async function openDetail(row: Replenishment) {
    const full = await getReplenishment(row.id);
    setDetail(full);
  }

  async function handleApprove(amendments: AmendmentInput[], note?: string) {
    if (!detail) return;
    setSubmitting(true);
    try {
      await approveReplenishment(detail.id, {
        note,
        amendments: amendments.length ? amendments : undefined,
      });
      toast({ title: t('warehouse.approvalQueue.approved'), variant: 'success' });
      setDetail(null);
      reload();
      reloadApproved();
    } catch {
      toast({ title: t('table.error'), variant: 'danger' });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleReject(reason: string) {
    if (!detail) return;
    setSubmitting(true);
    try {
      await rejectReplenishment(detail.id, { reason });
      toast({ title: t('warehouse.approvalQueue.rejected'), variant: 'success' });
      setDetail(null);
      reload();
    } catch {
      toast({ title: t('table.error'), variant: 'danger' });
    } finally {
      setSubmitting(false);
    }
  }

  const columns: DataTableColumn<Replenishment>[] = [
    { key: 'requestNumber', header: t('warehouse.approvalQueue.number') },
    { key: 'locationName', header: t('warehouse.approvalQueue.outlet') },
    {
      key: 'requestedBy',
      header: t('warehouse.approvalQueue.requestedBy'),
      // An em dash, never a blank and never the id. Gudang cannot read another
      // outlet's user row (`users_select`, migration 263), so this is `null`
      // for most rows on THIS screen — it used to print the raw UUID instead.
      render: (r) => r.requestedBy ?? '—',
    },
    { key: 'submittedAt', header: t('common.date'), render: (r) => fmtDate(r.submittedAt) },
    {
      key: 'neededBy',
      header: t('outlet.replenishment.neededBy'),
      render: (r) => fmtDate(r.neededBy),
    },
    {
      key: 'status',
      header: t('common.status'),
      render: (r) => <StatusBadge domain="replenishment" status={r.status} />,
    },
    {
      key: 'supervisorStep',
      header: t('warehouse.approvalQueue.supervisorDecision'),
      render: (r) => {
        const step = r.approval?.steps.find(
          (s) => s.approverRole.toLowerCase().includes('supervisor') || s.stepNo === 1,
        );
        if (!step) return '—';
        return step.state === 'approved' ? (
          <StatusBadge domain="approvalStep" status="approved" size="sm" />
        ) : (
          <span className="inline-flex items-center gap-1 text-sm text-warning-700">
            <AlertTriangle className="size-3.5" aria-hidden />
            <StatusBadge domain="approvalStep" status={step.state} size="sm" />
          </span>
        );
      },
    },
  ];

  const approvedColumns: DataTableColumn<Replenishment>[] = [
    { key: 'requestNumber', header: t('warehouse.approvalQueue.number') },
    { key: 'locationName', header: t('warehouse.approvalQueue.outlet') },
    { key: 'submittedAt', header: t('common.date'), render: (r) => fmtDate(r.submittedAt) },
    {
      key: 'neededBy',
      header: t('outlet.replenishment.neededBy'),
      render: (r) => fmtDate(r.neededBy),
    },
    {
      key: 'status',
      header: t('common.status'),
      render: (r) => <StatusBadge domain="replenishment" status={r.status} />,
    },
    {
      key: 'action',
      header: '',
      render: (r) => (
        <PermissionGate permission="replenishment.approve.warehouse">
          <Button
            size="sm"
            variant="outline"
            leftIcon={<PlayCircle className="size-4" />}
            loading={processingId === r.id}
            onClick={(e) => {
              e.stopPropagation();
              handleProcess(r);
            }}
          >
            {t('warehouse.approvalQueue.process')}
          </Button>
        </PermissionGate>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-text-primary">
          {t('warehouse.approvalQueue.pendingTitle')}
        </h2>
        <DataTable
          columns={columns}
          data={{ rows, total: rows.length, page: 1, pageSize: Math.max(rows.length, 1) }}
          keyField={(r) => r.id}
          loading={loading}
          error={error}
          onRowClick={openDetail}
          emptyDescription={t('warehouse.approvalQueue.empty')}
        />
        {error && (
          <div className="flex justify-end">
            <Button variant="outline" size="sm" onClick={reload}>
              {t('common.retry')}
            </Button>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-text-primary">
          {t('warehouse.approvalQueue.approvedTitle')}
        </h2>
        <p className="text-sm text-text-muted">{t('warehouse.approvalQueue.approvedHint')}</p>
        <DataTable
          columns={approvedColumns}
          data={{
            rows: approvedRows,
            total: approvedRows.length,
            page: 1,
            pageSize: Math.max(approvedRows.length, 1),
          }}
          keyField={(r) => r.id}
          loading={approvedLoading}
          error={approvedError}
          emptyDescription={t('warehouse.approvalQueue.approvedEmpty')}
        />
        {approvedError && (
          <div className="flex justify-end">
            <Button variant="outline" size="sm" onClick={reloadApproved}>
              {t('common.retry')}
            </Button>
          </div>
        )}
      </div>

      <Modal
        open={!!detail}
        onClose={() => setDetail(null)}
        title={detail?.requestNumber ?? ''}
        size="lg"
      >
        {detail && (
          <ReplenishmentApproveForm
            replenishment={detail}
            submitting={submitting}
            onApprove={handleApprove}
            onReject={handleReject}
          />
        )}
      </Modal>
    </div>
  );
}
