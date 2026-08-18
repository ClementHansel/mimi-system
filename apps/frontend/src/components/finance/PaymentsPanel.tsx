'use client';

import { useEffect, useState } from 'react';
import { Plus, Upload } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { api, ApiError } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { formatMoney } from '@/lib/formatters';
import { fmtDateTime } from '@/lib/dates';
import { toast } from '@/components/ui/Toast';
import { DataTable, type DataTableColumn } from '@/components/ui/DataTable';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Drawer } from '@/components/ui/Drawer';
import { Textarea } from '@/components/ui/Textarea';
import { MoneyInput } from '@/components/ui/MoneyInput';
import { FileUpload } from '@/components/ui/FileUpload';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { PermissionGate } from '@/components/ui/PermissionGate';
import { useApiList } from '@/components/admin/useApiList';
import { uploadAttachment } from './lib/attachments';
import {
  PaymentVerificationRefType,
  PayeeType,
  type PaymentVerification,
  type Money,
} from './types';

/**
 * F07 finance — payment verification queue (FR-ACCT-01..04, CONTRACTS
 * §4.17/§5.8). The Pending -> Verified -> Paid ladder: a transfer-method
 * sale sits `pending` until Finance confirms the money actually arrived, so
 * every state transition here is one deliberate, permission-gated action —
 * never a silent status flip. `rejected` is a dead end off pending/verified.
 */
function errMsg(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

const REF_TYPE_OPTIONS = Object.values(PaymentVerificationRefType);
const PAYEE_TYPE_OPTIONS = Object.values(PayeeType);

export function PaymentsPanel() {
  const { t } = useI18n();
  const { can } = usePermissions();

  const [status, setStatus] = useState('');
  const [refType, setRefType] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const { data, loading, error, reload } = useApiList<PaymentVerification>('/accounting/payments', {
    status,
    refType,
    page,
    pageSize,
  });

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const columns: DataTableColumn<PaymentVerification>[] = [
    { key: 'pvNumber', header: t('finance.payments.columnNumber') },
    {
      key: 'refType',
      header: t('finance.payments.columnRefType'),
      render: (r) => t(`finance.refType.${r.refType}`),
    },
    {
      key: 'payeeName',
      header: t('finance.payments.columnPayee'),
      render: (r) => r.payeeName ?? '—',
    },
    {
      key: 'amount',
      header: t('finance.payments.columnAmount'),
      align: 'right',
      render: (r) => formatMoney(r.amount, { cents: 'always' }),
    },
    {
      key: 'status',
      header: t('finance.payments.columnStatus'),
      render: (r) => <StatusBadge domain="payment" status={r.status} />,
    },
    {
      key: 'locationName',
      header: t('finance.payments.columnLocation'),
      render: (r) => r.locationName ?? '—',
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-2">
          <Select
            value={status}
            onValueChange={(v) => {
              setStatus(v);
              setPage(1);
            }}
            placeholder={t('finance.payments.filterStatusAll')}
            options={[
              { value: 'pending', label: t('finance.payments.statusPending') },
              { value: 'verified', label: t('finance.payments.statusVerified') },
              { value: 'paid', label: t('finance.payments.statusPaid') },
              { value: 'rejected', label: t('finance.payments.statusRejected') },
            ]}
            wrapperClassName="w-44"
          />
          <Select
            value={refType}
            onValueChange={(v) => {
              setRefType(v);
              setPage(1);
            }}
            placeholder={t('finance.payments.filterRefTypeAll')}
            options={REF_TYPE_OPTIONS.map((v) => ({ value: v, label: t(`finance.refType.${v}`) }))}
            wrapperClassName="w-56"
          />
        </div>
        <PermissionGate permission="payment.proof.upload">
          <Button leftIcon={<Plus className="size-4" />} onClick={() => setCreateOpen(true)}>
            {t('finance.payments.createButton')}
          </Button>
        </PermissionGate>
      </div>

      <DataTable
        columns={columns}
        data={data}
        keyField={(r) => r.id}
        loading={loading}
        error={error}
        emptyDescription={t('finance.payments.empty')}
        onRowClick={(r) => setSelectedId(r.id)}
        onPageChange={setPage}
        onPageSizeChange={(n) => {
          setPageSize(n);
          setPage(1);
        }}
      />

      {createOpen && (
        <CreatePaymentModal
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            reload();
            toast({ title: t('finance.payments.createSuccess'), variant: 'success' });
          }}
        />
      )}

      {selectedId && (
        <PaymentDrawer
          id={selectedId}
          canUploadProof={can('payment.proof.upload')}
          canVerify={can('payment.verify')}
          canPay={can('payment.pay')}
          canReject={can('payment.reject')}
          onClose={() => setSelectedId(null)}
          onChanged={reload}
        />
      )}
    </div>
  );
}

function CreatePaymentModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useI18n();
  const [refType, setRefType] = useState<string>(PaymentVerificationRefType.OTHER);
  const [payeeType, setPayeeType] = useState<string>(PayeeType.OTHER);
  const [amount, setAmount] = useState<Money | null>(null);
  const [referenceNumber, setReferenceNumber] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      await api.post('/accounting/payments', {
        refType,
        payeeType,
        amount: amount ?? '0.00',
        referenceNumber: referenceNumber || undefined,
        notes: notes || undefined,
      });
      onCreated();
    } catch (err) {
      setError(errMsg(err, t('auth.genericError')));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('finance.payments.createTitle')}
      description={t('finance.payments.createDescription')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} loading={submitting} disabled={!amount || amount === '0.00'}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error && <p className="text-sm text-danger-600">{error}</p>}
        <Select
          label={t('finance.payments.refType')}
          value={refType}
          onValueChange={setRefType}
          options={REF_TYPE_OPTIONS.map((v) => ({ value: v, label: t(`finance.refType.${v}`) }))}
        />
        <Select
          label={t('finance.payments.payeeType')}
          value={payeeType}
          onValueChange={setPayeeType}
          options={PAYEE_TYPE_OPTIONS.map((v) => ({
            value: v,
            label: t(`finance.payeeType.${v}`),
          }))}
        />
        <MoneyInput
          label={t('finance.payments.amount')}
          value={amount}
          onChange={setAmount}
          required
        />
        <Input
          label={t('finance.payments.referenceNumber')}
          value={referenceNumber}
          onChange={(e) => setReferenceNumber(e.target.value)}
        />
        <Textarea
          label={t('finance.payments.notes')}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>
    </Modal>
  );
}

function PaymentDrawer({
  id,
  canUploadProof,
  canVerify,
  canPay,
  canReject,
  onClose,
  onChanged,
}: {
  id: string;
  canUploadProof: boolean;
  canVerify: boolean;
  canPay: boolean;
  canReject: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [pv, setPv] = useState<(PaymentVerification & { history: unknown[] }) | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [proofFiles, setProofFiles] = useState<File[]>([]);
  const [referenceNumber, setReferenceNumber] = useState('');
  const [verifyNote, setVerifyNote] = useState('');
  const [paidVia, setPaidVia] = useState<'cash' | 'bank_transfer' | 'qris'>('bank_transfer');
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');

  function load() {
    setLoading(true);
    api
      .get<PaymentVerification & { history: unknown[] }>(`/accounting/payments/${id}`)
      .then((row) => {
        setPv(row);
        setReferenceNumber(row.referenceNumber ?? '');
      })
      .catch((err) => setError(errMsg(err, t('auth.genericError'))))
      .finally(() => setLoading(false));
  }
  useEffect(load, [id]);

  async function doUploadProof() {
    const file = proofFiles[0];
    if (!file) return;
    setBusy('proof');
    setError(null);
    try {
      const attachmentId = await uploadAttachment({
        file,
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        kind: 'payment_proof',
        entityType: 'payment_verification',
        entityId: id,
      });
      await api.post(`/accounting/payments/${id}/proof`, {
        proofAttachmentId: attachmentId,
        referenceNumber: referenceNumber || undefined,
      });
      toast({ title: t('finance.payments.proofUploadSuccess'), variant: 'success' });
      setProofFiles([]);
      load();
      onChanged();
    } catch (err) {
      setError(errMsg(err, t('auth.genericError')));
    } finally {
      setBusy(null);
    }
  }

  async function doVerify() {
    setBusy('verify');
    setError(null);
    try {
      await api.post(`/accounting/payments/${id}/verify`, { note: verifyNote || undefined });
      toast({ title: t('finance.payments.verifySuccess'), variant: 'success' });
      load();
      onChanged();
    } catch (err) {
      setError(errMsg(err, t('auth.genericError')));
    } finally {
      setBusy(null);
    }
  }

  async function doPay() {
    setBusy('pay');
    setError(null);
    try {
      await api.post(`/accounting/payments/${id}/pay`, { paidVia });
      toast({ title: t('finance.payments.paySuccess'), variant: 'success' });
      load();
      onChanged();
    } catch (err) {
      setError(errMsg(err, t('auth.genericError')));
    } finally {
      setBusy(null);
    }
  }

  async function doReject() {
    setBusy('reject');
    setError(null);
    try {
      await api.post(`/accounting/payments/${id}/reject`, { reason: rejectReason });
      toast({ title: t('finance.payments.rejectSuccess'), variant: 'success' });
      setRejectOpen(false);
      load();
      onChanged();
    } catch (err) {
      setError(errMsg(err, t('auth.genericError')));
      setBusy(null);
    }
  }

  return (
    <Drawer
      open
      onClose={onClose}
      title={pv?.pvNumber ?? t('finance.payments.detailTitle')}
      size="lg"
    >
      {loading || !pv ? (
        <p className="text-sm text-text-muted">{t('common.loading')}</p>
      ) : (
        <div className="flex flex-col gap-6">
          {error && <p className="text-sm text-danger-600">{error}</p>}

          <section className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <StatusBadge domain="payment" status={pv.status} size="md" />
              <span className="text-lg font-semibold tabular-nums text-text-primary">
                {formatMoney(pv.amount, { cents: 'always' })}
              </span>
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-text-muted">{t('finance.payments.refType')}</dt>
              <dd className="text-text-primary">{t(`finance.refType.${pv.refType}`)}</dd>
              <dt className="text-text-muted">{t('finance.payments.columnPayee')}</dt>
              <dd className="text-text-primary">{pv.payeeName ?? '—'}</dd>
              <dt className="text-text-muted">{t('finance.payments.columnLocation')}</dt>
              <dd className="text-text-primary">{pv.locationName ?? '—'}</dd>
              <dt className="text-text-muted">{t('finance.payments.referenceNumber')}</dt>
              <dd className="text-text-primary">{pv.referenceNumber ?? '—'}</dd>
              <dt className="text-text-muted">{t('finance.payments.verifiedAt')}</dt>
              <dd className="text-text-primary">
                {pv.verifiedBy ? `${fmtDateTime(pv.verifiedAt)}` : '—'}
              </dd>
              <dt className="text-text-muted">{t('finance.payments.paidAt')}</dt>
              <dd className="text-text-primary">
                {pv.paidBy ? `${fmtDateTime(pv.paidAt)} (${pv.paidVia})` : '—'}
              </dd>
            </dl>
            {pv.proofUrl && (
              <a
                href={pv.proofUrl}
                target="_blank"
                rel="noreferrer"
                className="text-sm font-medium text-brand-600 hover:underline"
              >
                {t('finance.payments.viewProof')}
              </a>
            )}
          </section>

          {pv.status === 'pending' && canUploadProof && (
            <section className="flex flex-col gap-3 border-t border-border pt-4">
              <h3 className="text-sm font-semibold text-text-primary">
                {t('finance.payments.uploadProofTitle')}
              </h3>
              <Input
                label={t('finance.payments.referenceNumber')}
                value={referenceNumber}
                onChange={(e) => setReferenceNumber(e.target.value)}
              />
              <FileUpload
                label={t('finance.payments.proofFile')}
                accept="image/*,application/pdf"
                value={proofFiles}
                onChange={setProofFiles}
              />
              <Button
                size="sm"
                leftIcon={<Upload className="size-4" />}
                onClick={doUploadProof}
                loading={busy === 'proof'}
                disabled={proofFiles.length === 0}
                className="self-start"
              >
                {t('finance.payments.uploadProofButton')}
              </Button>
            </section>
          )}

          {pv.status === 'pending' && canVerify && (
            <section className="flex flex-col gap-2 border-t border-border pt-4">
              <h3 className="text-sm font-semibold text-text-primary">
                {t('finance.payments.verifyTitle')}
              </h3>
              <Textarea
                label={t('finance.payments.verifyNote')}
                value={verifyNote}
                onChange={(e) => setVerifyNote(e.target.value)}
              />
              <Button
                size="sm"
                onClick={doVerify}
                loading={busy === 'verify'}
                disabled={!pv.proofUrl}
                className="self-start"
              >
                {t('finance.payments.verifyButton')}
              </Button>
              {!pv.proofUrl && (
                <p className="text-xs text-text-muted">{t('finance.payments.proofRequiredHint')}</p>
              )}
            </section>
          )}

          {pv.status === 'verified' && canPay && (
            <section className="flex flex-col gap-2 border-t border-border pt-4">
              <h3 className="text-sm font-semibold text-text-primary">
                {t('finance.payments.payTitle')}
              </h3>
              <Select
                label={t('finance.payments.paidVia')}
                value={paidVia}
                onValueChange={(v) => setPaidVia(v as typeof paidVia)}
                options={[
                  { value: 'cash', label: t('finance.payments.paidViaCash') },
                  { value: 'bank_transfer', label: t('finance.payments.paidViaBankTransfer') },
                  { value: 'qris', label: t('finance.payments.paidViaQris') },
                ]}
              />
              <Button size="sm" onClick={doPay} loading={busy === 'pay'} className="self-start">
                {t('finance.payments.payButton')}
              </Button>
            </section>
          )}

          {(pv.status === 'pending' || pv.status === 'verified') && canReject && (
            <section className="flex flex-col gap-2 border-t border-border pt-4">
              <Button
                variant="danger"
                size="sm"
                onClick={() => setRejectOpen(true)}
                className="self-start"
              >
                {t('finance.payments.rejectButton')}
              </Button>
            </section>
          )}
        </div>
      )}

      {rejectOpen && (
        <Modal
          open
          onClose={() => setRejectOpen(false)}
          title={t('finance.payments.rejectTitle')}
          footer={
            <>
              <Button variant="outline" onClick={() => setRejectOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="danger"
                onClick={doReject}
                loading={busy === 'reject'}
                disabled={!rejectReason}
              >
                {t('finance.payments.rejectButton')}
              </Button>
            </>
          }
        >
          <Textarea
            label={t('finance.payments.rejectReason')}
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            required
          />
        </Modal>
      )}
    </Drawer>
  );
}
