'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { Modal, DataTable, StatusBadge, toast } from '@/components/ui';
import type { DataTableColumn } from '@/components/ui';
import { fmtDate } from '@/lib/dates';
import { listWarehouseQueue, getReplenishment, approveReplenishment, rejectReplenishment } from './lib/warehouse-api';
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
  const [detail, setDetail] = useState<Replenishment | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function reload() {
    setLoading(true);
    listWarehouseQueue('awaiting_approval')
      .then((res) => setRows(res.rows))
      .catch(() => toast({ title: t('table.error'), variant: 'danger' }))
      .finally(() => setLoading(false));
  }

  useEffect(reload, []);

  async function openDetail(row: Replenishment) {
    const full = await getReplenishment(row.id);
    setDetail(full);
  }

  async function handleApprove(amendments: AmendmentInput[], note?: string) {
    if (!detail) return;
    setSubmitting(true);
    try {
      await approveReplenishment(detail.id, { note, amendments: amendments.length ? amendments : undefined });
      toast({ title: t('warehouse.approvalQueue.approved'), variant: 'success' });
      setDetail(null);
      reload();
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
    { key: 'requestedBy', header: t('warehouse.approvalQueue.requestedBy') },
    { key: 'submittedAt', header: t('common.date'), render: (r) => fmtDate(r.submittedAt) },
    { key: 'neededBy', header: t('outlet.replenishment.neededBy'), render: (r) => fmtDate(r.neededBy) },
    { key: 'status', header: t('common.status'), render: (r) => <StatusBadge domain="replenishment" status={r.status} /> },
    {
      key: 'supervisorStep',
      header: t('warehouse.approvalQueue.supervisorDecision'),
      render: (r) => {
        const step = r.approval?.steps.find((s) => s.approverRole.toLowerCase().includes('supervisor') || s.stepNo === 1);
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

  return (
    <div className="flex flex-col gap-4">
      <DataTable
        columns={columns}
        data={{ rows, total: rows.length, page: 1, pageSize: Math.max(rows.length, 1) }}
        keyField={(r) => r.id}
        loading={loading}
        onRowClick={openDetail}
        emptyDescription={t('warehouse.approvalQueue.empty')}
      />

      <Modal open={!!detail} onClose={() => setDetail(null)} title={detail?.requestNumber ?? ''} size="lg">
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
