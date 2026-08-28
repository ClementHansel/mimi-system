'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { VoucherBatchStatus, VoucherType } from '@/lib/shared-types';
import { fmtDate } from '@/lib/dates';
import { formatMoney } from '@/lib/formatters';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import { PermissionGate } from '@/components/ui/PermissionGate';
import { DataTable, type DataTableColumn } from '@/components/ui/DataTable';
import { toast } from '@/components/ui/Toast';
import { useApiList } from '@/components/admin/useApiList';
import { VoucherBatchModal } from './VoucherBatchModal';
import { VoucherBatchDrawer } from './VoucherBatchDrawer';
import type { VoucherBatch } from './types';

const BATCH_STATUS_VARIANT: Record<VoucherBatchStatus, 'neutral' | 'success' | 'default'> = {
  [VoucherBatchStatus.Draft]: 'neutral',
  [VoucherBatchStatus.Issued]: 'success',
  [VoucherBatchStatus.Closed]: 'default',
};

/**
 * The batch list — one row per print run, not per code. Individual codes
 * (issued/redeemed/void) live one level down, in `VoucherBatchDrawer`'s own
 * table, the same "list of the parent, drawer holds the children" shape
 * `PurchaseOrdersPanel`/`OrderDrawer` and `SuratJalanDetailDrawer` use.
 *
 * `value`'s DISPLAY is type-dependent (money for fixed, a bare percent for
 * percentage) but never runs the string through `Number()`/`parseFloat` to
 * get there — `formatMoney` does its own string-slicing formatting, and the
 * percentage is already the canonical `'10.00'`-style display string
 * (`VoucherRules.value`'s own comment), so appending `%` is the entire job.
 */
export function VoucherBatchesPanel() {
  const { t } = useI18n();
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const { data, loading, error, reload } = useApiList<VoucherBatch>('/vouchers/batches', {
    status,
    page,
    pageSize,
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const columns: DataTableColumn<VoucherBatch>[] = [
    { key: 'name', header: t('voucher.columnName') },
    {
      key: 'code',
      header: t('voucher.columnCode'),
      render: (r) => <span className="font-mono text-sm">{r.code}</span>,
    },
    { key: 'type', header: t('voucher.columnType'), render: (r) => t(`voucher.type.${r.type}`) },
    {
      key: 'value',
      header: t('voucher.columnValue'),
      align: 'right',
      render: (r) => (r.type === VoucherType.Fixed ? formatMoney(r.value) : `${r.value}%`),
    },
    {
      key: 'validity',
      header: t('voucher.columnValidity'),
      render: (r) =>
        t('voucher.validityRange', { from: fmtDate(r.validFrom), until: fmtDate(r.validUntil) }),
    },
    { key: 'issuedCount', header: t('voucher.columnIssued'), align: 'right' },
    { key: 'redeemedCount', header: t('voucher.columnRedeemed'), align: 'right' },
    {
      key: 'status',
      header: t('voucher.columnStatus'),
      render: (r) => (
        <Badge variant={BATCH_STATUS_VARIANT[r.status]} size="sm">
          {t(`voucher.batchStatus.${r.status}`)}
        </Badge>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Select
          value={status}
          onValueChange={(v) => {
            setStatus(v);
            setPage(1);
          }}
          placeholder={t('voucher.filterStatusAll')}
          options={Object.values(VoucherBatchStatus).map((v) => ({
            value: v,
            label: t(`voucher.batchStatus.${v}`),
          }))}
          wrapperClassName="w-48"
        />
        <PermissionGate permission="voucher.manage">
          <Button leftIcon={<Plus className="size-4" />} onClick={() => setCreateOpen(true)}>
            {t('voucher.createButton')}
          </Button>
        </PermissionGate>
      </div>

      <DataTable
        columns={columns}
        data={data}
        keyField={(r) => r.id}
        loading={loading}
        error={error}
        emptyDescription={t('voucher.empty')}
        onRowClick={(r) => setSelectedId(r.id)}
        onPageChange={setPage}
        onPageSizeChange={(n) => {
          setPageSize(n);
          setPage(1);
        }}
      />

      {createOpen && (
        <VoucherBatchModal
          batch={null}
          onClose={() => setCreateOpen(false)}
          onSaved={() => {
            setCreateOpen(false);
            reload();
            toast({ title: t('voucher.createSuccess'), variant: 'success' });
          }}
        />
      )}

      {selectedId && (
        <VoucherBatchDrawer
          id={selectedId}
          onClose={() => setSelectedId(null)}
          onChanged={reload}
        />
      )}
    </div>
  );
}
