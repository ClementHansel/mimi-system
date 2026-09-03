'use client';

import { useEffect, useState } from 'react';
import { Plus, AlertTriangle } from 'lucide-react';
import { isOpnameEditable } from '@mimi/shared';
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
  toast,
  PermissionGate,
} from '@/components/ui';
import type { DataTableColumn } from '@/components/ui';
import { formatQty } from '@/lib/formatters';
import { ExportButton } from '@/components/common/ExportButton';
import { LineImportButton } from '@/components/common/LineImportButton';
import { useOutletLocationContext } from './lib/outlet-location-context';
import {
  getStorageAreas,
  listOpname,
  getOpname,
  createOpname,
  putOpnameLines,
  submitOpname,
  getBalances,
} from './lib/outlet-api';
import { buildOpnameSheet, type OpnameSheetRow } from './lib/opname-sheet';
import {
  computeDiffQty,
  hasVariance,
  canSubmitOpname,
  type OpnameLineDraft,
} from './lib/opname-variance';
import { OPNAME_EXPORT_COLUMNS } from './lib/outlet-export-columns';
import {
  OPNAME_IMPORT_COLUMNS,
  makeOpnameCountMapper,
  type OpnameCountFill,
} from './lib/outlet-line-import';
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
  const { locationId } = useOutletLocationContext();
  const [rows, setRows] = useState<Opname[]>([]);
  const [loading, setLoading] = useState(true);
  const [areas, setAreas] = useState<StorageArea[]>([]);
  const [active, setActive] = useState<OpnameDetail | null>(null);
  // The rows on screen are NOT `active.lines`. A line exists only once a
  // quantity has been recorded, so a fresh count has none and the sheet came up
  // empty and uncountable. `buildOpnameSheet` puts every item the system
  // believes is in the area on the sheet and overlays what has been counted.
  const [sheet, setSheet] = useState<OpnameSheetRow[]>([]);
  const [drafts, setDrafts] = useState<
    Record<string, { countedQty: Qty | null; varianceReason: string }>
  >({});
  const [savingLines, setSavingLines] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [newAreaId, setNewAreaId] = useState('');
  const [startOpen, setStartOpen] = useState(false);

  function reload() {
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

    // What the system thinks is in the area being counted. A failure here must
    // not blank the sheet: any lines already recorded still have to be
    // editable, so fall back to those rather than showing nothing.
    const balances = row.locationId
      ? await getBalances({
          locationId: row.locationId,
          storageAreaId: full.storageAreaId ?? undefined,
        })
          .then((res) => res.rows)
          .catch(() => {
            toast({ title: t('table.error'), variant: 'danger' });
            return [];
          })
      : [];

    const rows = buildOpnameSheet(full.lines, balances);
    setActive(full);
    setSheet(rows);
    // KEYED BY ITEM: an uncounted row has no line id to key on.
    setDrafts(
      Object.fromEntries(
        rows.map((r) => [r.itemId, { countedQty: r.countedQty, varianceReason: r.varianceReason }]),
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

  const lineDrafts: OpnameLineDraft[] = sheet.map((r) => ({
    itemId: r.itemId,
    systemQty: r.systemQty,
    countedQty: drafts[r.itemId]?.countedQty ?? null,
    varianceReason: drafts[r.itemId]?.varianceReason ?? '',
  }));
  // ONCE SUBMITTED, THE SHEET IS A RECORD, NOT A FORM — see the warehouse
  // panel's note. Same defect, same rule, one definition in `@mimi/shared`.
  const editable = active ? isOpnameEditable(active.status) : false;
  const canSubmit =
    active && editable
      ? canSubmitOpname(lineDrafts) && lineDrafts.some((l) => l.countedQty !== null)
      : false;

  async function saveLines() {
    if (!active) return;
    setSavingLines(true);
    try {
      // Only rows that were actually counted are sent. An untouched row has no
      // quantity, and inventing one would post a count nobody took.
      const payload = sheet
        .filter(
          (r) =>
            drafts[r.itemId]?.countedQty !== null && drafts[r.itemId]?.countedQty !== undefined,
        )
        .map((r) => ({
          storageAreaId: r.storageAreaId,
          itemId: r.itemId,
          countedQty: drafts[r.itemId]!.countedQty as string,
          varianceReason: drafts[r.itemId]!.varianceReason || undefined,
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
      <div className="flex flex-wrap items-center justify-end gap-2">
        <ExportButton rows={rows} columns={OPNAME_EXPORT_COLUMNS} filenameBase="stock-opname" />
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
            <div className="flex flex-wrap items-center justify-between gap-2">
              <StatusBadge domain="opname" status={active.status} />
              {/* Counts get typed into a phone spreadsheet on the freezer floor
                  and reconciled later — this is the one Outlet flow where the
                  CSV is the real-world source rather than a convenience. It can
                  only FILL lines the server already put on this sheet, so a
                  count still cannot claim stock the system has no record of;
                  that is what the variance and approval steps are for. */}
              <LineImportButton<OpnameCountFill>
                title={t('outlet.opname.countSheet')}
                note={t('outlet.opname.importNote')}
                columns={OPNAME_IMPORT_COLUMNS}
                templateBase="lembar-hitung"
                mapRow={makeOpnameCountMapper(sheet)}
                hasExistingLines={Object.values(drafts).some((d) => d.countedQty !== null)}
                onLines={(fills, mode) =>
                  setDrafts((prev) => {
                    // "replace" clears every count first, so a re-import after a
                    // recount cannot leave a stale figure on a line the new file
                    // omits — the failure that makes a sheet silently not add up.
                    const next: typeof prev =
                      mode === 'replace'
                        ? Object.fromEntries(
                            Object.keys(prev).map((id) => [
                              id,
                              { countedQty: null, varianceReason: '' },
                            ]),
                          )
                        : { ...prev };
                    for (const f of fills) {
                      next[f.itemId] = {
                        countedQty: f.countedQty,
                        // A blank reason column keeps whatever was typed on
                        // screen rather than wiping it: the file is filling in
                        // counts, and it should not silently undo a reason the
                        // counter already gave.
                        varianceReason: f.varianceReason || (next[f.itemId]?.varianceReason ?? ''),
                      };
                    }
                    return next;
                  })
                }
              />
            </div>
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
                    {sheet.map((l) => {
                      const d = drafts[l.itemId] ?? { countedQty: null, varianceReason: '' };
                      const diff =
                        d.countedQty !== null ? computeDiffQty(l.systemQty, d.countedQty) : null;
                      const variesNow = diff !== null && hasVariance(diff);
                      return (
                        <tr
                          key={`${l.storageAreaId}-${l.itemId}`}
                          className="border-b border-border last:border-0"
                        >
                          <td className="px-3 py-2.5">{l.itemName}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums">
                            {formatQty(l.systemQty, l.unitCode)}
                          </td>
                          <td className="px-3 py-2.5">
                            <QtyInput
                              disabled={!editable}
                              value={d.countedQty}
                              onChange={(v) =>
                                setDrafts((prev) => ({
                                  ...prev,
                                  [l.itemId]: { ...prev[l.itemId]!, countedQty: v },
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
                                    [l.itemId]: {
                                      ...prev[l.itemId]!,
                                      varianceReason: e.target.value,
                                    },
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

            {editable && !canSubmit && (
              <div className="flex items-center gap-2 text-sm font-medium text-warning-700">
                <AlertTriangle className="size-4" aria-hidden />
                {t('outlet.opname.reasonGateHint')}
              </div>
            )}

            {editable && (
              <div className="flex justify-end gap-2">
                <Button variant="outline" loading={savingLines} onClick={saveLines}>
                  {t('common.save')}
                </Button>
                <Button loading={submitting} disabled={!canSubmit} onClick={submitSheet}>
                  {t('common.submit')}
                </Button>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
