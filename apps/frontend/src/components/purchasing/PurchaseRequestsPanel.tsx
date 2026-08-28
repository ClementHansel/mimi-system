'use client';

import { useEffect, useMemo, useState } from 'react';
import { Plus, Pencil, History, ArrowRightLeft } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { ApiError } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { PurchaseRequestStatus } from '@/lib/shared-types';
import type { Money, Qty } from '@/lib/shared-types';
import { fmtDate, fmtDateTime } from '@/lib/dates';
import { formatMoney } from '@/lib/formatters';
import { toast } from '@/components/ui/Toast';
import { DataTable, type DataTableColumn } from '@/components/ui/DataTable';
import { ExportButton } from '@/components/common/ExportButton';
import { LineImportButton } from '@/components/common/LineImportButton';
import type { CsvColumn } from '@/lib/export/csv';
import { parseDecimal, type CsvRecord } from '@/lib/import/csv-parse';
import { buildItemIndex, buildNameIndex, resolveItem, resolveNamed } from '@/lib/import/resolve';
import { Select } from '@/components/ui/Select';
import { SearchableSelect } from '@/components/ui/SearchableSelect';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Drawer } from '@/components/ui/Drawer';
import { Textarea } from '@/components/ui/Textarea';
import { QtyInput } from '@/components/ui/QtyInput';
import { MoneyInput } from '@/components/ui/MoneyInput';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { ApprovalTimeline } from '@/components/ui/ApprovalTimeline';
import { PermissionGate } from '@/components/ui/PermissionGate';
import { EmptyState } from '@/components/ui/EmptyState';
import { useApiList } from '@/components/admin/useApiList';
import {
  getLocations,
  getItems,
  getSuppliers,
  getSupplierDirectory,
  getPurchaseRequest,
  getPurchaseRequestHistory,
  createPurchaseRequest,
  updatePurchaseRequest,
  submitPurchaseRequest,
  approvePurchaseRequest,
  rejectPurchaseRequest,
} from './lib/api';
import type {
  Item,
  LocationOption,
  PurchaseRequestListRow,
  PurchaseRequestDetail,
  PurchaseRequestHistoryEntry,
} from './lib/types';

function errMsg(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/**
 * `audit_log.action` holds the permission-shaped verb the `@Audited()`
 * interceptor recorded (`purchasing.pr.create`). Mapped explicitly rather than
 * interpolated into an i18n path: the actions contain dots, so building a key
 * from one would be read as a nested lookup and miss.
 * An unmapped action falls back to the raw verb — visible and obviously
 * technical, which is better than a blank line in an audit trail.
 */
const HISTORY_ACTION_KEYS: Record<string, string> = {
  'purchasing.pr.create': 'purchasing.requests.historyAction.create',
  'purchasing.pr.update': 'purchasing.requests.historyAction.update',
  'purchasing.pr.approve': 'purchasing.requests.historyAction.approve',
};

function historyLabel(action: string, t: (key: string) => string): string {
  const key = HISTORY_ACTION_KEYS[action];
  return key ? t(key) : action;
}

interface LineDraft {
  itemId: string;
  qty: Qty | null;
  unitId: string;
  estPrice: Money | null;
  suggestedSupplierId: string;
}

const EMPTY_LINE: LineDraft = {
  itemId: '',
  qty: null,
  unitId: '',
  estPrice: null,
  suggestedSupplierId: '',
};

/**
 * The PR LIST export — one row per request, matching what the table shows.
 *
 * Deliberately NOT one row per line, unlike the retur and Surat Jalan exports.
 * The list endpoint returns `lineCount`, not the lines themselves (each PR's
 * lines come from `GET /purchasing/requests/:id`), so a per-line file would mean
 * N extra requests to build one download. The per-line view of a PR is its
 * drawer, and the per-line CSV that matters is the IMPORT one below — which is
 * about raising a request, not reporting on it.
 */
const LIST_EXPORT_COLUMNS: CsvColumn<PurchaseRequestListRow>[] = [
  { key: 'prNumber', header: 'No. PR' },
  { key: 'locationName', header: 'Lokasi' },
  { key: 'requestedBy', header: 'Diminta Oleh' },
  { key: 'neededBy', header: 'Dibutuhkan', format: (r) => (r.neededBy ? fmtDate(r.neededBy) : '') },
  { key: 'lineCount', header: 'Jumlah Baris' },
  { key: 'status', header: 'Status' },
];

/**
 * F-PUR-01 — Permintaan Pembelian (purchase requests). Draft -> Submitted ->
 * Approved/Rejected -> Converted (once a PO is raised against it, FR-PO-01).
 * Rejected/Cancelled are dead ends. Mirrors `PaymentsPanel`'s list+drawer
 * shape: inline status-driven actions, no separate route per state.
 */
export function PurchaseRequestsPanel({ onCreatePo }: { onCreatePo?: (prId: string) => void }) {
  const { t } = useI18n();
  const { can } = usePermissions();

  const [locationId, setLocationId] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const { data, loading, error, reload } = useApiList<PurchaseRequestListRow>(
    '/purchasing/requests',
    {
      locationId,
      status,
      page,
      pageSize,
    },
  );

  const [locations, setLocations] = useState<LocationOption[]>([]);
  useEffect(() => {
    getLocations()
      .then((r) => setLocations(r.rows))
      .catch(() => {});
  }, []);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const columns: DataTableColumn<PurchaseRequestListRow>[] = [
    { key: 'prNumber', header: t('purchasing.requests.columnNumber') },
    { key: 'locationName', header: t('purchasing.requests.columnLocation') },
    { key: 'requestedBy', header: t('purchasing.requests.columnRequestedBy') },
    {
      key: 'neededBy',
      header: t('purchasing.requests.columnNeededBy'),
      render: (r) => (r.neededBy ? fmtDate(r.neededBy) : '—'),
    },
    {
      key: 'lineCount',
      header: t('purchasing.requests.columnLines'),
      align: 'right',
      render: (r) => r.lineCount,
    },
    {
      key: 'status',
      header: t('purchasing.requests.columnStatus'),
      render: (r) => <StatusBadge domain="purchaseRequest" status={r.status} />,
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-2">
          <Select
            value={locationId}
            onValueChange={(v) => {
              setLocationId(v);
              setPage(1);
            }}
            placeholder={t('purchasing.filterLocationAll')}
            options={locations.map((l) => ({ value: l.id, label: l.name }))}
            wrapperClassName="w-56"
          />
          <Select
            value={status}
            onValueChange={(v) => {
              setStatus(v);
              setPage(1);
            }}
            placeholder={t('purchasing.requests.filterStatusAll')}
            options={Object.values(PurchaseRequestStatus).map((v) => ({
              value: v,
              label: t(`status.purchaseRequest.${v}`),
            }))}
            wrapperClassName="w-48"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* `data.rows` is ONE PAGE. The label says "terfilter" precisely
              because of that, and `fetchAll` is not wired here: the list is
              server-paginated, so an honest "export everything" would have to
              walk every page — worth adding when someone asks for a month of
              PRs, not worth pretending to do now. */}
          <ExportButton
            rows={data.rows}
            columns={LIST_EXPORT_COLUMNS}
            filenameBase="permintaan-pembelian"
            pdfTitle={t('purchasing.tabs.requests')}
          />
          <PermissionGate permission="purchasing.pr.create">
            <Button leftIcon={<Plus className="size-4" />} onClick={() => setCreateOpen(true)}>
              {t('purchasing.requests.createButton')}
            </Button>
          </PermissionGate>
        </div>
      </div>

      <DataTable
        columns={columns}
        data={data}
        keyField={(r) => r.id}
        loading={loading}
        error={error}
        emptyDescription={t('purchasing.requests.empty')}
        onRowClick={(r) => setSelectedId(r.id)}
        onPageChange={setPage}
        onPageSizeChange={(n) => {
          setPageSize(n);
          setPage(1);
        }}
      />

      {createOpen && (
        <CreateRequestModal
          locations={locations}
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            reload();
            toast({ title: t('purchasing.requests.createSuccess'), variant: 'success' });
          }}
        />
      )}

      {selectedId && (
        <RequestDrawer
          onCreatePo={onCreatePo}
          locations={locations}
          id={selectedId}
          canApprove={can('purchasing.pr.approve')}
          canSubmit={can('purchasing.pr.create')}
          onClose={() => setSelectedId(null)}
          onChanged={reload}
        />
      )}
    </div>
  );
}

/**
 * One form for both creating and EDITING a PR (owner, 2026-08-21: "PR should be
 * editable"). Passing `existing` switches it to edit mode: the fields start
 * populated and Simpan PATCHes instead of POSTing. Deliberately not a second
 * component — a divergent edit form is how "the create screen validates it but
 * the edit screen does not" happens.
 */
function CreateRequestModal({
  locations,
  existing,
  onClose,
  onCreated,
}: {
  locations: LocationOption[];
  existing?: PurchaseRequestDetail;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useI18n();
  const { can } = usePermissions();
  const isEdit = !!existing;
  const [locationId, setLocationId] = useState(existing?.locationId ?? '');
  const [neededBy, setNeededBy] = useState(existing?.neededBy ?? '');
  const [lines, setLines] = useState<LineDraft[]>(
    existing
      ? existing.lines.map((l) => ({
          itemId: l.itemId,
          qty: l.qty,
          unitId: l.unitId,
          estPrice: l.estPrice,
          suggestedSupplierId: l.suggestedSupplierId ?? '',
        }))
      : [{ ...EMPTY_LINE }],
  );
  const [items, setItems] = useState<Item[]>([]);
  const [suppliers, setSuppliers] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    getItems()
      .then((r) => setItems(r.rows))
      .catch(() => {});
    const loadSuppliers = can('supplier.read') ? getSuppliers() : getSupplierDirectory();
    loadSuppliers.then((r) => setSuppliers(r.rows)).catch(() => {});
  }, [can]);

  const itemOptions = items.map((i) => ({
    value: i.id,
    label: i.name,
    // Searchable AND visible: an item is looked up by SKU as often as by name.
    hint: `${i.sku} · ${i.baseUnit.code}`,
  }));
  const supplierOptions = suppliers.map((s) => ({ value: s.id, label: s.name }));

  // A purchase is received INTO a warehouse (`location.type === 'warehouse'`),
  // so those are the destinations offered. If the location table returns none,
  // fall back to every location rather than presenting an empty required field.
  const warehouses = locations.filter((l) => l.type === 'warehouse');
  const destinationOptions = (warehouses.length > 0 ? warehouses : locations).map((l) => ({
    value: l.id,
    label: l.name,
    hint: l.city ?? undefined,
  }));

  const itemIndex = useMemo(() => buildItemIndex(items), [items]);
  const supplierIndex = useMemo(() => buildNameIndex(suppliers), [suppliers]);

  /**
   * Bulk line entry, which is what a purchase request actually is: a list of
   * what to buy, usually assembled in a spreadsheet from several outlets' asks
   * before anyone opens this screen.
   *
   * `Satuan` is NOT an importable column. The unit is derived from the item
   * (`updateLine` does the same thing when a line is picked by hand — it copies
   * `item.baseUnit.id`), and letting a file name a different one would create a
   * request whose quantity means something other than what the item is stocked
   * in. `Harga Perkiraan` and `Saran Supplier` are optional here exactly as they
   * are in the form.
   */
  const importColumns = [
    { header: 'SKU', hint: 'opsional — pakai ini kalau ada dua barang dengan nama sama' },
    {
      header: 'Nama Barang',
      hint: 'nama persis seperti di Data Master (wajib kalau SKU kosong)',
      required: true,
    },
    { header: 'Jumlah', hint: 'angka, mis. 20 atau 12,5', required: true },
    { header: 'Harga Perkiraan', hint: 'opsional — angka rupiah tanpa "Rp", mis. 25000' },
    { header: 'Saran Supplier', hint: 'opsional — nama supplier persis seperti di daftar' },
  ];

  function mapLineRow(
    row: CsvRecord,
  ): { ok: true; line: LineDraft } | { ok: false; error: string } {
    const item = resolveItem(itemIndex, { sku: row.get('SKU'), name: row.get('Nama Barang') });
    if (!item) {
      const typed = row.get('SKU') || row.get('Nama Barang');
      if (!typed) return { ok: false, error: t('lineImport.missingItem') };
      return { ok: false, error: t('lineImport.unknownItem', { value: typed }) };
    }
    // Resolved against the loaded item, never from the file — see the note above.
    const full = items.find((i) => i.id === item.id);
    if (!full) return { ok: false, error: t('lineImport.unknownItem', { value: item.name }) };

    const qtyText = row.get('Jumlah');
    if (!qtyText) return { ok: false, error: t('lineImport.missingQty') };
    const qty = parseDecimal(qtyText);
    if (qty === null) return { ok: false, error: t('lineImport.invalidQty', { value: qtyText }) };
    if (qty.startsWith('-')) return { ok: false, error: t('lineImport.negativeQty') };

    const priceText = row.get('Harga Perkiraan');
    let estPrice: Money | null = null;
    if (priceText) {
      const parsed = parseDecimal(priceText);
      if (parsed === null) {
        return { ok: false, error: t('lineImport.invalidPrice', { value: priceText }) };
      }
      estPrice = parsed as Money;
    }

    const supplierText = row.get('Saran Supplier');
    let suggestedSupplierId = '';
    if (supplierText) {
      const supplier = resolveNamed(supplierIndex, supplierText);
      // A named-but-unknown supplier is an ERROR, not a silent blank: the
      // suggestion is what the buyer works from, and dropping it turns a
      // deliberate instruction into an omission nobody sees.
      if (!supplier) {
        return { ok: false, error: t('lineImport.unknownSupplier', { value: supplierText }) };
      }
      suggestedSupplierId = supplier.id;
    }

    return {
      ok: true,
      line: {
        itemId: full.id,
        qty: qty as Qty,
        unitId: full.baseUnit.id,
        estPrice,
        suggestedSupplierId,
      },
    };
  }

  const hasTypedLines = lines.some((l) => l.itemId || l.qty || l.estPrice);

  function updateLine(idx: number, patch: Partial<LineDraft>) {
    setLines((ls) =>
      ls.map((l, i) => {
        if (i !== idx) return l;
        const next = { ...l, ...patch };
        if (patch.itemId) {
          const item = items.find((it) => it.id === patch.itemId);
          if (item) next.unitId = item.baseUnit.id;
        }
        return next;
      }),
    );
  }

  const validLines = lines.filter((l) => l.itemId && l.qty && l.unitId);

  async function submit() {
    if (!locationId || validLines.length === 0) {
      setError(t('validation.required'));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const body = {
        locationId,
        neededBy: neededBy || undefined,
        lines: validLines.map((l) => ({
          itemId: l.itemId,
          qty: l.qty as string,
          unitId: l.unitId,
          estPrice: l.estPrice ?? undefined,
          suggestedSupplierId: l.suggestedSupplierId || undefined,
        })),
      };
      if (existing) {
        await updatePurchaseRequest(existing.id, body);
      } else {
        await createPurchaseRequest(body);
      }
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
      title={
        isEdit
          ? t('purchasing.requests.editTitle', { number: existing!.prNumber })
          : t('purchasing.requests.createTitle')
      }
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={submit}
            loading={submitting}
            disabled={!locationId || validLines.length === 0}
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error && <p className="text-sm text-danger-600">{error}</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          {/* Destination is a GUDANG, not any location (owner, 2026-08-21:
              "input the delivery destination based on the gudang available").
              Purchased goods are received into a warehouse; offering all ~20
              outlets here invited a PR nobody could receive. Falls back to the
              full list only if no warehouse is returned at all, so a
              misconfigured location table blocks nothing silently. */}
          <SearchableSelect
            label={t('purchasing.requests.destination')}
            value={locationId}
            onValueChange={setLocationId}
            options={destinationOptions}
            placeholder={t('common.selectPlaceholder')}
            hint={warehouses.length > 0 ? t('purchasing.requests.destinationHint') : undefined}
            required
          />
          <Input
            label={t('purchasing.requests.neededBy')}
            type="date"
            value={neededBy}
            onChange={(e) => setNeededBy(e.target.value)}
          />
        </div>

        <div className="flex flex-col gap-3">
          {lines.map((line, idx) => (
            <div
              key={idx}
              className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-2"
            >
              <SearchableSelect
                label={t('purchasing.requests.item')}
                value={line.itemId}
                options={itemOptions}
                onValueChange={(v) => updateLine(idx, { itemId: v })}
                placeholder={t('common.selectPlaceholder')}
              />
              <QtyInput
                label={t('purchasing.requests.qty')}
                value={line.qty}
                onChange={(v) => updateLine(idx, { qty: v })}
              />
              <MoneyInput
                label={t('purchasing.requests.estPrice')}
                value={line.estPrice}
                onChange={(v) => updateLine(idx, { estPrice: v })}
              />
              <SearchableSelect
                label={t('purchasing.requests.suggestedSupplier')}
                value={line.suggestedSupplierId}
                options={supplierOptions}
                onValueChange={(v) => updateLine(idx, { suggestedSupplierId: v })}
                placeholder={t('common.selectPlaceholder')}
              />
              {lines.length > 1 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="justify-self-start sm:col-span-2"
                  onClick={() => setLines((ls) => ls.filter((_, i) => i !== idx))}
                >
                  {t('common.remove')}
                </Button>
              )}
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              leftIcon={<Plus className="size-4" />}
              onClick={() => setLines((ls) => [...ls, { ...EMPTY_LINE }])}
            >
              {t('purchasing.requests.addLine')}
            </Button>
            <LineImportButton<LineDraft>
              title={t('purchasing.tabs.requests')}
              templateBase="baris-permintaan-pembelian"
              columns={importColumns}
              mapRow={mapLineRow}
              hasExistingLines={hasTypedLines}
              onLines={(imported, mode) =>
                setLines((ls) => (mode === 'replace' ? imported : [...ls, ...imported]))
              }
            />
          </div>
        </div>
      </div>
    </Modal>
  );
}

function RequestDrawer({
  id,
  locations,
  canApprove,
  canSubmit,
  onCreatePo,
  onClose,
  onChanged,
}: {
  id: string;
  locations: LocationOption[];
  canApprove: boolean;
  canSubmit: boolean;
  onCreatePo?: (prId: string) => void;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [pr, setPr] = useState<PurchaseRequestDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [note, setNote] = useState('');
  const [editOpen, setEditOpen] = useState(false);
  // The audit trail is loaded lazily: most people open a PR to read its lines,
  // not its history, and it is one more round trip per open.
  const [history, setHistory] = useState<PurchaseRequestHistoryEntry[] | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setLoadError(null);
    getPurchaseRequest(id)
      .then(setPr)
      .catch((err) => setLoadError(errMsg(err, t('auth.genericError'))))
      .finally(() => setLoading(false));
  }
  useEffect(load, [id]);

  function toggleHistory() {
    const next = !historyOpen;
    setHistoryOpen(next);
    if (next && history === null) {
      setHistoryError(null);
      getPurchaseRequestHistory(id)
        .then(setHistory)
        .catch((err) => setHistoryError(errMsg(err, t('table.error'))));
    }
  }

  async function doSubmit() {
    setBusy('submit');
    setError(null);
    try {
      await submitPurchaseRequest(id);
      toast({ title: t('purchasing.requests.submitSuccess'), variant: 'success' });
      load();
      onChanged();
    } catch (err) {
      setError(errMsg(err, t('auth.genericError')));
    } finally {
      setBusy(null);
    }
  }

  async function doApprove() {
    setBusy('approve');
    setError(null);
    try {
      await approvePurchaseRequest(id, { note: note || undefined });
      toast({ title: t('purchasing.requests.approveSuccess'), variant: 'success' });
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
      await rejectPurchaseRequest(id, { reason: rejectReason });
      toast({ title: t('purchasing.requests.rejectSuccess'), variant: 'success' });
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
      title={pr?.prNumber ?? t('purchasing.requests.detailTitle')}
      size="lg"
    >
      {loading ? (
        <p className="text-sm text-text-muted">{t('common.loading')}</p>
      ) : loadError || !pr ? (
        <EmptyState title={loadError ?? t('table.error')} size="sm" />
      ) : (
        <div className="flex flex-col gap-6">
          {error && <p className="text-sm text-danger-600">{error}</p>}

          <section className="flex flex-col gap-2">
            <StatusBadge domain="purchaseRequest" status={pr.status} size="md" />
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-text-muted">{t('purchasing.requests.columnLocation')}</dt>
              <dd className="text-text-primary">{pr.locationName}</dd>
              <dt className="text-text-muted">{t('purchasing.requests.columnNeededBy')}</dt>
              <dd className="text-text-primary">{pr.neededBy ? fmtDate(pr.neededBy) : '—'}</dd>
              {/* WHO TOUCHED THIS (owner, 2026-08-21). Creation and last edit
                  here; every approval decision in the timeline below; the full
                  before/after narrative behind "Riwayat Perubahan". */}
              <dt className="text-text-muted">{t('purchasing.requests.createdBy')}</dt>
              <dd className="text-text-primary">
                {pr.requestedBy} · {fmtDateTime(pr.createdAt)}
              </dd>
              <dt className="text-text-muted">{t('purchasing.requests.updatedBy')}</dt>
              <dd className="text-text-primary">
                {pr.updatedBy ? `${pr.updatedBy} · ${fmtDateTime(pr.updatedAt)}` : '—'}
              </dd>
              {pr.sourceReplenishmentNumber && (
                <>
                  <dt className="text-text-muted">{t('purchasing.requests.sourceRequest')}</dt>
                  <dd className="text-text-primary">{pr.sourceReplenishmentNumber}</dd>
                </>
              )}
              {pr.rejectionReason && (
                <>
                  <dt className="text-text-muted">{t('purchasing.requests.rejectReason')}</dt>
                  <dd className="text-danger-600">{pr.rejectionReason}</dd>
                </>
              )}
            </dl>
          </section>

          <section className="flex flex-col gap-2 border-t border-border pt-4">
            <h3 className="text-sm font-semibold text-text-primary">
              {t('purchasing.requests.lines')}
            </h3>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-text-muted">
                  <th className="pb-1 font-normal">{t('purchasing.requests.item')}</th>
                  <th className="pb-1 text-right font-normal">{t('purchasing.requests.qty')}</th>
                  <th className="pb-1 text-right font-normal">
                    {t('purchasing.requests.estPrice')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {pr.lines.map((l) => (
                  <tr key={l.id} className="border-t border-border">
                    <td className="py-1.5 text-text-primary">{l.itemName}</td>
                    <td className="py-1.5 text-right text-text-primary">
                      {l.qty} {l.unitCode}
                    </td>
                    <td className="py-1.5 text-right text-text-primary">
                      {formatMoney(l.estPrice)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {pr.approval && (
            <section className="flex flex-col gap-2 border-t border-border pt-4">
              <h3 className="text-sm font-semibold text-text-primary">
                {t('purchasing.requests.approvalTitle')}
              </h3>
              <ApprovalTimeline steps={pr.approval.steps} />
            </section>
          )}

          {/* Editable only while it is still the requester's document — the
              server enforces the same rule and answers 409 otherwise. */}
          {canSubmit &&
            (pr.status === PurchaseRequestStatus.DRAFT ||
              pr.status === PurchaseRequestStatus.REJECTED) && (
              <section className="flex flex-col gap-2 border-t border-border pt-4">
                <Button
                  size="sm"
                  variant="outline"
                  leftIcon={<Pencil className="size-4" />}
                  onClick={() => setEditOpen(true)}
                  className="self-start"
                >
                  {t('purchasing.requests.editButton')}
                </Button>
                {pr.status === PurchaseRequestStatus.REJECTED && (
                  <p className="text-xs text-text-muted">
                    {t('purchasing.requests.editRejectedHint')}
                  </p>
                )}
              </section>
            )}

          {/* An approved PR's next step is a PO — so offer it here, where the
              person who just read the approval is standing, rather than making
              them re-find the document in another tab. */}
          {pr.status === PurchaseRequestStatus.APPROVED && onCreatePo && (
            <PermissionGate permission="purchasing.po.create">
              <section className="flex flex-col gap-2 border-t border-border pt-4">
                <Button
                  size="sm"
                  leftIcon={<ArrowRightLeft className="size-4" />}
                  onClick={() => {
                    onCreatePo(pr.id);
                    onClose();
                  }}
                  className="self-start"
                >
                  {t('purchasing.requests.createPoButton')}
                </Button>
                <p className="text-xs text-text-muted">{t('purchasing.requests.createPoHint')}</p>
              </section>
            </PermissionGate>
          )}

          <section className="flex flex-col gap-2 border-t border-border pt-4">
            <Button
              size="sm"
              variant="ghost"
              leftIcon={<History className="size-4" />}
              onClick={toggleHistory}
              className="self-start"
            >
              {t('purchasing.requests.historyTitle')}
            </Button>
            {historyOpen && (
              <>
                {historyError && <p className="text-sm text-danger-600">{historyError}</p>}
                {!historyError && history === null && (
                  <p className="text-sm text-text-muted">{t('common.loading')}</p>
                )}
                {history?.length === 0 && (
                  <p className="text-sm text-text-muted">{t('purchasing.requests.historyEmpty')}</p>
                )}
                {history && history.length > 0 && (
                  <ol className="flex flex-col gap-2">
                    {history.map((h) => (
                      <li key={h.id} className="border-l-2 border-border pl-3 text-sm">
                        <p className="text-text-primary">{historyLabel(h.action, t)}</p>
                        <p className="text-xs text-text-muted">
                          {h.actedBy ?? '—'}
                          {h.roleKey ? ` · ${t(`role.${h.roleKey}`)}` : ''} ·{' '}
                          {fmtDateTime(h.occurredAt)}
                        </p>
                        {h.reason && <p className="text-xs text-text-secondary">{h.reason}</p>}
                      </li>
                    ))}
                  </ol>
                )}
              </>
            )}
          </section>

          {editOpen && (
            <CreateRequestModal
              locations={locations}
              existing={pr}
              onClose={() => setEditOpen(false)}
              onCreated={() => {
                setEditOpen(false);
                // History is now stale — drop it so the next open refetches.
                setHistory(null);
                toast({ title: t('purchasing.requests.editSuccess'), variant: 'success' });
                load();
                onChanged();
              }}
            />
          )}

          {pr.status === PurchaseRequestStatus.DRAFT && canSubmit && (
            <section className="flex flex-col gap-2 border-t border-border pt-4">
              <Button
                size="sm"
                onClick={doSubmit}
                loading={busy === 'submit'}
                className="self-start"
              >
                {t('purchasing.requests.submitButton')}
              </Button>
            </section>
          )}

          {pr.status === PurchaseRequestStatus.SUBMITTED && canApprove && (
            <section className="flex flex-col gap-2 border-t border-border pt-4">
              <h3 className="text-sm font-semibold text-text-primary">
                {t('purchasing.requests.decideTitle')}
              </h3>
              <Textarea
                label={t('purchasing.requests.note')}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={doApprove} loading={busy === 'approve'}>
                  {t('purchasing.requests.approveButton')}
                </Button>
                <Button size="sm" variant="danger" onClick={() => setRejectOpen(true)}>
                  {t('purchasing.requests.rejectButton')}
                </Button>
              </div>
            </section>
          )}
        </div>
      )}

      {rejectOpen && (
        <Modal
          open
          onClose={() => setRejectOpen(false)}
          title={t('purchasing.requests.rejectTitle')}
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
                {t('purchasing.requests.rejectButton')}
              </Button>
            </>
          }
        >
          <Textarea
            label={t('purchasing.requests.rejectReason')}
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            required
          />
        </Modal>
      )}
    </Drawer>
  );
}
