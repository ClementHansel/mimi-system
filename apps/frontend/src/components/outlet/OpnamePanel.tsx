'use client';

import { useEffect, useState } from 'react';
import { Plus, AlertTriangle } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Modal,
  DataTable,
  StatusBadge,
  Select,
  QtyInput,
  Textarea,
  EmptyState,
  toast,
  PermissionGate,
} from '@/components/ui';
import type { DataTableColumn } from '@/components/ui';
import { formatQty } from '@/lib/formatters';
import { useOutletLocation } from './lib/use-outlet-location';
import {
  getStorageAreas,
  listOpname,
  getOpname,
  createOpname,
  putOpnameLines,
  submitOpname,
} from './lib/outlet-api';
import {
  computeDiffQty,
  hasVariance,
  canSubmitOpname,
  type OpnameLineDraft,
} from './lib/opname-variance';
import type { Opname, OpnameDetail, StorageArea } from './lib/types';
import type { Qty } from '@/lib/shared-types';

/**
 * Stock opname: a count sheet per storage area, variance shown against system
 * stock, mandatory reason on every varying line (FR-SO-02), then submit for
 * approval. `canSubmitOpname` (the pure, unit-tested gate in
 * `lib/opname-variance.ts`) is what disables the "Ajukan" button here.
 */
export function OpnamePanel() {
  const { t } = useI18n();
  const { locationId } = useOutletLocation();
  const [rows, setRows] = useState<Opname[]>([]);
  const [loading, setLoading] = useState(true);
  const [areas, setAreas] = useState<StorageArea[]>([]);
  const [active, setActive] = useState<OpnameDetail | null>(null);
  const [drafts, setDrafts] = useState<
    Record<string, { countedQty: Qty | null; varianceReason: string }>
  >({});
  const [savingLines, setSavingLines] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [newAreaId, setNewAreaId] = useState('');
  const [startOpen, setStartOpen] = useState(false);

  function reload() {
    if (!locationId) return;
    setLoading(true);
    listOpname(locationId)
      .then((res) => setRows(res.rows))
      .catch(() => toast({ title: t('table.error'), variant: 'danger' }))
      .finally(() => setLoading(false));
  }

  useEffect(reload, [locationId]);
  useEffect(() => {
    if (locationId) getStorageAreas(locationId).then(setAreas);
  }, [locationId]);

  async function openSheet(row: Opname) {
    const full = await getOpname(row.id);
    setActive(full);
    setDrafts(
      Object.fromEntries(
        full.lines.map((l) => [
          l.id,
          { countedQty: l.countedQty ?? null, varianceReason: l.varianceReason ?? '' },
        ]),
      ),
    );
  }

  async function startNew() {
    if (!locationId || !newAreaId) return;
    const created = await createOpname(locationId, newAreaId);
    setStartOpen(false);
    setNewAreaId('');
    reload();
    await openSheet(created);
  }

  const lineDrafts: OpnameLineDraft[] = (active?.lines ?? []).map((l) => ({
    itemId: l.itemId,
    systemQty: l.systemQty,
    countedQty: drafts[l.id]?.countedQty ?? null,
    varianceReason: drafts[l.id]?.varianceReason ?? '',
  }));
  const canSubmit = active
    ? canSubmitOpname(lineDrafts) && lineDrafts.some((l) => l.countedQty !== null)
    : false;

  async function saveLines() {
    if (!active) return;
    setSavingLines(true);
    try {
      const payload = active.lines
        .filter((l) => drafts[l.id]?.countedQty !== null && drafts[l.id]?.countedQty !== undefined)
        .map((l) => ({
          storageAreaId: l.storageAreaId,
          itemId: l.itemId,
          countedQty: drafts[l.id]!.countedQty as string,
          varianceReason: drafts[l.id]!.varianceReason || undefined,
        }));
      await putOpnameLines(active.id, payload);
      toast({ title: t('common.saving'), variant: 'success' });
    } finally {
      setSavingLines(false);
    }
  }

  async function submitSheet() {
    if (!active) return;
    setSubmitting(true);
    try {
      await saveLines();
      await submitOpname(active.id);
      toast({ title: t('outlet.opname.submitted'), variant: 'success' });
      setActive(null);
      reload();
    } catch {
      toast({ title: t('table.error'), variant: 'danger' });
    } finally {
      setSubmitting(false);
    }
  }

  const columns: DataTableColumn<Opname>[] = [
    { key: 'opnameNumber', header: t('outlet.opname.number') },
    {
      key: 'status',
      header: t('common.status'),
      render: (r) => <StatusBadge domain="opname" status={r.status} />,
    },
    { key: 'lineCount', header: t('outlet.opname.lineCount'), align: 'right' },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <PermissionGate permission="opname.create">
          <Button
            leftIcon={<Plus className="size-4" />}
            size="touch"
            onClick={() => setStartOpen(true)}
          >
            {t('outlet.opname.new')}
          </Button>
        </PermissionGate>
      </div>

      <DataTable
        columns={columns}
        data={{ rows, total: rows.length, page: 1, pageSize: Math.max(rows.length, 1) }}
        keyField={(r) => r.id}
        loading={loading}
        onRowClick={openSheet}
        emptyDescription={t('outlet.opname.empty')}
      />

      <Modal open={startOpen} onClose={() => setStartOpen(false)} title={t('outlet.opname.new')}>
        <Select
          label={t('outlet.opname.area')}
          value={newAreaId}
          onValueChange={setNewAreaId}
          options={areas.map((a) => ({ value: a.id, label: a.name }))}
          placeholder={t('common.selectPlaceholder')}
        />
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setStartOpen(false)}>
            {t('common.cancel')}
          </Button>
          <Button disabled={!newAreaId} onClick={startNew}>
            {t('common.next')}
          </Button>
        </div>
      </Modal>

      <Modal
        open={!!active}
        onClose={() => setActive(null)}
        title={active?.opnameNumber ?? ''}
        size="xl"
      >
        {active && (
          <div className="flex flex-col gap-4">
            <StatusBadge domain="opname" status={active.status} />
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('outlet.opname.countSheet')}</CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto p-0">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-border bg-surface-sunken text-left text-text-secondary">
                      <th className="px-3 py-2">{t('outlet.opname.item')}</th>
                      <th className="px-3 py-2 text-right">{t('outlet.opname.systemQty')}</th>
                      <th className="px-3 py-2 text-right">{t('outlet.opname.countedQty')}</th>
                      <th className="px-3 py-2 text-right">{t('outlet.opname.diffQty')}</th>
                      <th className="px-3 py-2">{t('common.reason')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {active.lines.map((l) => {
                      const d = drafts[l.id] ?? { countedQty: null, varianceReason: '' };
                      const diff =
                        d.countedQty !== null ? computeDiffQty(l.systemQty, d.countedQty) : null;
                      const variesNow = diff !== null && hasVariance(diff);
                      return (
                        <tr key={l.id} className="border-b border-border last:border-0">
                          <td className="px-3 py-2.5">{l.itemName}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums">
                            {formatQty(l.systemQty, l.unitCode)}
                          </td>
                          <td className="px-3 py-2.5">
                            <QtyInput
                              value={d.countedQty}
                              onChange={(v) =>
                                setDrafts((prev) => ({
                                  ...prev,
                                  [l.id]: { ...prev[l.id]!, countedQty: v },
                                }))
                              }
                              unitCode={l.unitCode}
                              size="touch"
                              wrapperClassName="ml-auto w-32"
                            />
                          </td>
                          <td
                            className={`px-3 py-2.5 text-right tabular-nums ${variesNow ? 'font-medium text-warning-700' : ''}`}
                          >
                            {diff !== null ? formatQty(diff, l.unitCode) : '—'}
                          </td>
                          <td className="px-3 py-2.5">
                            {variesNow ? (
                              <Textarea
                                rows={1}
                                value={d.varianceReason}
                                onChange={(e) =>
                                  setDrafts((prev) => ({
                                    ...prev,
                                    [l.id]: { ...prev[l.id]!, varianceReason: e.target.value },
                                  }))
                                }
                                placeholder={t('common.reasonPlaceholder')}
                                error={
                                  d.varianceReason.trim() === ''
                                    ? t('validation.reasonRequired')
                                    : undefined
                                }
                                wrapperClassName="w-56"
                              />
                            ) : (
                              '—'
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </CardContent>
            </Card>

            {!canSubmit && (
              <div className="flex items-center gap-2 text-sm font-medium text-warning-700">
                <AlertTriangle className="size-4" aria-hidden />
                {t('outlet.opname.reasonGateHint')}
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="outline" loading={savingLines} onClick={saveLines}>
                {t('common.save')}
              </Button>
              <Button loading={submitting} disabled={!canSubmit} onClick={submitSheet}>
                {t('common.submit')}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {!locationId && <EmptyState title={t('table.error')} size="lg" />}
    </div>
  );
}
