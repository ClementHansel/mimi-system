'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { DataTable, Select, toast } from '@/components/ui';
import type { DataTableColumn } from '@/components/ui';
import { formatMoney } from '@/lib/formatters';
import { fmtDateTime, fmtRelative } from '@/lib/dates';
import { ApprovalDocumentType, type Paginated } from '@/lib/shared-types';
import { getPendingApprovals } from './lib/approvals-api';
import { documentTypeConfig } from './lib/document-types';
import type { PendingApprovalRow } from './lib/types';

const PAGE_SIZE = 20;

/**
 * `GET /api/approvals/pending` (CONTRACTS §4.0) — already filtered server-side
 * to the caller's role + location (kernel `ApprovalService.getPending`,
 * `resolveEligibleRoles` + RLS location scope), so every row in this table is
 * a document THIS user can act on right now. The morning-clear screen the
 * brief asks for: type, number, requester, location, amount, and how long
 * it's been waiting (`fmtRelative`) — grouped/filterable by `documentType`.
 */
export function ApprovalsInboxPanel() {
  const { t } = useI18n();
  const router = useRouter();
  const [documentType, setDocumentType] = useState<string>('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Paginated<PendingApprovalRow>>({ rows: [], total: 0, page: 1, pageSize: PAGE_SIZE });
  const [loading, setLoading] = useState(true);

  function reload() {
    setLoading(true);
    getPendingApprovals({ documentType: documentType || undefined, page, pageSize: PAGE_SIZE })
      .then(setData)
      .catch(() => toast({ title: t('table.error'), variant: 'danger' }))
      .finally(() => setLoading(false));
  }

  useEffect(reload, [documentType, page]);

  const typeOptions = [
    { value: '', label: t('approvalsInbox.allTypes') },
    ...Object.values(ApprovalDocumentType).map((dt) => ({
      value: dt,
      label: t(documentTypeConfig(dt)?.labelKey ?? dt),
    })),
  ];

  const columns: DataTableColumn<PendingApprovalRow>[] = [
    {
      key: 'documentType',
      header: t('approvalsInbox.type'),
      render: (r) => t(documentTypeConfig(r.documentType)?.labelKey ?? r.documentType),
    },
    {
      key: 'documentNumber',
      header: t('approvalsInbox.number'),
      render: (r) => r.documentNumber ?? `#${r.documentId.slice(0, 8)}`,
    },
    { key: 'requestedBy', header: t('approvalsInbox.requestedBy') },
    { key: 'locationName', header: t('approvalsInbox.location'), render: (r) => r.locationName ?? '—' },
    { key: 'amount', header: t('approvalsInbox.amount'), align: 'right', render: (r) => formatMoney(r.amount) },
    {
      key: 'requestedAt',
      header: t('approvalsInbox.waiting'),
      render: (r) => (
        <span title={fmtDateTime(r.requestedAt)}>{fmtRelative(r.requestedAt)}</span>
      ),
    },
    { key: 'stepNo', header: t('approvalsInbox.step'), align: 'center', render: (r) => r.stepNo },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <Select
          label={t('approvalsInbox.filterByType')}
          value={documentType}
          onValueChange={(v) => {
            setDocumentType(v);
            setPage(1);
          }}
          options={typeOptions}
          wrapperClassName="w-64"
        />
      </div>

      <DataTable
        columns={columns}
        data={data}
        keyField={(r) => r.approvalId}
        loading={loading}
        onRowClick={(r) => router.push(`/approvals/${r.documentType}/${r.documentId}`)}
        onPageChange={setPage}
        emptyTitle={t('approvalsInbox.emptyTitle')}
        emptyDescription={t('approvalsInbox.emptyDescription')}
      />
    </div>
  );
}
