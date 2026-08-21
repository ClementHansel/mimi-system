'use client';

import { useEffect, useRef, useState } from 'react';
import { Plus, Upload } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { ApiError } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { PurchaseOrderStatus, PurchaseRequestStatus } from '@/lib/shared-types';
import type { Money, Qty } from '@/lib/shared-types';
import { fmtDate } from '@/lib/dates';
import { formatMoney } from '@/lib/formatters';
import { toast } from '@/components/ui/Toast';
import { DataTable, type DataTableColumn } from '@/components/ui/DataTable';
import { Select } from '@/components/ui/Select';
import { SearchableSelect } from '@/components/ui/SearchableSelect';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Drawer } from '@/components/ui/Drawer';
import { Textarea } from '@/components/ui/Textarea';
import { QtyInput } from '@/components/ui/QtyInput';
import { MoneyInput } from '@/components/ui/MoneyInput';
import { FileUpload } from '@/components/ui/FileUpload';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { ApprovalTimeline } from '@/components/ui/ApprovalTimeline';
import { PermissionGate } from '@/components/ui/PermissionGate';
import { EmptyState } from '@/components/ui/EmptyState';
import { useApiList } from '@/components/admin/useApiList';
import { uploadAttachment } from './lib/attachments';
import {
  getLocations,
  getItems,
  getSuppliers,
  getStorageAreas,
  listPurchaseRequests,
  getPurchaseRequest,
  getPurchaseOrder,
  createPurchaseOrder,
  submitPurchaseOrder,
  approvePurchaseOrder,
  rejectPurchaseOrder,
  issuePurchaseOrder,
  receivePurchaseOrder,
  cancelPurchaseOrder,
  closePurchaseOrder,
} from './lib/api';
import type {
  Item,
  LocationOption,
  StorageArea,
  PurchaseOrderListRow,
  PurchaseOrderDetail,
  PurchaseRequestListRow,
} from './lib/types';

function errMsg(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

const todayIso = () => new Date().toISOString().slice(0, 10);

interface LineDraft {
  itemId: string;
  qtyOrdered: Qty | null;
  unitId: string;
  unitPrice: Money | null;
}

const EMPTY_LINE: LineDraft = { itemId: '', qtyOrdered: null, unitId: '', unitPrice: null };

/**
 * FR-PO-01..04 — Purchase Orders + receiving. Draft -> pending_approval ->
 * approved -> issued -> partially_received/received -> closed, with
 * cancelled reachable from any pre-received state (§5.3, §5's status table).
 * Unit price / line total / subtotal / tax / total are shown ONLY when
 * `supplier.price.read` is granted (D-20/Amendment 3) — a `leader_outlet`
 * has `purchasing.po.receive` but NOT `supplier.price.read` per the role
 * matrix (CONTRACTS §3), so receiving must work with quantities/storage
 * areas alone, never blocked on price visibility.
 */
export function PurchaseOrdersPanel({
  fromPrId,
  onFromPrConsumed,
}: {
  /** An approved PR to open the create form with, handed over by the shell. */
  fromPrId?: string | null;
  onFromPrConsumed?: () => void;
} = {}) {
  const { t } = useI18n();
  const { can } = usePermissions();
  const canSeePrice = can('supplier.price.read');

  const [supplierId, setSupplierId] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const { data, loading, error, reload } = useApiList<PurchaseOrderListRow>('/purchasing/orders', {
    supplierId,
    status,
    page,
    pageSize,
  });

  const [suppliers, setSuppliers] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    const load = can('supplier.read')
      ? getSuppliers()
      : Promise.resolve({ rows: [] as { id: string; name: string }[] });
    load.then((r) => setSuppliers(r.rows)).catch(() => {});
  }, [can]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  // Arriving from an approved PR's "Buat PO": open the form on that PR, then
  // tell the shell to forget it so returning to this tab later is a plain list.
  useEffect(() => {
    if (fromPrId) setCreateOpen(true);
  }, [fromPrId]);

  const columns: DataTableColumn<PurchaseOrderListRow>[] = [
    { key: 'poNumber', header: t('purchasing.orders.columnNumber') },
    { key: 'supplierName', header: t('purchasing.orders.columnSupplier') },
    {
      key: 'orderDate',
      header: t('purchasing.orders.columnOrderDate'),
      render: (r) => fmtDate(r.orderDate),
    },
    {
      key: 'expectedDate',
      header: t('purchasing.orders.columnExpectedDate'),
      render: (r) => (r.expectedDate ? fmtDate(r.expectedDate) : '—'),
    },
    ...(canSeePrice
      ? [
          {
            key: 'total',
            header: t('purchasing.orders.columnTotal'),
            align: 'right' as const,
            render: (r: PurchaseOrderListRow) => formatMoney(r.total),
          },
        ]
      : []),
    {
      key: 'status',
      header: t('purchasing.orders.columnStatus'),
      render: (r) => <StatusBadge domain="purchaseOrder" status={r.status} />,
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-2">
          {suppliers.length > 0 && (
            <Select
              value={supplierId}
              onValueChange={(v) => {
                setSupplierId(v);
                setPage(1);
              }}
              placeholder={t('purchasing.filterSupplierAll')}
              options={suppliers.map((s) => ({ value: s.id, label: s.name }))}
              wrapperClassName="w-56"
            />
          )}
          <Select
            value={status}
            onValueChange={(v) => {
              setStatus(v);
              setPage(1);
            }}
            placeholder={t('purchasing.orders.filterStatusAll')}
            options={Object.values(PurchaseOrderStatus).map((v) => ({
              value: v,
              label: t(`status.purchaseOrder.${v}`),
            }))}
            wrapperClassName="w-48"
          />
        </div>
        <PermissionGate permission="purchasing.po.create">
          <Button leftIcon={<Plus className="size-4" />} onClick={() => setCreateOpen(true)}>
            {t('purchasing.orders.createButton')}
          </Button>
        </PermissionGate>
      </div>

      <DataTable
        columns={columns}
        data={data}
        keyField={(r) => r.id}
        loading={loading}
        error={error}
        emptyDescription={t('purchasing.orders.empty')}
        onRowClick={(r) => setSelectedId(r.id)}
        onPageChange={setPage}
        onPageSizeChange={(n) => {
          setPageSize(n);
          setPage(1);
        }}
      />

      {createOpen && (
        <CreateOrderModal
          initialPrId={fromPrId ?? undefined}
          canSeePrice={canSeePrice}
          onClose={() => {
            setCreateOpen(false);
            // Consumed either way — a cancelled conversion must not reopen the
            // form the next time this tab is visited.
            onFromPrConsumed?.();
          }}
          onCreated={() => {
            setCreateOpen(false);
            onFromPrConsumed?.();
            reload();
            toast({ title: t('purchasing.orders.createSuccess'), variant: 'success' });
          }}
        />
      )}

      {selectedId && (
        <OrderDrawer
          id={selectedId}
          canSeePrice={canSeePrice}
          canCreate={can('purchasing.po.create')}
          canApprove={can('purchasing.po.approve')}
          canReceive={can('purchasing.po.receive')}
          canClose={can('purchasing.po.close')}
          onClose={() => setSelectedId(null)}
          onChanged={reload}
        />
      )}
    </div>
  );
}

function CreateOrderModal({
  canSeePrice,
  initialPrId,
  onClose,
  onCreated,
}: {
  canSeePrice: boolean;
  /** Opened from an approved PR — prefill from it on mount. */
  initialPrId?: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useI18n();
  const { can } = usePermissions();
  const [supplierId, setSupplierId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [prId, setPrId] = useState('');
  const [orderDate, setOrderDate] = useState(todayIso());
  const [expectedDate, setExpectedDate] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([{ ...EMPTY_LINE }]);
  const [items, setItems] = useState<Item[]>([]);
  const [locations, setLocations] = useState<LocationOption[]>([]);
  const [suppliers, setSuppliers] = useState<{ id: string; name: string }[]>([]);
  const [approvedPrs, setApprovedPrs] = useState<PurchaseRequestListRow[]>([]);
  const [prLoading, setPrLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  /**
   * PR -> PO, for real (owner, 2026-08-21: "later PR to PO").
   *
   * The PR picker already existed but only stamped `prId` on the PO — the buyer
   * still retyped every line from the approved request into this form, which is
   * both the slowest and the most error-prone way to do the one thing the two
   * documents exist to do together.
   *
   * Picking a PR now copies its destination and its lines across. Prices come
   * over as the PR's ESTIMATE and must be confirmed: an estimate is what the
   * requester guessed, a PO price is what the supplier charges, and shipping
   * the guess as a commitment is exactly the mistake this must not make — so
   * the hint under the picker says so, and lines with no estimate arrive blank
   * rather than as 0.
   */
  async function applyPr(nextPrId: string) {
    setPrId(nextPrId);
    if (!nextPrId) return;
    setPrLoading(true);
    setError(null);
    try {
      const pr = await getPurchaseRequest(nextPrId);
      setLocationId(pr.locationId);
      setLines(
        pr.lines.map((l) => ({
          itemId: l.itemId,
          qtyOrdered: l.qty,
          unitId: l.unitId,
          // '0.00' is the "not priced yet" marker a converted PR carries, and a
          // zero-priced PO line would fail validation anyway — so leave it empty
          // and make the buyer type the real figure.
          unitPrice: l.estPrice && l.estPrice !== '0.00' ? l.estPrice : null,
        })),
      );
      // Only when the PR agrees with itself: several lines suggesting different
      // suppliers is a real case (one PR, two POs), and guessing one of them
      // would silently drop the others.
      const suggested = [...new Set(pr.lines.map((l) => l.suggestedSupplierId).filter(Boolean))];
      if (suggested.length === 1) setSupplierId(suggested[0]!);
    } catch (err) {
      setError(errMsg(err, t('auth.genericError')));
    } finally {
      setPrLoading(false);
    }
  }

  useEffect(() => {
    getItems()
      .then((r) => setItems(r.rows))
      .catch(() => {});
    getLocations()
      .then((r) => setLocations(r.rows))
      .catch(() => {});
    if (can('supplier.read'))
      getSuppliers()
        .then((r) => setSuppliers(r.rows))
        .catch(() => {});
    listPurchaseRequests({ status: PurchaseRequestStatus.APPROVED })
      .then((r) => setApprovedPrs(r.rows))
      .catch(() => {});
  }, [can]);

  // Opened from an approved PR: prefill from it exactly once. Runs on mount
  // only — a later change to `initialPrId` would mean a different modal.
  const appliedInitialPr = useRef(false);
  useEffect(() => {
    if (!initialPrId || appliedInitialPr.current) return;
    appliedInitialPr.current = true;
    void applyPr(initialPrId);
    // Deliberately keyed on `initialPrId` alone: `applyPr` is redeclared every
    // render, so depending on it would refetch the PR continuously. The
    // `appliedInitialPr` guard above is what makes that safe.
  }, [initialPrId]);

  const itemOptions = items.map((i) => ({ value: i.id, label: `${i.name} (${i.baseUnit.code})` }));

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

  const validLines = lines.filter((l) => l.itemId && l.qtyOrdered && l.unitId && l.unitPrice);
  const canSubmit = supplierId && locationId && orderDate && validLines.length > 0 && !submitting;

  async function submit() {
    if (!canSubmit) {
      setError(t('validation.required'));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await createPurchaseOrder({
        supplierId,
        locationId,
        prId: prId || undefined,
        orderDate,
        expectedDate: expectedDate || undefined,
        notes: notes || undefined,
        lines: validLines.map((l) => ({
          itemId: l.itemId,
          qtyOrdered: l.qtyOrdered as string,
          unitId: l.unitId,
          unitPrice: l.unitPrice as string,
        })),
      });
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
      title={t('purchasing.orders.createTitle')}
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} loading={submitting} disabled={!canSubmit}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error && <p className="text-sm text-danger-600">{error}</p>}
        {!canSeePrice && (
          <p className="rounded-md bg-warning-50 p-2 text-sm text-warning-700">
            {t('purchasing.orders.priceHiddenNotice')}
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Select
            label={t('purchasing.orders.supplier')}
            value={supplierId}
            onValueChange={setSupplierId}
            options={suppliers.map((s) => ({ value: s.id, label: s.name }))}
            placeholder={t('common.selectPlaceholder')}
            required
          />
          <Select
            label={t('purchasing.orders.location')}
            value={locationId}
            onValueChange={setLocationId}
            options={locations.map((l) => ({ value: l.id, label: l.name }))}
            placeholder={t('common.selectPlaceholder')}
            required
          />
          <SearchableSelect
            label={t('purchasing.orders.fromPr')}
            value={prId}
            onValueChange={applyPr}
            options={approvedPrs.map((p) => ({
              value: p.id,
              label: p.prNumber,
              hint: `${p.locationName} · ${t('purchasing.requests.columnLines')}: ${p.lineCount}`,
            }))}
            placeholder={t('purchasing.orders.fromPrNone')}
            hint={prLoading ? t('common.loading') : t('purchasing.orders.fromPrHint')}
          />
          <Input
            label={t('purchasing.orders.orderDate')}
            type="date"
            value={orderDate}
            onChange={(e) => setOrderDate(e.target.value)}
            required
          />
          <Input
            label={t('purchasing.orders.expectedDate')}
            type="date"
            value={expectedDate}
            onChange={(e) => setExpectedDate(e.target.value)}
          />
        </div>
        <Textarea
          label={t('purchasing.orders.notes')}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />

        <div className="flex flex-col gap-3">
          {lines.map((line, idx) => (
            <div
              key={idx}
              className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-2"
            >
              <SearchableSelect
                label={t('purchasing.orders.item')}
                value={line.itemId}
                options={itemOptions}
                onValueChange={(v) => updateLine(idx, { itemId: v })}
                placeholder={t('common.selectPlaceholder')}
              />
              <QtyInput
                label={t('purchasing.orders.qtyOrdered')}
                value={line.qtyOrdered}
                onChange={(v) => updateLine(idx, { qtyOrdered: v })}
              />
              <MoneyInput
                label={t('purchasing.orders.unitPrice')}
                value={line.unitPrice}
                onChange={(v) => updateLine(idx, { unitPrice: v })}
                disabled={!canSeePrice}
                required
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
          <Button
            type="button"
            variant="outline"
            size="sm"
            leftIcon={<Plus className="size-4" />}
            onClick={() => setLines((ls) => [...ls, { ...EMPTY_LINE }])}
          >
            {t('purchasing.orders.addLine')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

interface ReceiveLineDraft {
  qtyReceived: Qty | null;
  storageAreaId: string;
  conditionNotes: string;
}

function OrderDrawer({
  id,
  canSeePrice,
  canCreate,
  canApprove,
  canReceive,
  canClose,
  onClose,
  onChanged,
}: {
  id: string;
  canSeePrice: boolean;
  canCreate: boolean;
  canApprove: boolean;
  canReceive: boolean;
  canClose: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [po, setPo] = useState<PurchaseOrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [note, setNote] = useState('');

  const [receiveOpen, setReceiveOpen] = useState(false);
  const [receiveLines, setReceiveLines] = useState<Record<string, ReceiveLineDraft>>({});
  const [receivePhotos, setReceivePhotos] = useState<File[]>([]);
  const [receiveNotes, setReceiveNotes] = useState('');
  const [areas, setAreas] = useState<StorageArea[]>([]);
  const [receiving, setReceiving] = useState(false);

  function load() {
    setLoading(true);
    setLoadError(null);
    getPurchaseOrder(id)
      .then(setPo)
      .catch((err) => setLoadError(errMsg(err, t('auth.genericError'))))
      .finally(() => setLoading(false));
  }
  useEffect(load, [id]);

  useEffect(() => {
    if (po?.locationId)
      getStorageAreas(po.locationId)
        .then(setAreas)
        .catch(() => {});
  }, [po?.locationId]);

  async function run(key: string, fn: () => Promise<PurchaseOrderDetail>, successKey: string) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      toast({ title: t(successKey), variant: 'success' });
      load();
      onChanged();
    } catch (err) {
      setError(errMsg(err, t('auth.genericError')));
    } finally {
      setBusy(null);
    }
  }

  function openReceive() {
    if (!po) return;
    const due = po.lines.filter((l) => l.qtyDifference !== '0.000' && Number(l.qtyDifference) > 0);
    setReceiveLines(
      Object.fromEntries(
        (due.length > 0 ? due : po.lines).map((l) => [
          l.id,
          { qtyReceived: l.qtyDifference, storageAreaId: '', conditionNotes: '' },
        ]),
      ),
    );
    setReceivePhotos([]);
    setReceiveNotes('');
    setReceiveOpen(true);
  }

  async function submitReceive() {
    if (!po || receivePhotos.length === 0) return;
    const entries = Object.entries(receiveLines).filter(
      ([, l]) => l.qtyReceived && l.storageAreaId,
    );
    if (entries.length === 0) {
      toast({ title: t('validation.required'), variant: 'warning' });
      return;
    }
    setReceiving(true);
    setError(null);
    try {
      const photoAttachmentIds = await Promise.all(
        receivePhotos.map((f) =>
          uploadAttachment({
            file: f,
            fileName: f.name,
            mimeType: f.type || 'image/jpeg',
            kind: 'receiving_photo',
          }),
        ),
      );
      await receivePurchaseOrder(po.id, {
        lines: entries.map(([poLineId, l]) => ({
          poLineId,
          qtyReceived: l.qtyReceived as string,
          storageAreaId: l.storageAreaId,
          conditionNotes: l.conditionNotes || undefined,
        })),
        photoAttachmentIds,
        notes: receiveNotes || undefined,
      });
      toast({ title: t('purchasing.orders.receiveSuccess'), variant: 'success' });
      setReceiveOpen(false);
      load();
      onChanged();
    } catch (err) {
      setError(errMsg(err, t('auth.genericError')));
    } finally {
      setReceiving(false);
    }
  }

  const areaOptions = areas.map((a) => ({ value: a.id, label: a.name }));

  return (
    <Drawer
      open
      onClose={onClose}
      title={po?.poNumber ?? t('purchasing.orders.detailTitle')}
      size="lg"
    >
      {loading ? (
        <p className="text-sm text-text-muted">{t('common.loading')}</p>
      ) : loadError || !po ? (
        <EmptyState title={loadError ?? t('table.error')} size="sm" />
      ) : (
        <div className="flex flex-col gap-6">
          {error && <p className="text-sm text-danger-600">{error}</p>}

          <section className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <StatusBadge domain="purchaseOrder" status={po.status} size="md" />
              {canSeePrice && (
                <span className="text-lg font-semibold tabular-nums text-text-primary">
                  {formatMoney(po.total)}
                </span>
              )}
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-text-muted">{t('purchasing.orders.columnSupplier')}</dt>
              <dd className="text-text-primary">{po.supplierName}</dd>
              <dt className="text-text-muted">{t('purchasing.orders.columnOrderDate')}</dt>
              <dd className="text-text-primary">{fmtDate(po.orderDate)}</dd>
              <dt className="text-text-muted">{t('purchasing.orders.columnExpectedDate')}</dt>
              <dd className="text-text-primary">
                {po.expectedDate ? fmtDate(po.expectedDate) : '—'}
              </dd>
              <dt className="text-text-muted">{t('purchasing.orders.paymentStatusLabel')}</dt>
              <dd className="text-text-primary">
                {/* `paymentStatus` currently also reads back `null` for kepala_gudang because of an RLS
                    gap being fixed in parallel (lib/types.ts doc) — either way, `null` renders as a
                    genuine "not available" state here, never as a silently-wrong "unpaid" badge. */}
                {po.paymentStatus === null ? (
                  <span className="text-text-muted">
                    {t('purchasing.orders.paymentStatusUnavailable')}
                  </span>
                ) : (
                  <StatusBadge domain="payment" status={po.paymentStatus} size="sm" />
                )}
              </dd>
              {po.cancelReason && (
                <>
                  <dt className="text-text-muted">{t('purchasing.orders.cancelReason')}</dt>
                  <dd className="text-danger-600">{po.cancelReason}</dd>
                </>
              )}
            </dl>
          </section>

          {po.approval && (
            <section className="flex flex-col gap-2 border-t border-border pt-4">
              <h3 className="text-sm font-semibold text-text-primary">
                {t('purchasing.orders.approvalTitle')}
              </h3>
              <ApprovalTimeline steps={po.approval.steps} />
            </section>
          )}

          <section className="flex flex-col gap-2 border-t border-border pt-4">
            <h3 className="text-sm font-semibold text-text-primary">
              {t('purchasing.orders.lines')}
            </h3>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-text-muted">
                  <th className="pb-1 font-normal">{t('purchasing.orders.item')}</th>
                  <th className="pb-1 text-right font-normal">
                    {t('purchasing.orders.qtyOrdered')}
                  </th>
                  <th className="pb-1 text-right font-normal">
                    {t('purchasing.orders.qtyReceived')}
                  </th>
                  {canSeePrice && (
                    <th className="pb-1 text-right font-normal">
                      {t('purchasing.orders.unitPrice')}
                    </th>
                  )}
                  {canSeePrice && (
                    <th className="pb-1 text-right font-normal">
                      {t('purchasing.orders.lineTotal')}
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {po.lines.map((l) => (
                  <tr key={l.id} className="border-t border-border">
                    <td className="py-1.5 text-text-primary">{l.itemName}</td>
                    <td className="py-1.5 text-right text-text-primary">
                      {l.qtyOrdered} {l.unitCode}
                    </td>
                    <td className="py-1.5 text-right text-text-primary">
                      {l.qtyReceived} {l.unitCode}
                    </td>
                    {canSeePrice && (
                      <td className="py-1.5 text-right text-text-primary">
                        {formatMoney(l.unitPrice)}
                      </td>
                    )}
                    {canSeePrice && (
                      <td className="py-1.5 text-right text-text-primary">
                        {formatMoney(l.lineTotal)}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="flex flex-wrap gap-2 border-t border-border pt-4">
            {po.status === PurchaseOrderStatus.DRAFT && canCreate && (
              <Button
                size="sm"
                onClick={() =>
                  run('submit', () => submitPurchaseOrder(po.id), 'purchasing.orders.submitSuccess')
                }
                loading={busy === 'submit'}
              >
                {t('purchasing.orders.submitButton')}
              </Button>
            )}
            {po.status === PurchaseOrderStatus.PENDING_APPROVAL && canApprove && (
              <>
                <Textarea
                  label={t('purchasing.orders.note')}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  wrapperClassName="w-full"
                />
                <Button
                  size="sm"
                  onClick={() =>
                    run(
                      'approve',
                      () => approvePurchaseOrder(po.id, { note: note || undefined }),
                      'purchasing.orders.approveSuccess',
                    )
                  }
                  loading={busy === 'approve'}
                >
                  {t('purchasing.orders.approveButton')}
                </Button>
                <Button size="sm" variant="danger" onClick={() => setRejectOpen(true)}>
                  {t('purchasing.orders.rejectButton')}
                </Button>
              </>
            )}
            {po.status === PurchaseOrderStatus.APPROVED && canCreate && (
              <Button
                size="sm"
                onClick={() =>
                  run('issue', () => issuePurchaseOrder(po.id), 'purchasing.orders.issueSuccess')
                }
                loading={busy === 'issue'}
              >
                {t('purchasing.orders.issueButton')}
              </Button>
            )}
            {(po.status === PurchaseOrderStatus.ISSUED ||
              po.status === PurchaseOrderStatus.PARTIALLY_RECEIVED) &&
              canReceive && (
                <Button size="sm" onClick={openReceive}>
                  {t('purchasing.orders.receiveButton')}
                </Button>
              )}
            {po.status === PurchaseOrderStatus.RECEIVED && canClose && (
              <Button
                size="sm"
                onClick={() =>
                  run('close', () => closePurchaseOrder(po.id), 'purchasing.orders.closeSuccess')
                }
                loading={busy === 'close'}
              >
                {t('purchasing.orders.closeButton')}
              </Button>
            )}
            {![
              PurchaseOrderStatus.RECEIVED,
              PurchaseOrderStatus.CLOSED,
              PurchaseOrderStatus.CANCELLED,
            ].includes(po.status as PurchaseOrderStatus) &&
              canApprove && (
                <Button size="sm" variant="outline" onClick={() => setCancelOpen(true)}>
                  {t('purchasing.orders.cancelButton')}
                </Button>
              )}
          </section>
        </div>
      )}

      {rejectOpen && (
        <Modal
          open
          onClose={() => setRejectOpen(false)}
          title={t('purchasing.orders.rejectTitle')}
          footer={
            <>
              <Button variant="outline" onClick={() => setRejectOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="danger"
                disabled={!rejectReason}
                loading={busy === 'reject'}
                onClick={() =>
                  run(
                    'reject',
                    () => rejectPurchaseOrder(id, { reason: rejectReason }),
                    'purchasing.orders.rejectSuccess',
                  ).then(() => setRejectOpen(false))
                }
              >
                {t('purchasing.orders.rejectButton')}
              </Button>
            </>
          }
        >
          <Textarea
            label={t('purchasing.orders.rejectReason')}
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            required
          />
        </Modal>
      )}

      {cancelOpen && (
        <Modal
          open
          onClose={() => setCancelOpen(false)}
          title={t('purchasing.orders.cancelTitle')}
          footer={
            <>
              <Button variant="outline" onClick={() => setCancelOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="danger"
                disabled={!cancelReason}
                loading={busy === 'cancel'}
                onClick={() =>
                  run(
                    'cancel',
                    () => cancelPurchaseOrder(id, { reason: cancelReason }),
                    'purchasing.orders.cancelSuccess',
                  ).then(() => setCancelOpen(false))
                }
              >
                {t('purchasing.orders.cancelButton')}
              </Button>
            </>
          }
        >
          <Textarea
            label={t('purchasing.orders.cancelReason')}
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
            required
          />
        </Modal>
      )}

      {receiveOpen && po && (
        <Modal
          open
          onClose={() => setReceiveOpen(false)}
          title={t('purchasing.orders.receiveTitle')}
          size="lg"
          footer={
            <>
              <Button variant="outline" onClick={() => setReceiveOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button
                loading={receiving}
                disabled={receivePhotos.length === 0}
                onClick={submitReceive}
                leftIcon={<Upload className="size-4" />}
              >
                {t('purchasing.orders.receiveConfirm')}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-4">
            {po.lines
              .filter((l) => Number(l.qtyDifference) > 0 || Number(l.qtyReceived) === 0)
              .map((l) => {
                const draft = receiveLines[l.id];
                const discrepancy =
                  draft?.qtyReceived != null && draft.qtyReceived !== l.qtyDifference;
                return (
                  <div
                    key={l.id}
                    className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-3"
                  >
                    <span className="self-center text-sm font-medium text-text-primary sm:col-span-3">
                      {l.itemName} — {t('purchasing.orders.due')}: {l.qtyDifference} {l.unitCode}
                    </span>
                    <QtyInput
                      label={t('purchasing.orders.qtyReceived')}
                      value={draft?.qtyReceived ?? null}
                      onChange={(v) =>
                        setReceiveLines((prev) => ({
                          ...prev,
                          [l.id]: { ...prev[l.id]!, qtyReceived: v },
                        }))
                      }
                    />
                    <Select
                      label={t('purchasing.orders.storageArea')}
                      value={draft?.storageAreaId ?? ''}
                      options={areaOptions}
                      onValueChange={(v) =>
                        setReceiveLines((prev) => ({
                          ...prev,
                          [l.id]: { ...prev[l.id]!, storageAreaId: v },
                        }))
                      }
                      placeholder={t('common.selectPlaceholder')}
                    />
                    <Textarea
                      label={t('purchasing.orders.conditionNotes')}
                      required={discrepancy}
                      value={draft?.conditionNotes ?? ''}
                      onChange={(e) =>
                        setReceiveLines((prev) => ({
                          ...prev,
                          [l.id]: { ...prev[l.id]!, conditionNotes: e.target.value },
                        }))
                      }
                    />
                  </div>
                );
              })}
            <Textarea
              label={t('purchasing.orders.notes')}
              value={receiveNotes}
              onChange={(e) => setReceiveNotes(e.target.value)}
            />
            <FileUpload
              label={t('purchasing.orders.receivingPhotos')}
              accept="image/*"
              multiple
              value={receivePhotos}
              onChange={setReceivePhotos}
            />
          </div>
        </Modal>
      )}
    </Drawer>
  );
}
