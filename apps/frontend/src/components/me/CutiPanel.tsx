'use client';

import { useEffect, useState } from 'react';
import { CalendarPlus } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/components/ui/Toast';
import {
  Button,
  Card,
  CardContent,
  Modal,
  Select,
  Input,
  Textarea,
  StatusBadge,
  EmptyState,
  FileUpload,
} from '@/components/ui';
import { fmtDateRange } from '@/lib/dates';
import { newUuid } from '@/lib/uuid';
import { createLeaveRequest, cancelLeaveRequest, getMyLeaves } from './lib/me-api';
import type { Leave, LeaveQuota } from '@/components/hr/lib/types';
import { uploadLeaveAttachment } from '@/components/hr/lib/attachments';
import { LeaveAttachmentLink } from '@/components/hr/LeaveAttachmentLink';
import { errMsg } from '@/lib/api-error';

const currentYear = new Date().getFullYear();
const LEAVE_TYPES = ['annual', 'marriage', 'sick', 'permission', 'unpaid'];

function mintId(): string {
  return newUuid();
}

/** F11 `me` — Ajukan Cuti/Izin: request leave, see remaining entitlement (cuti tahunan 12 hari, nikah 3 hari — POUT-04). */
export function CutiPanel() {
  const { t } = useI18n();
  const [leaves, setLeaves] = useState<Leave[]>([]);
  const [quota, setQuota] = useState<LeaveQuota>({
    annual: { total: 12, used: 0 },
    marriage: { total: 3, used: 0 },
  });
  const [quotaUnavailable, setQuotaUnavailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);

  function reload() {
    setLoading(true);
    getMyLeaves(String(currentYear))
      .then((res) => {
        setLeaves(res.leaves);
        setQuota(res.quota);
        setQuotaUnavailable(res.quotaUnavailable);
      })
      .finally(() => setLoading(false));
  }
  useEffect(reload, []);

  async function cancel(id: string) {
    try {
      await cancelLeaveRequest(id);
      toast({ title: t('me.cuti.cancelSuccess'), variant: 'success' });
      reload();
    } catch (err) {
      toast({ title: errMsg(err, t('errors.generic')), variant: 'danger' });
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3">
        <QuotaCard
          label={t('me.cuti.annualLabel')}
          used={quota.annual.used}
          total={quota.annual.total}
          unavailable={quotaUnavailable}
        />
        <QuotaCard
          label={t('me.cuti.marriageLabel')}
          used={quota.marriage.used}
          total={quota.marriage.total}
          unavailable={quotaUnavailable}
        />
      </div>

      <Button
        size="touch-lg"
        fullWidth
        leftIcon={<CalendarPlus className="size-5" />}
        onClick={() => setFormOpen(true)}
      >
        {t('me.cuti.newRequest')}
      </Button>

      {loading ? (
        <div className="h-24 animate-pulse rounded-md bg-surface-sunken" />
      ) : leaves.length === 0 ? (
        <EmptyState title={t('me.cuti.empty')} size="lg" />
      ) : (
        <div className="flex flex-col gap-3">
          {leaves.map((leave) => (
            <Card key={leave.id}>
              <CardContent className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-text-primary">
                    {t(`me.cuti.type.${leave.type}`)}
                  </span>
                  <StatusBadge domain="leave" status={leave.status} size="sm" />
                </div>
                <p className="text-sm text-text-secondary">
                  {fmtDateRange(leave.startDate, leave.endDate)} · {leave.days} {t('me.cuti.days')}
                </p>
                {leave.reason && <p className="text-sm text-text-muted">{leave.reason}</p>}
                {/* Their own copy of what they attached — so someone can
                    confirm the right file went up without asking HR. */}
                {leave.attachmentId && <LeaveAttachmentLink attachmentId={leave.attachmentId} />}
                {leave.status === 'pending' && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => cancel(leave.id)}
                    className="mt-1 w-fit"
                  >
                    {t('me.cuti.cancelButton')}
                  </Button>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {formOpen && (
        <NewLeaveModal
          onClose={() => setFormOpen(false)}
          onCreated={() => {
            setFormOpen(false);
            reload();
          }}
        />
      )}
    </div>
  );
}

function QuotaCard({
  label,
  used,
  total,
  unavailable,
}: {
  label: string;
  used: number;
  total: number;
  unavailable: boolean;
}) {
  const { t } = useI18n();
  return (
    <Card>
      <CardContent className="flex flex-col gap-1">
        <span className="text-xs text-text-muted">{label}</span>
        <span className="text-xl font-semibold tabular-nums text-text-primary">
          {unavailable ? '—' : `${total - used}/${total}`}
        </span>
        <span className="text-xs text-text-muted">
          {unavailable ? t('me.cuti.quotaUnavailable') : t('me.cuti.remaining')}
        </span>
      </CardContent>
    </Card>
  );
}

function NewLeaveModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { t } = useI18n();
  const [type, setType] = useState('annual');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [reason, setReason] = useState('');
  /**
   * The supporting document — a doctor's note, a wedding invitation.
   *
   * The API and the `leave_requests` table have carried `attachment_id` all
   * along; there was simply no way to send one, so every row had NULL and an
   * approver had nothing to check a `sick` request against.
   */
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!startDate || !endDate) return;
    setBusy(true);
    setError(null);
    try {
      // Upload FIRST, and let a failure abort the whole submit. The reverse
      // order would create the leave request and then lose its evidence, which
      // is the worst outcome available here: the request is approvable, looks
      // complete, and silently has nothing behind it. Failing before anything
      // is created leaves the form filled in and retryable.
      const attachmentId = files[0]
        ? await uploadLeaveAttachment({ file: files[0], kind: 'leave_attachment' })
        : undefined;

      await createLeaveRequest({
        clientId: mintId(),
        type,
        startDate,
        endDate,
        reason: reason || undefined,
        attachmentId,
      });
      toast({ title: t('me.cuti.createSuccess'), variant: 'success' });
      onCreated();
    } catch (err) {
      setError(errMsg(err, t('errors.generic')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('me.cuti.newRequest')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} loading={busy} disabled={!startDate || !endDate}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Select
          label={t('me.cuti.typeLabel')}
          value={type}
          onValueChange={setType}
          options={LEAVE_TYPES.map((lt) => ({ value: lt, label: t(`me.cuti.type.${lt}`) }))}
        />
        <Input
          type="date"
          label={t('me.cuti.startDate')}
          value={startDate}
          onChange={(e) => setStartDate(e.target.value)}
          required
        />
        <Input
          type="date"
          label={t('me.cuti.endDate')}
          value={endDate}
          onChange={(e) => setEndDate(e.target.value)}
          required
        />
        <Textarea
          label={t('me.cuti.reasonLabel')}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <FileUpload
          label={t('me.cuti.attachmentLabel')}
          hint={t('me.cuti.attachmentHint')}
          accept="image/*,application/pdf"
          maxSizeMb={10}
          value={files}
          onChange={setFiles}
          disabled={busy}
        />
        {error && <p className="text-sm text-danger-600">{error}</p>}
      </div>
    </Modal>
  );
}
