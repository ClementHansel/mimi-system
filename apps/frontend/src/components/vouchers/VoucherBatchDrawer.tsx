'use client';

import { useEffect, useState } from 'react';
import { Printer } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { ApiError } from '@/lib/api';
import { VoucherBatchStatus, VoucherStatus, VoucherType } from '@/lib/shared-types';
import { fmtDate, fmtDateTime } from '@/lib/dates';
import { formatMoney } from '@/lib/formatters';
import { Drawer } from '@/components/ui/Drawer';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/ui/EmptyState';
import { PermissionGate } from '@/components/ui/PermissionGate';
import { DataTable, type DataTableColumn } from '@/components/ui/DataTable';
import { toast } from '@/components/ui/Toast';
import { useApiList } from '@/components/admin/useApiList';
import { getVoucherBatch, issueVoucherBatch, closeVoucherBatch, voidVoucher } from './voucher-api';
import { VoucherBatchModal } from './VoucherBatchModal';
import type { VoucherBatch, Voucher } from './types';

function errMsg(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/** `success` for active, `neutral` for the terminal/void states — same flat tone table StatusBadge uses, hand-picked here since neither `VoucherStatus` nor `VoucherBatchStatus` has a `StatusBadge` domain of its own (see this file's report notes). */
const BATCH_STATUS_VARIANT: Record<VoucherBatchStatus, 'neutral' | 'success' | 'default'> = {
  [VoucherBatchStatus.Draft]: 'neutral',
  [VoucherBatchStatus.Issued]: 'success',
  [VoucherBatchStatus.Closed]: 'default',
};

const VOUCHER_STATUS_VARIANT: Record<VoucherStatus, 'success' | 'default' | 'danger'> = {
  [VoucherStatus.Active]: 'success',
  [VoucherStatus.Redeemed]: 'default',
  [VoucherStatus.Void]: 'danger',
};

/**
 * Batch detail — summary, the batch's lifecycle actions, and the codes it
 * has issued so far.
 *
 * Mirrors `SuratJalanDetailDrawer`'s shape: a summary section, a
 * status-gated action row, then a table of the batch's children. The print
 * link is copied VERBATIM from that drawer's idiom (plain `<a>` wrapping an
 * outline `Button`, `target="_blank"`) rather than an `onClick` navigation —
 * printing must open in a new tab so the operator keeps this drawer open
 * while the print view renders.
 */
export function VoucherBatchDrawer({
  id,
  onClose,
  onChanged,
}: {
  id: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [batch, setBatch] = useState<VoucherBatch | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [editOpen, setEditOpen] = useState(false);
  const [issueOpen, setIssueOpen] = useState(false);
  const [issueQty, setIssueQty] = useState('');
  const [closeOpen, setCloseOpen] = useState(false);
  const [voidTarget, setVoidTarget] = useState<Voucher | null>(null);

  const [vPage, setVPage] = useState(1);
  const [vPageSize, setVPageSize] = useState(25);
  const {
    data: vouchers,
    loading: vLoading,
    error: vError,
    reload: reloadVouchers,
  } = useApiList<Voucher>(`/vouchers/batches/${id}/vouchers`, { page: vPage, pageSize: vPageSize });

  function load() {
    setLoading(true);
    setLoadError(null);
    getVoucherBatch(id)
      .then(setBatch)
      .catch((err: unknown) => setLoadError(errMsg(err, t('auth.genericError'))))
      .finally(() => setLoading(false));
  }
  useEffect(load, [id]);

  async function doIssue() {
    // Quantity is a plain issue count, not a wire decimal — `Number()` is
    // correct here (unlike Money/Qty/Temp, D-10 does not apply to a count).
    const n = Number(issueQty);
    if (!Number.isInteger(n) || n <= 0) {
      toast({ title: t('validation.required'), variant: 'warning' });
      return;
    }
    setBusy('issue');
    try {
      const res = await issueVoucherBatch(id, n);
      toast({ title: t('voucher.issueSuccess', { count: res.issued }), variant: 'success' });
      setIssueOpen(false);
      setIssueQty('');
      load();
      reloadVouchers();
      onChanged();
    } catch (err) {
      toast({ title: errMsg(err, t('auth.genericError')), variant: 'danger' });
    } finally {
      setBusy(null);
    }
  }

  async function doClose() {
    setBusy('close');
    try {
      await closeVoucherBatch(id);
      toast({ title: t('voucher.closeSuccess'), variant: 'success' });
      setCloseOpen(false);
      load();
      onChanged();
    } catch (err) {
      toast({ title: errMsg(err, t('auth.genericError')), variant: 'danger' });
    } finally {
      setBusy(null);
    }
  }

  async function doVoid() {
    if (!voidTarget) return;
    setBusy('void');
    try {
      await voidVoucher(voidTarget.id);
      toast({ title: t('voucher.voidSuccess'), variant: 'success' });
      setVoidTarget(null);
      load();
      reloadVouchers();
      onChanged();
    } catch (err) {
      toast({ title: errMsg(err, t('auth.genericError')), variant: 'danger' });
    } finally {
      setBusy(null);
    }
  }

  const voucherColumns: DataTableColumn<Voucher>[] = [
    {
      key: 'code',
      header: t('voucher.columnVoucherCode'),
      render: (v) => <span className="font-mono">{v.code}</span>,
    },
    {
      key: 'status',
      header: t('voucher.columnVoucherStatus'),
      render: (v) => (
        <Badge variant={VOUCHER_STATUS_VARIANT[v.status]} size="sm">
          {t(`voucher.status.${v.status}`)}
        </Badge>
      ),
    },
    {
      key: 'redeemedAt',
      header: t('voucher.columnRedeemedAt'),
      render: (v) => (v.redeemedAt ? fmtDateTime(v.redeemedAt) : '—'),
    },
    {
      key: 'id',
      header: '',
      render: (v) => (
        <PermissionGate permission="voucher.manage">
          {v.status === VoucherStatus.Active && (
            <div className="flex justify-end">
              <Button size="sm" variant="ghost" onClick={() => setVoidTarget(v)}>
                {t('voucher.voidButton')}
              </Button>
            </div>
          )}
        </PermissionGate>
      ),
    },
  ];

  return (
    <Drawer open onClose={onClose} title={batch?.name ?? t('voucher.detailTitle')} size="lg">
      {loading ? (
        <p className="text-sm text-text-muted">{t('common.loading')}</p>
      ) : loadError || !batch ? (
        <EmptyState title={loadError ?? t('table.error')} size="sm" />
      ) : (
        <div className="flex flex-col gap-6">
          <section className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Badge variant={BATCH_STATUS_VARIANT[batch.status]} size="md">
                {t(`voucher.batchStatus.${batch.status}`)}
              </Badge>
              <span className="font-mono text-sm text-text-muted">{batch.code}</span>
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-text-muted">{t('voucher.columnType')}</dt>
              <dd className="text-text-primary">{t(`voucher.type.${batch.type}`)}</dd>
              <dt className="text-text-muted">{t('voucher.value')}</dt>
              <dd className="text-text-primary">
                {batch.type === VoucherType.Fixed ? formatMoney(batch.value) : `${batch.value}%`}
              </dd>
              <dt className="text-text-muted">{t('voucher.minSubtotal')}</dt>
              <dd className="text-text-primary">{formatMoney(batch.minSubtotal)}</dd>
              {batch.type === VoucherType.Percentage && (
                <>
                  <dt className="text-text-muted">{t('voucher.maxDiscount')}</dt>
                  <dd className="text-text-primary">
                    {batch.maxDiscount ? formatMoney(batch.maxDiscount) : '—'}
                  </dd>
                </>
              )}
              <dt className="text-text-muted">{t('voucher.columnValidity')}</dt>
              <dd className="text-text-primary">
                {t('voucher.validityRange', {
                  from: fmtDate(batch.validFrom),
                  until: fmtDate(batch.validUntil),
                })}
              </dd>
              <dt className="text-text-muted">{t('voucher.columnIssued')}</dt>
              <dd className="text-text-primary">{batch.issuedCount}</dd>
              <dt className="text-text-muted">{t('voucher.columnRedeemed')}</dt>
              <dd className="text-text-primary">{batch.redeemedCount}</dd>
              <dt className="text-text-muted">{t('voucher.locationsLabel')}</dt>
              <dd className="text-text-primary">
                {batch.locationIds === null
                  ? t('voucher.allOutlets')
                  : t('voucher.locationsCount', { count: batch.locationIds.length })}
              </dd>
              {batch.terms && (
                <>
                  <dt className="text-text-muted">{t('voucher.terms')}</dt>
                  <dd className="text-text-primary">{batch.terms}</dd>
                </>
              )}
            </dl>
          </section>

          <section className="flex flex-wrap gap-2 border-t border-border pt-4">
            <PermissionGate permission="voucher.manage">
              {batch.status === VoucherBatchStatus.Draft && (
                <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
                  {t('common.edit')}
                </Button>
              )}
            </PermissionGate>
            <PermissionGate permission="voucher.issue">
              {batch.status !== VoucherBatchStatus.Closed && (
                <Button size="sm" onClick={() => setIssueOpen(true)}>
                  {t('voucher.issueButton')}
                </Button>
              )}
            </PermissionGate>
            <PermissionGate permission="voucher.manage">
              {batch.status === VoucherBatchStatus.Issued && (
                <Button size="sm" variant="outline" onClick={() => setCloseOpen(true)}>
                  {t('voucher.closeButton')}
                </Button>
              )}
            </PermissionGate>
            {/*
              Printing, like the Surat Jalan idiom this is copied from, is
              available whenever the drawer is open (anyone who can read this
              batch already passed the drawer's own gate) rather than tied to
              a status — a draft batch's proof sheet and a closed batch's
              record are both legitimate things to print.
            */}
            <a href={`/print/voucher/${id}`} target="_blank" rel="noreferrer">
              <Button variant="outline" size="sm" leftIcon={<Printer className="size-4" />}>
                {t('voucher.printButton')}
              </Button>
            </a>
          </section>

          <section className="flex flex-col gap-3 border-t border-border pt-4">
            <h3 className="text-sm font-semibold text-text-primary">{t('voucher.codesTitle')}</h3>
            <DataTable
              columns={voucherColumns}
              data={vouchers}
              keyField={(v) => v.id}
              loading={vLoading}
              error={vError}
              emptyDescription={t('voucher.codesEmpty')}
              onPageChange={setVPage}
              onPageSizeChange={(n) => {
                setVPageSize(n);
                setVPage(1);
              }}
            />
          </section>
        </div>
      )}

      {editOpen && batch && (
        <VoucherBatchModal
          batch={batch}
          onClose={() => setEditOpen(false)}
          onSaved={() => {
            setEditOpen(false);
            load();
            onChanged();
          }}
        />
      )}

      <Modal
        open={issueOpen}
        onClose={() => setIssueOpen(false)}
        title={t('voucher.issueTitle')}
        footer={
          <>
            <Button variant="outline" onClick={() => setIssueOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={doIssue} loading={busy === 'issue'}>
              {t('voucher.issueButton')}
            </Button>
          </>
        }
      >
        <Input
          label={t('voucher.issueQuantity')}
          type="number"
          min={1}
          step={1}
          value={issueQty}
          onChange={(e) => setIssueQty(e.target.value)}
          required
        />
      </Modal>

      <Modal
        open={closeOpen}
        onClose={() => setCloseOpen(false)}
        title={t('voucher.closeTitle')}
        footer={
          <>
            <Button variant="outline" onClick={() => setCloseOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" onClick={doClose} loading={busy === 'close'}>
              {t('voucher.closeButton')}
            </Button>
          </>
        }
      >
        <p className="text-sm text-text-secondary">{t('voucher.closeConfirm')}</p>
      </Modal>

      <Modal
        open={!!voidTarget}
        onClose={() => setVoidTarget(null)}
        title={t('voucher.voidConfirmTitle')}
        footer={
          <>
            <Button variant="outline" onClick={() => setVoidTarget(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" onClick={doVoid} loading={busy === 'void'}>
              {t('voucher.voidButton')}
            </Button>
          </>
        }
      >
        <p className="text-sm text-text-secondary">
          {voidTarget && t('voucher.voidConfirm', { code: voidTarget.code })}
        </p>
      </Modal>
    </Drawer>
  );
}
