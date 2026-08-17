'use client';

import { useEffect, useState } from 'react';
import { Plus, AlertTriangle } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import {
  Button, Card, CardContent, Modal, DataTable, StatusBadge, ApprovalTimeline, Select, QtyInput,
  Input, EmptyState, toast, PermissionGate,
} from '@/components/ui';
import type { DataTableColumn } from '@/components/ui';
import { formatQty } from '@/lib/formatters';
import { usePermissions } from '@/lib/permissions';
import { useOutletLocation } from './lib/use-outlet-location';
import { getItems, listReplenishment, getReplenishment, createReplenishment, submitReplenishment } from './lib/outlet-api';
import type { Replenishment, Item } from './lib/types';

interface DraftLine {
  itemId: string;
  qtyRequested: string | null;
}

/**
 * "Request barang": create a replenishment request, walk its 9 states
 * (draft→…→completed via `StatusBadge`), and surface the mandatory
 * amend/reject reason prominently (FR-LOG-13) — a silently reduced order is
 * what outlet staff most need to notice, so `amendReason` and the rejection
 * step's `reason` render as their own callout, not buried in a detail table.
 */
export function ReplenishmentPanel() {
  const { t } = useI18n();
  const { can } = usePermissions();
  const { locationId } = useOutletLocation();
  const [rows, setRows] = useState<Replenishment[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [detail, setDetail] = useState<Replenishment | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [lines, setLines] = useState<DraftLine[]>([{ itemId: '', qtyRequested: null }]);
  const [neededBy, setNeededBy] = useState('');
  const [saving, setSaving] = useState(false);

  function reload() {
    if (!locationId) return;
    setLoading(true);
    listReplenishment(locationId)
      .then((res) => setRows(res.rows))
      .catch(() => toast({ title: t('table.error'), variant: 'danger' }))
      .finally(() => setLoading(false));
  }

  useEffect(reload, [locationId]);

  useEffect(() => {
    if (createOpen) getItems().then((res) => setItems(res.rows));
  }, [createOpen]);

  async function openDetail(row: Replenishment) {
    const full = await getReplenishment(row.id);
    setDetail(full);
  }

  async function submitCreate() {
    if (!locationId) return;
    const valid = lines.filter((l) => l.itemId && l.qtyRequested);
    if (valid.length === 0) {
      toast({ title: t('validation.required'), variant: 'warning' });
      return;
    }
    setSaving(true);
    try {
      const created = await createReplenishment({
        locationId,
        neededBy: neededBy || undefined,
        lines: valid.map((l) => {
          const item = items.find((i) => i.id === l.itemId)!;
          return { itemId: l.itemId, qtyRequested: l.qtyRequested!, unitId: item.baseUnit.id };
        }),
      });
      await submitReplenishment(created.id);
      toast({ title: t('outlet.replenishment.created'), variant: 'success' });
      setCreateOpen(false);
      setLines([{ itemId: '', qtyRequested: null }]);
      setNeededBy('');
      reload();
    } catch {
      toast({ title: t('common.saving'), variant: 'danger' });
    } finally {
      setSaving(false);
    }
  }

  const columns: DataTableColumn<Replenishment>[] = [
    { key: 'requestNumber', header: t('outlet.replenishment.number') },
    { key: 'status', header: t('common.status'), render: (r) => <StatusBadge domain="replenishment" status={r.status} /> },
    { key: 'submittedAt', header: t('common.date'), render: (r) => r.submittedAt?.slice(0, 10) ?? '—' },
    {
      key: 'flag',
      header: '',
      render: (r) =>
        r.status === 'rejected' || r.lines.some((l) => l.amendReason) ? (
          <span className="inline-flex items-center gap-1 text-sm font-medium text-warning-700">
            <AlertTriangle className="size-3.5" aria-hidden />
            {r.status === 'rejected' ? t('outlet.replenishment.rejectedFlag') : t('outlet.replenishment.amendedFlag')}
          </span>
        ) : null,
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <PermissionGate permission="replenishment.create">
          <Button leftIcon={<Plus className="size-4" />} size="touch" onClick={() => setCreateOpen(true)}>
            {t('outlet.replenishment.new')}
          </Button>
        </PermissionGate>
      </div>

      <DataTable
        columns={columns}
        data={{ rows, total: rows.length, page: 1, pageSize: Math.max(rows.length, 1) }}
        keyField={(r) => r.id}
        loading={loading}
        onRowClick={openDetail}
        emptyDescription={t('outlet.replenishment.empty')}
      />

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title={t('outlet.replenishment.new')} size="lg">
        <div className="flex flex-col gap-4">
          <Input
            type="date"
            label={t('outlet.replenishment.neededBy')}
            value={neededBy}
            onChange={(e) => setNeededBy(e.target.value)}
          />
          {lines.map((line, idx) => (
            <div key={idx} className="flex gap-3">
              <Select
                label={t('outlet.replenishment.item')}
                value={line.itemId}
                onValueChange={(v) => setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, itemId: v } : l)))}
                options={items.map((i) => ({ value: i.id, label: `${i.name} (${i.baseUnit.code})` }))}
                placeholder={t('common.selectPlaceholder')}
                wrapperClassName="flex-1"
              />
              <QtyInput
                label={t('outlet.replenishment.qty')}
                value={line.qtyRequested}
                onChange={(v) => setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, qtyRequested: v } : l)))}
                unitCode={items.find((i) => i.id === line.itemId)?.baseUnit.code}
              />
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            leftIcon={<Plus className="size-4" />}
            onClick={() => setLines((ls) => [...ls, { itemId: '', qtyRequested: null }])}
          >
            {t('outlet.replenishment.addLine')}
          </Button>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setCreateOpen(false)}>{t('common.cancel')}</Button>
          <Button loading={saving} onClick={submitCreate}>{t('common.submit')}</Button>
        </div>
      </Modal>

      <Modal open={!!detail} onClose={() => setDetail(null)} title={detail?.requestNumber ?? ''} size="lg">
        {detail && (
          <div className="flex flex-col gap-4">
            <StatusBadge domain="replenishment" status={detail.status} />

            {detail.status === 'rejected' && detail.approval?.steps.some((s) => s.state === 'rejected') && (
              <Card className="border-danger-600/30 bg-danger-50/40">
                <CardContent className="flex items-start gap-2 p-3 text-sm text-danger-700">
                  <AlertTriangle className="mt-0.5 size-4 flex-none" aria-hidden />
                  <span>
                    {detail.approval.steps.find((s) => s.state === 'rejected')?.reason ?? t('approvalTimeline.noReason')}
                  </span>
                </CardContent>
              </Card>
            )}

            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-sunken text-left text-text-secondary">
                  <th className="px-3 py-2">{t('outlet.replenishment.item')}</th>
                  <th className="px-3 py-2 text-right">{t('outlet.replenishment.qtyRequested')}</th>
                  <th className="px-3 py-2 text-right">{t('outlet.replenishment.qtyApproved')}</th>
                  <th className="px-3 py-2">{t('outlet.replenishment.amendReason')}</th>
                </tr>
              </thead>
              <tbody>
                {detail.lines.map((l) => (
                  <tr key={l.id} className="border-b border-border last:border-0">
                    <td className="px-3 py-2.5">{l.itemName}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{formatQty(l.qtyRequested, l.unitCode)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{formatQty(l.qtyApproved, l.unitCode)}</td>
                    <td className="px-3 py-2.5">
                      {l.amendReason ? (
                        <span className="inline-flex items-center gap-1 font-medium text-warning-700">
                          <AlertTriangle className="size-3.5 flex-none" aria-hidden />
                          {l.amendReason}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {detail.approval && <ApprovalTimeline steps={detail.approval.steps} />}
            {can('replenishment.create') && detail.status === 'draft' && (
              <EmptyState size="sm" title={t('outlet.replenishment.draftHint')} />
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
