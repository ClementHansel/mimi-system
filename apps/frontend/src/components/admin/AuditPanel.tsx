'use client';

import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { fmtDateTime } from '@/lib/dates';
import { DataTable, type DataTableColumn } from '@/components/ui/DataTable';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Badge } from '@/components/ui/Badge';
import { DateRangePicker, type DateRangeValue } from '@/components/ui/DateRangePicker';
import { useApiList } from './useApiList';
import { roleLabel } from './roleRank';
import type { AuditRow } from './types';

/**
 * F10 admin — Audit trail viewer (CONTRACTS §4.0 `GET /api/audit`,
 * FR-AUDIT-01/02). A fraud-control surface: filters answer "who changed
 * what, when, why", and the detail view puts before/after side by side so a
 * reviewer doesn't have to mentally diff two JSON blobs.
 */
export function AuditPanel() {
  const { t } = useI18n();
  const [entityType, setEntityType] = useState('');
  const [entityId, setEntityId] = useState('');
  const [userId, setUserId] = useState('');
  const [module, setModule] = useState('');
  const [range, setRange] = useState<DateRangeValue>({ from: null, to: null });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [detail, setDetail] = useState<AuditRow | null>(null);

  const { data, loading, error } = useApiList<AuditRow>('/audit', {
    entityType, entityId, userId, module, from: range.from ?? undefined, to: range.to ?? undefined, page, pageSize,
  });

  const columns: DataTableColumn<AuditRow>[] = [
    { key: 'occurredAt', header: t('admin.audit.columnWhen'), sortable: true, render: (r) => fmtDateTime(r.occurredAt) },
    { key: 'userName', header: t('admin.audit.columnUser'), render: (r) => `${r.userName ?? '—'} (${roleLabel(r.roleKey)})` },
    { key: 'module', header: t('admin.audit.columnModule') },
    { key: 'action', header: t('admin.audit.columnAction') },
    {
      key: 'entityType',
      header: t('admin.audit.columnEntity'),
      // `audit_log.entity_id` is NULLABLE and genuinely null in practice — of the
      // rows on the deployed system, most carry no entity id (a login, say, has
      // no target row). Calling `.slice()` on that null threw a TypeError during
      // render, which React escalated into "Application error: a client-side
      // exception has occurred" — the WHOLE Jejak Audit page went blank rather
      // than one cell rendering oddly. Guard it, and never assume a nullable
      // column is populated just because the happy-path row has it.
      render: (r) => (r.entityId ? `${r.entityType} · ${r.entityId.slice(0, 8)}` : r.entityType),
    },
    { key: 'reason', header: t('admin.audit.columnReason'), render: (r) => r.reason ?? t('admin.audit.noReason') },
    {
      key: 'offlineAuthorized', header: t('admin.audit.columnOffline'),
      render: (r) => r.offlineAuthorized ? <Badge variant="warning" size="sm">{t('admin.audit.offlineAuthorized')}</Badge> : null,
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-2">
        <Input label={t('admin.audit.filterEntityType')} value={entityType} onChange={(e) => { setEntityType(e.target.value); setPage(1); }} wrapperClassName="w-40" />
        <Input label={t('admin.audit.filterEntityId')} value={entityId} onChange={(e) => { setEntityId(e.target.value); setPage(1); }} wrapperClassName="w-48" />
        <Input label={t('admin.audit.filterUser')} value={userId} onChange={(e) => { setUserId(e.target.value); setPage(1); }} wrapperClassName="w-40" />
        <Input label={t('admin.audit.filterModule')} value={module} onChange={(e) => { setModule(e.target.value); setPage(1); }} wrapperClassName="w-40" />
        <DateRangePicker value={range} onChange={(v) => { setRange(v); setPage(1); }} />
      </div>
      <DataTable
        columns={columns} data={data} keyField={(r) => r.id} loading={loading} error={error}
        emptyDescription={t('admin.audit.empty')}
        onRowClick={(r) => setDetail(r)}
        onPageChange={setPage} onPageSizeChange={(n) => { setPageSize(n); setPage(1); }}
      />
      {detail && (
        <Modal open onClose={() => setDetail(null)} title={t('admin.audit.detailTitle')} size="xl">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <h4 className="mb-1 text-sm font-semibold text-text-primary">{t('admin.audit.before')}</h4>
              <pre className="max-h-96 overflow-auto rounded-md bg-surface-sunken p-3 text-xs">
                {detail.beforeValue ? JSON.stringify(detail.beforeValue, null, 2) : t('admin.audit.noValue')}
              </pre>
            </div>
            <div>
              <h4 className="mb-1 text-sm font-semibold text-text-primary">{t('admin.audit.after')}</h4>
              <pre className="max-h-96 overflow-auto rounded-md bg-surface-sunken p-3 text-xs">
                {detail.afterValue ? JSON.stringify(detail.afterValue, null, 2) : t('admin.audit.noValue')}
              </pre>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
