'use client';

import { useEffect, useMemo, useState } from 'react';
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
  EmptyState,
  toast,
  PermissionGate,
} from '@/components/ui';
import type { DataTableColumn } from '@/components/ui';
import { ExportButton } from '@/components/common/ExportButton';
import { LineImportButton } from '@/components/common/LineImportButton';
import type { CsvColumn } from '@/lib/export/csv';
import { parseDecimal, type CsvRecord } from '@/lib/import/csv-parse';
import { buildNameIndex, resolveNamed } from '@/lib/import/resolve';
import { formatQty } from '@/lib/formatters';
import { ApiError } from '@/lib/api';
import type { Opname, OpnameLine } from '@/lib/shared-types';
import { useWarehouseLocation } from './lib/use-warehouse-location';
import {
  getStorageAreas,
  listOpname,
  getOpname,
  createOpname,
  putOpnameLines,
  submitOpname,
} from './lib/warehouse-api';
import {
  computeDiffQty,
  hasVariance,
  canSubmitOpname,
  type OpnameLineDraft,
} from './lib/opname-variance';
import type { StorageArea } from './lib/types';
import type { Qty } from '@/lib/shared-types';
import { fmtDate } from '@/lib/dates';

/** The opname DOCUMENT list — one row per count, for the register/audit trail. */
const LIST_EXPORT_COLUMNS: CsvColumn<Opname>[] = [
  { key: 'opnameNumber', header: 'No. Opname' },
  { key: 'startedAt', header: 'Dimulai', format: (r) => fmtDate(r.startedAt) },
  { key: 'status', header: 'Status' },
  { key: 'countedBy', header: 'Dihitung Oleh' },
  { key: 'lineCount', header: 'Jumlah Baris' },
  { key: 'disputedCount', header: 'Selisih Disengketakan' },
  {
    key: 'submittedAt',
    header: 'Diajukan',
    format: (r) => (r.submittedAt ? fmtDate(r.submittedAt) : ''),
  },
];

/**
 * THE COUNT SHEET, which is the export that matters here.
 *
 * A warehouse count is not done at a laptop — it is done walking the freezer
 * with a printout or a phone, and typed in afterwards. So the useful round trip
 * is: export this sheet (every item, with the system quantity to compare
 * against), count into the `Jumlah Dihitung` column in a spreadsheet, import it
 * back. `Nama Barang` is the join key on the way back, which is why it is
 * exported verbatim rather than prettified.
 *
 * `Jumlah Sistem` is exported for the counter to see and DELIBERATELY not read
 * on import: the whole point of an opname is that the counted number is
 * independent of what the system believed, and letting a file overwrite the
 * system side would erase the variance the document exists to record.
 */
const SHEET_EXPORT_COLUMNS: CsvColumn<OpnameLine>[] = [
  { key: 'itemName', header: 'Nama Barang' },
  { key: 'storageAreaName', header: 'Area Penyimpanan' },
  { key: 'unitCode', header: 'Satuan' },
  { key: 'systemQty', header: 'Jumlah Sistem', format: (l) => formatQty(l.systemQty) },
  {
    key: 'countedQty',
    header: 'Jumlah Dihitung',
    // Blank, not "0", for a line nobody has counted yet — a zero here would be
    // a claim that the shelf is empty, and re-importing the sheet would turn
    // every uncounted line into a total write-off.
    format: (l) => (l.countedQty === null ? '' : formatQty(l.countedQty)),
  },
  { key: 'varianceReason', header: 'Alasan Selisih', format: (l) => l.varianceReason ?? '' },
];

/** One imported count, addressed to a line that already exists in the sheet. */
interface CountImportRow {
  lineId: string;
  countedQty: Qty;
  varianceReason: string;
}

/**
 * Stock opname at the central warehouse — the same count-sheet/variance/
 * mandatory-reason flow as `components/outlet/OpnamePanel.tsx` (FR-SO-01/02),
 * run against the warehouse's own location instead of an outlet's. Kept as
 * its own component rather than a shared one: this surface's ownership split
 * (each F0x surface owns its own `lib/`/panels) already applies the same
 * choice to every other resource that appears on both sides (`Balance`,
 * `StorageArea`, `Item`, `ApprovalDetail`, ...).
 */
export function StockOpnamePanel() {
  const { t } = useI18n();
  const { locationId, loading: warehouseLoading } = useWarehouseLocation();
  const [rows, setRows] = useState<Opname[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [areas, setAreas] = useState<StorageArea[]>([]);
  const [active, setActive] = useState<(Opname & { lines: OpnameLine[] }) | null>(null);
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
    setError(undefined);
    listOpname(locationId)
      .then((res) => setRows(res.rows))
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : t('table.error')))
      .finally(() => setLoading(false));
  }

  useEffect(reload, [locationId]);
  useEffect(() => {
    if (locationId)
      getStorageAreas(locationId)
        .then(setAreas)
        .catch(() => {});
  }, [locationId]);

  async function openSheet(row: Opname) {
    try {
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
    } catch {
      toast({ title: t('table.error'), variant: 'danger' });
    }
  }

  async function startNew() {
    if (!locationId || !newAreaId) return;
    try {
      const created = await createOpname(locationId, newAreaId);
      setStartOpen(false);
      setNewAreaId('');
      reload();
      await openSheet(created);
    } catch {
      toast({ title: t('table.error'), variant: 'danger' });
    }
  }

  const lineDrafts: OpnameLineDraft[] = (active?.lines ?? []).map((l) => ({
    itemId: l.itemId,
    systemQty: l.systemQty,
    countedQty: drafts[l.id]?.countedQty ?? null,
    varianceReason: drafts[l.id]?.varianceReason ?? '',
  }));
  // ONCE SUBMITTED, THE SHEET IS A RECORD, NOT A FORM. The server refuses
  // lines and a re-submit on anything past `counting`, but this screen showed
  // the status as a badge only and left the inputs and both buttons live — so a
  // submitted count could be edited and re-submitted, and doing so produced an
  // error the counter could do nothing about. Reported 2026-09-03.
  const editable = active ? isOpnameEditable(active.status) : false;
  const canSubmit =
    active && editable
      ? canSubmitOpname(lineDrafts) && lineDrafts.some((l) => l.countedQty !== null)
      : false;

  /**
   * Count-sheet lines indexed by item name — the join key an imported file uses.
   * Built from the OPEN document only: an opname's lines are created by the
   * server for one storage area, so a row naming an item that is not on this
   * sheet is not a new line to add, it is a row from the wrong file, and saying
   * that is more useful than inventing a line the endpoint would reject.
   */
  const sheetIndex = useMemo(
    () => buildNameIndex((active?.lines ?? []).map((l) => ({ id: l.id, name: l.itemName }))),
    [active],
  );

  const countImportColumns = [
    { header: 'Nama Barang', hint: 'nama persis seperti pada sheet hitung', required: true },
    { header: 'Jumlah Dihitung', hint: 'angka hasil hitung fisik, mis. 12,5', required: true },
    {
      header: 'Alasan Selisih',
      hint: 'wajib kalau hasil hitung berbeda dari jumlah sistem',
    },
  ];

  function mapCountRow(
    row: CsvRecord,
  ): { ok: true; line: CountImportRow } | { ok: true; line: null } | { ok: false; error: string } {
    const nameText = row.get('Nama Barang');
    if (!nameText) return { ok: false, error: t('lineImport.missingItem') };
    const line = resolveNamed(sheetIndex, nameText);
    if (!line) return { ok: false, error: t('lineImport.notInDocument') };

    const qtyText = row.get('Jumlah Dihitung');
    // An UNCOUNTED line is skipped, not rejected. Exporting the sheet before
    // the count leaves this column blank on every row, and a half-finished
    // count is the normal case — flagging 200 "errors" for it would bury the
    // rows that are genuinely wrong.
    if (!qtyText) return { ok: true, line: null };
    const qty = parseDecimal(qtyText);
    if (qty === null) return { ok: false, error: t('lineImport.invalidQty', { value: qtyText }) };
    if (qty.startsWith('-')) return { ok: false, error: t('lineImport.negativeQty') };

    return {
      ok: true,
      line: {
        lineId: line.id,
        countedQty: qty as Qty,
        varianceReason: row.get('Alasan Selisih'),
      },
    };
  }

  /**
   * Imported counts land in `drafts`, exactly where the QtyInputs write.
   *
   * That is what keeps the import honest: the variance gate
   * (`canSubmitOpname`) and the per-line "reason required" errors run over the
   * same state whether a number was typed or imported, so a file cannot submit
   * a variance without a reason when a human cannot. `replace` clears the
   * counts it did not set, since a re-export/re-import of the sheet is meant to
   * be the authoritative count, not a merge.
   */
  function applyCounts(imported: CountImportRow[], mode: 'append' | 'replace') {
    setDrafts((prev) => {
      const base =
        mode === 'replace'
          ? Object.fromEntries(
              (active?.lines ?? []).map((l) => [
                l.id,
                { countedQty: null as Qty | null, varianceReason: '' },
              ]),
            )
          : { ...prev };
      for (const row of imported) {
        base[row.lineId] = {
          countedQty: row.countedQty,
          // Keep a reason already on screen when the file leaves that cell
          // blank — an operator who typed the explanation here should not lose
          // it to a file that only carries quantities.
          varianceReason: row.varianceReason || (prev[row.lineId]?.varianceReason ?? ''),
        };
      }
      return base;
    });
  }

  const hasTypedCounts = Object.values(drafts).some((d) => d.countedQty !== null);

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
      if (payload.length > 0) await putOpnameLines(active.id, payload);
      toast({ title: t('common.saving'), variant: 'success' });
    } catch {
      toast({ title: t('table.error'), variant: 'danger' });
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

  // See `StockPanel`'s identical guard — no `warehouse`-type location on
  // this account (e.g. Owner) means there's nothing to fetch, not a failed
  // request (FIX-LOADS #1).
  // `loading` first: a central role has no warehouse in its session and one
  // is fetched, so checking only `locationId` renders "no warehouse" for a
  // frame — the exact wrong message, shown to the people who own the place.
  if (warehouseLoading) return <EmptyState title={t('table.loading')} size="lg" />;
  if (!locationId) return <EmptyState title={t('warehouse.noLocation')} size="lg" />;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <ExportButton
          rows={rows}
          columns={LIST_EXPORT_COLUMNS}
          filenameBase="stock-opname"
          pdfTitle={t('warehouse.tabs.opname')}
        />
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
        error={error}
        onRowClick={openSheet}
        emptyDescription={t('outlet.opname.empty')}
      />
      {error && (
        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={reload}>
            {t('common.retry')}
          </Button>
        </div>
      )}

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
              {/* Export → count on paper/phone → import back. Both halves sit on
                  the sheet itself, because that is the document being counted;
                  the list's export above is the register, a different thing. */}
              <div className="flex flex-wrap items-center gap-2">
                <ExportButton
                  rows={active.lines}
                  columns={SHEET_EXPORT_COLUMNS}
                  filenameBase={`sheet-hitung-${active.opnameNumber}`}
                  pdfTitle={`${t('outlet.opname.countSheet')} — ${active.opnameNumber}`}
                />
                <LineImportButton<CountImportRow>
                  title={`${t('outlet.opname.countSheet')} — ${active.opnameNumber}`}
                  templateBase={`sheet-hitung-${active.opnameNumber}`}
                  columns={countImportColumns}
                  mapRow={mapCountRow}
                  hasExistingLines={hasTypedCounts}
                  disabled={active.lines.length === 0}
                  onLines={applyCounts}
                />
              </div>
            </div>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('outlet.opname.countSheet')}</CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto p-0">
                {active.lines.length === 0 && <EmptyState title={t('table.empty')} size="sm" />}
                {active.lines.length > 0 && (
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
                                disabled={!editable}
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
                )}
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
