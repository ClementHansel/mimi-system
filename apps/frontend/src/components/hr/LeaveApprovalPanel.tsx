'use client';

import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/components/ui/Toast';
import {
  Button,
  Card,
  CardContent,
  DataTable,
  Modal,
  Select,
  StatusBadge,
  Textarea,
  PermissionGate,
} from '@/components/ui';
import { usePermissions } from '@/lib/permissions';
import { fmtDateRange } from '@/lib/dates';
import { approveLeave, listLeaves, rejectLeave } from './lib/hr-api';
import type { Leave } from './lib/types';
import type { Paginated } from '@/lib/shared-types';

const LEAVE_TYPES = ['annual', 'marriage', 'sick', 'permission', 'unpaid'];

/** F08 `hr` — leave approval (`hr.leave.read`/`.approve`, F-HR-06). */
export function LeaveApprovalPanel() {
  const { t } = useI18n();
  const { can } = usePermissions();
  const [status, setStatus] = useState('pending');
  const [type, setType] = useState('');
  const [data, setData] = useState<Paginated<Leave>>({ rows: [], total: 0, page: 1, pageSize: 50 });
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<{ leave: Leave; mode: 'approve' | 'reject' } | null>(null);

  function reload() {
    setLoading(true);
    listLeaves({ status: status || undefined, type: type || undefined, page: data.page })
      .then(setData)
      .finally(() => setLoading(false));
  }

  useEffect(reload, [status, type, data.page]);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3">
          <Select
            label={t('hr.leaves.filterStatus')}
            value={status}
            onValueChange={setStatus}
            options={[
              { value: '', label: t('hr.leaves.allStatuses') },
              ...['pending', 'approved', 'rejected', 'cancelled'].map((s) => ({
                value: s,
                label: t(`status.leave.${s}`),
              })),
            ]}
            wrapperClassName="w-48"
          />
          <Select
            label={t('hr.leaves.filterType')}
            value={type}
            onValueChange={setType}
            options={[
              { value: '', label: t('hr.leaves.allTypes') },
              ...LEAVE_TYPES.map((lt) => ({ value: lt, label: t(`hr.leaves.type.${lt}`) })),
            ]}
            wrapperClassName="w-48"
          />
        </CardContent>
      </Card>

      <DataTable
        columns={[
          { key: 'employeeName', header: t('hr.leaves.columnEmployee') },
          {
            key: 'type',
            header: t('hr.leaves.columnType'),
            render: (r) => t(`hr.leaves.type.${r.type}`),
          },
          {
            key: 'period',
            header: t('hr.leaves.columnPeriod'),
            render: (r) => fmtDateRange(r.startDate, r.endDate),
          },
          { key: 'days', header: t('hr.leaves.columnDays'), align: 'right' },
          { key: 'reason', header: t('hr.leaves.columnReason'), render: (r) => r.reason ?? '—' },
          {
            key: 'status',
            header: t('hr.leaves.columnStatus'),
            render: (r) => <StatusBadge domain="leave" status={r.status} size="sm" />,
          },
          {
            key: 'actions',
            header: '',
            render: (r) =>
              r.status === 'pending' && can('hr.leave.approve') ? (
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => setActing({ leave: r, mode: 'approve' })}>
                    {t('common.approve')}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setActing({ leave: r, mode: 'reject' })}
                  >
                    {t('common.reject')}
                  </Button>
                </div>
              ) : null,
          },
        ]}
        data={data}
        keyField={(r) => r.id}
        loading={loading}
        onPageChange={(page) => setData((d) => ({ ...d, page }))}
      />

      {acting && (
        <PermissionGate permission="hr.leave.approve">
          <DecisionModal
            leave={acting.leave}
            mode={acting.mode}
            onClose={() => setActing(null)}
            onDone={() => {
              setActing(null);
              reload();
            }}
          />
        </PermissionGate>
      )}
    </div>
  );
}

function DecisionModal({
  leave,
  mode,
  onClose,
  onDone,
}: {
  leave: Leave;
  mode: 'approve' | 'reject';
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (mode === 'reject' && !note.trim()) return;
    setBusy(true);
    try {
      if (mode === 'approve') await approveLeave(leave.id, note || undefined);
      else await rejectLeave(leave.id, note);
      toast({
        title: t(mode === 'approve' ? 'hr.leaves.approveSuccess' : 'hr.leaves.rejectSuccess'),
        variant: 'success',
      });
      onDone();
    } catch {
      toast({ title: t('auth.genericError'), variant: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t(mode === 'approve' ? 'hr.leaves.approveTitle' : 'hr.leaves.rejectTitle', {
        name: leave.employeeName,
      })}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant={mode === 'reject' ? 'danger' : 'primary'}
            onClick={submit}
            loading={busy}
            disabled={mode === 'reject' && !note.trim()}
          >
            {t('common.confirm')}
          </Button>
        </>
      }
    >
      <Textarea
        label={t(mode === 'approve' ? 'hr.leaves.approveNote' : 'hr.leaves.rejectReason')}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        required={mode === 'reject'}
      />
    </Modal>
  );
}
