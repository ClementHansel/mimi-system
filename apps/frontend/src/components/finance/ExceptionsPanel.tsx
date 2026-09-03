'use client';

import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { formatMoney } from '@/lib/formatters';
import { fmtDateTime } from '@/lib/dates';
import { toast } from '@/components/ui/Toast';
import { DataTable, type DataTableColumn } from '@/components/ui/DataTable';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { Drawer } from '@/components/ui/Drawer';
import { Textarea } from '@/components/ui/Textarea';
import { Checkbox } from '@/components/ui/Checkbox';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { ExportButton } from '@/components/common/ExportButton';
import { useApiList } from '@/components/admin/useApiList';
import type { Paginated } from '@/lib/api';
import { exceptionIoColumns } from './lib/io-columns';
import type { OfflineAuthCase } from './types';
import { errMsg } from '@/lib/api-error';

export function ExceptionsPanel() {
  const { t } = useI18n();
  const { can } = usePermissions();
  const [status, setStatus] = useState('open');
  const [cls, setCls] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const { data, loading, error, reload } = useApiList<OfflineAuthCase>('/accounting/exceptions', {
    status,
    class: cls,
    page,
    pageSize,
  });
  const [selected, setSelected] = useState<OfflineAuthCase | null>(null);

  /**
   * The queue is server-paginated (25/page by default), so "Ekspor" alone
   * would silently ship just the visible page. `pageSize=200` (the server's
   * `@Max(200)`) with a hard 200-page ceiling matches
   * `SupplierPriceHistoryPanel`'s convention — bounded so a server that
   * ignored `page` could not spin here forever, and short-circuits the moment
   * a page comes back short or the running total reaches `res.total`.
   */
  async function fetchAllExceptions(): Promise<OfflineAuthCase[]> {
    const all: OfflineAuthCase[] = [];
    const size = 200;
    for (let p = 1; p <= 200; p += 1) {
      const qs = new URLSearchParams({ page: String(p), pageSize: String(size) });
      if (status) qs.set('status', status);
      if (cls) qs.set('class', cls);
      const res = await api.get<Paginated<OfflineAuthCase>>(`/accounting/exceptions?${qs}`);
      all.push(...res.rows);
      if (res.rows.length < size || all.length >= res.total) break;
    }
    return all;
  }

  const columns: DataTableColumn<OfflineAuthCase>[] = [
    {
      key: 'class',
      header: t('finance.exceptions.columnClass'),
      render: (r) => (
        <span className="inline-flex items-center gap-1.5">
          {r.physicalEffectSuspected && (
            <AlertTriangle
              className="size-3.5 text-danger-600"
              aria-label={t('finance.exceptions.physicalEffectSuspected')}
            />
          )}
          <StatusBadge domain="offlineAuthOutcome" status={r.outcome} />
        </span>
      ),
    },
    {
      key: 'documentType',
      header: t('finance.exceptions.columnDocument'),
      render: (r) => r.documentType,
    },
    {
      key: 'amount',
      header: t('finance.exceptions.columnAmount'),
      align: 'right',
      render: (r) => formatMoney(r.amount, { cents: 'always' }),
    },
    {
      key: 'approverName',
      header: t('finance.exceptions.columnApprover'),
      render: (r) => r.approverName || '—',
    },
    {
      key: 'outletName',
      header: t('finance.exceptions.columnOutlet'),
      render: (r) => r.outletName || '—',
    },
    {
      key: 'occurredAt',
      header: t('finance.exceptions.columnOccurredAt'),
      render: (r) => fmtDateTime(r.occurredAt),
    },
    {
      key: 'verdict',
      header: t('finance.exceptions.columnVerdict'),
      render: (r) =>
        r.verdict ? (
          t(`finance.exceptions.verdict.${r.verdict}`)
        ) : (
          <span className="text-warning-700">{t('finance.exceptions.pendingVerdict')}</span>
        ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="flex flex-wrap items-end gap-2">
          <Select
            value={status}
            onValueChange={(v) => {
              setStatus(v);
              setPage(1);
            }}
            placeholder={t('finance.exceptions.filterStatusAll')}
            options={[
              { value: 'open', label: t('finance.exceptions.statusOpen') },
              { value: 'resolved', label: t('finance.exceptions.statusResolved') },
              { value: 'dismissed', label: t('finance.exceptions.statusDismissed') },
            ]}
            wrapperClassName="w-40"
          />
          <Select
            value={cls}
            onValueChange={(v) => {
              setCls(v);
              setPage(1);
            }}
            placeholder={t('finance.exceptions.filterClassAll')}
            options={[
              { value: 'offline_auth_failed', label: t('finance.exceptions.classFailed') },
              { value: 'offline_auth_unprovable', label: t('finance.exceptions.classUnprovable') },
            ]}
            wrapperClassName="w-52"
          />
        </div>
        <ExportButton
          rows={data.rows}
          columns={exceptionIoColumns(t)}
          filenameBase="antrean-pengecualian"
          fetchAll={fetchAllExceptions}
        />
      </div>

      <DataTable
        columns={columns}
        data={data}
        keyField={(r) => r.id}
        loading={loading}
        error={error}
        emptyDescription={t('finance.exceptions.empty')}
        onRowClick={(r) => setSelected(r)}
        onPageChange={setPage}
        onPageSizeChange={(n) => {
          setPageSize(n);
          setPage(1);
        }}
      />

      {selected && (
        <ExceptionDrawer
          exception={selected}
          canReview={can('sync.exception.review')}
          onClose={() => setSelected(null)}
          onChanged={reload}
        />
      )}
    </div>
  );
}

function ExceptionDrawer({
  exception,
  canReview,
  onClose,
  onChanged,
}: {
  exception: OfflineAuthCase;
  canReview: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [verdict, setVerdict] = useState<'upheld' | 'rejected'>('rejected');
  const [reason, setReason] = useState('');
  const [routeToPayroll, setRouteToPayroll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/accounting/exceptions/${exception.id}/verdict`, {
        verdict,
        reason,
        routeToPayrollDeduction: routeToPayroll,
      });
      toast({ title: t('finance.exceptions.verdictSuccess'), variant: 'success' });
      onChanged();
      onClose();
    } catch (err) {
      setError(errMsg(err, t('errors.generic')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer open onClose={onClose} title={t('finance.exceptions.detailTitle')} size="lg">
      <div className="flex flex-col gap-4">
        {exception.physicalEffectSuspected && (
          <div className="flex items-center gap-2 rounded-md border border-danger-200 bg-danger-50 p-3 text-sm font-medium text-danger-700">
            <AlertTriangle className="size-4" /> {t('finance.exceptions.physicalEffectSuspected')}
          </div>
        )}
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
          <dt className="text-text-muted">{t('finance.exceptions.columnClass')}</dt>
          <dd>
            <StatusBadge domain="offlineAuthOutcome" status={exception.outcome} />
          </dd>
          <dt className="text-text-muted">{t('finance.exceptions.columnDocument')}</dt>
          <dd className="text-text-primary">
            {exception.documentType} ({exception.documentId})
          </dd>
          <dt className="text-text-muted">{t('finance.exceptions.columnAmount')}</dt>
          <dd className="text-text-primary">
            {formatMoney(exception.amount, { cents: 'always' })}
          </dd>
          <dt className="text-text-muted">{t('finance.exceptions.columnApprover')}</dt>
          <dd className="text-text-primary">{exception.approverName || '—'}</dd>
          <dt className="text-text-muted">{t('finance.exceptions.columnDevice')}</dt>
          <dd className="text-text-primary">{exception.deviceName || '—'}</dd>
          <dt className="text-text-muted">{t('finance.exceptions.columnOutlet')}</dt>
          <dd className="text-text-primary">{exception.outletName || '—'}</dd>
          <dt className="text-text-muted">{t('finance.exceptions.columnOccurredAt')}</dt>
          <dd className="text-text-primary">{fmtDateTime(exception.occurredAt)}</dd>
          <dt className="text-text-muted">{t('finance.exceptions.columnRelayReceivedAt')}</dt>
          <dd className="text-text-primary">{fmtDateTime(exception.relayReceivedAt)}</dd>
          <dt className="text-text-muted">{t('finance.exceptions.pinAttempts')}</dt>
          <dd className="text-text-primary">{exception.evidence.pinAttempts ?? '—'}</dd>
        </dl>

        {exception.evidence.selfieUrl && (
          // Presigned object-storage URL, not a Next-optimizable local asset — a plain `<img>` is correct here.
          <img
            src={exception.evidence.selfieUrl}
            alt={t('finance.exceptions.selfieAlt')}
            className="max-h-64 rounded-md border border-border object-contain"
          />
        )}

        {exception.verdict && (
          <p className="text-sm font-medium text-text-primary">
            {t('finance.exceptions.columnVerdict')}:{' '}
            {t(`finance.exceptions.verdict.${exception.verdict}`)}
          </p>
        )}

        {!exception.verdict && canReview && (
          <section className="flex flex-col gap-3 border-t border-border pt-4">
            <h3 className="text-sm font-semibold text-text-primary">
              {t('finance.exceptions.recordVerdictTitle')}
            </h3>
            {error && <p className="text-sm text-danger-600">{error}</p>}
            <Select
              label={t('finance.exceptions.verdictLabel')}
              value={verdict}
              onValueChange={(v) => setVerdict(v as 'upheld' | 'rejected')}
              options={[
                { value: 'rejected', label: t('finance.exceptions.verdict.rejected') },
                { value: 'upheld', label: t('finance.exceptions.verdict.upheld') },
              ]}
            />
            <Textarea
              label={t('finance.exceptions.reasonLabel')}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required
            />
            {verdict === 'rejected' && exception.physicalEffectSuspected && (
              <Checkbox
                label={t('finance.exceptions.routeToPayrollDeduction')}
                checked={routeToPayroll}
                onCheckedChange={setRouteToPayroll}
              />
            )}
            <Button onClick={submit} loading={busy} disabled={!reason} className="self-start">
              {t('finance.exceptions.submitVerdict')}
            </Button>
          </section>
        )}
      </div>
    </Drawer>
  );
}
