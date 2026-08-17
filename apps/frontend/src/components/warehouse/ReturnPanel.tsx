'use client';

import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import {
  Button, Modal, DataTable, StatusBadge, Select, QtyInput, Textarea, PhotoCapture, Tabs, TabsList,
  TabsTrigger, TabsContent, toast, PermissionGate, EmptyState,
} from '@/components/ui';
import type { DataTableColumn } from '@/components/ui';
import { fmtDate } from '@/lib/dates';
import { ApiError } from '@/lib/api';
import { useWarehouseLocation } from './lib/use-warehouse-location';
import {
  getStorageAreas, getItems, getSupplierDirectory, listReturns, getReturn, createReturn, submitReturn, shipReturn, receiveReturnDoc,
} from './lib/warehouse-api';
import { uploadAttachment } from './lib/attachments';
import type { ReturnDoc, ReturnDetail, StorageArea, Item, SupplierDirectoryEntry } from './lib/types';
import type { Qty } from '@/lib/shared-types';

const CONDITIONS = ['damaged', 'expired', 'wrong_item', 'other'] as const;

interface ReturnLineDraft {
  itemId: string;
  storageAreaId: string;
  qty: Qty | null;
  condition: string;
  reason: string;
}

interface ReceiveLineDraft {
  qtyReceived: Qty | null;
  storageAreaId: string;
}

/**
 * Retur ke supplier (raise + track, FR-WST-01..04) and retur DARI outlet
 * (the warehouse-side receive step of the outlet→gudang leg, `return.receive`
 * — the other half of outlet's `WastePanel` retur tab).
 *
 * `POST /returns/:id/receive` binds each line via `Return.lines[].lineId`
 * (CONTRACTS §4.12) — no more inferring an identifier from `itemId`.
 */
export function ReturnPanel() {
  const { t } = useI18n();
  const { locationId } = useWarehouseLocation();
  const [areas, setAreas] = useState<StorageArea[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierDirectoryEntry[]>([]);

  const [supplierRows, setSupplierRows] = useState<ReturnDoc[]>([]);
  const [supplierLoading, setSupplierLoading] = useState(true);
  const [supplierError, setSupplierError] = useState<string | undefined>(undefined);
  const [createOpen, setCreateOpen] = useState(false);
  const [supplierId, setSupplierId] = useState('');
  const [lines, setLines] = useState<ReturnLineDraft[]>([{ itemId: '', storageAreaId: '', qty: null, condition: 'damaged', reason: '' }]);
  const [photo, setPhoto] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);

  const [outletRows, setOutletRows] = useState<ReturnDoc[]>([]);
  const [outletLoading, setOutletLoading] = useState(true);
  const [outletError, setOutletError] = useState<string | undefined>(undefined);
  const [receiveTarget, setReceiveTarget] = useState<ReturnDetail | null>(null);
  const [receiveLines, setReceiveLines] = useState<Record<string, ReceiveLineDraft>>({});
  const [receivePhoto, setReceivePhoto] = useState<File | null>(null);
  const [receiving, setReceiving] = useState(false);

  useEffect(() => {
    getItems().then((r) => setItems(r.rows));
    getSupplierDirectory().then((r) => setSuppliers(r.rows));
  }, []);
  useEffect(() => {
    if (locationId) getStorageAreas(locationId).then(setAreas);
  }, [locationId]);

  function reloadSupplierReturns() {
    setSupplierLoading(true);
    setSupplierError(undefined);
    // `ReturnDirection` (`@mimi/shared`) is `outlet_to_warehouse` |
    // `warehouse_to_supplier` — the previous Indonesian-slang values here
    // never matched the DTO's `@IsIn`, so every call 400'd with
    // ERR_VALIDATION (FIX-LOADS #2).
    listReturns({ direction: 'warehouse_to_supplier' })
      .then((r) => setSupplierRows(r.rows))
      .catch((err: unknown) => setSupplierError(err instanceof ApiError ? err.message : t('table.error')))
      .finally(() => setSupplierLoading(false));
  }
  function reloadOutletReturns() {
    setOutletLoading(true);
    setOutletError(undefined);
    listReturns({ direction: 'outlet_to_warehouse', status: 'in_transit' })
      .then((r) => setOutletRows(r.rows))
      .catch((err: unknown) => setOutletError(err instanceof ApiError ? err.message : t('table.error')))
      .finally(() => setOutletLoading(false));
  }
  useEffect(reloadSupplierReturns, []);
  useEffect(reloadOutletReturns, []);

  async function submitSupplierReturn() {
    if (!locationId || !photo || !supplierId) {
      toast({ title: t('validation.required'), variant: 'warning' });
      return;
    }
    const valid = lines.filter((l) => l.itemId && l.storageAreaId && l.qty && l.reason.trim());
    if (valid.length === 0) return;
    setSaving(true);
    try {
      const photoAttachmentId = await uploadAttachment({ file: photo, fileName: photo.name, mimeType: photo.type || 'image/jpeg', kind: 'return_proof' });
      const created = await createReturn({
        direction: 'warehouse_to_supplier',
        fromLocationId: locationId,
        supplierId,
        lines: valid.map((l) => ({ itemId: l.itemId, storageAreaId: l.storageAreaId, qty: l.qty as string, condition: l.condition, reason: l.reason })),
        photoAttachmentIds: [photoAttachmentId],
      });
      await submitReturn(created.id);
      toast({ title: t('warehouse.return.created'), variant: 'success' });
      setCreateOpen(false);
      setSupplierId('');
      setPhoto(null);
      setLines([{ itemId: '', storageAreaId: '', qty: null, condition: 'damaged', reason: '' }]);
      reloadSupplierReturns();
    } catch {
      toast({ title: t('table.error'), variant: 'danger' });
    } finally {
      setSaving(false);
    }
  }

  async function handleShip(row: ReturnDoc) {
    // Ship proof is a second wajib photo (FR-WST-03); a lightweight prompt
    // keeps this action a single click from the list instead of another
    // full modal, matching the low ceremony of the rest of this row action.
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const attachmentId = await uploadAttachment({ file, fileName: file.name, mimeType: file.type || 'image/jpeg', kind: 'return_proof' });
        await shipReturn(row.id, { proofAttachmentIds: [attachmentId] });
        toast({ title: t('warehouse.return.shipped'), variant: 'success' });
        reloadSupplierReturns();
      } catch {
        toast({ title: t('table.error'), variant: 'danger' });
      }
    };
    input.click();
  }

  async function openReceive(row: ReturnDoc) {
    const full = await getReturn(row.id);
    setReceiveTarget(full);
    setReceiveLines(Object.fromEntries(full.lines.map((l) => [l.lineId, { qtyReceived: l.qty, storageAreaId: '' }])));
    setReceivePhoto(null);
  }

  async function submitReceive() {
    if (!receiveTarget || !receivePhoto) return;
    const ok = receiveTarget.lines.every((l) => receiveLines[l.lineId]?.qtyReceived !== null && receiveLines[l.lineId]?.storageAreaId);
    if (!ok) {
      toast({ title: t('validation.required'), variant: 'warning' });
      return;
    }
    setReceiving(true);
    try {
      const attachmentId = await uploadAttachment({ file: receivePhoto, fileName: receivePhoto.name, mimeType: receivePhoto.type || 'image/jpeg', kind: 'return_proof' });
      await receiveReturnDoc(receiveTarget.id, {
        lines: receiveTarget.lines.map((l) => ({ lineId: l.lineId, qtyReceived: receiveLines[l.lineId]!.qtyReceived as string, storageAreaId: receiveLines[l.lineId]!.storageAreaId })),
        proofAttachmentIds: [attachmentId],
      });
      toast({ title: t('warehouse.return.received'), variant: 'success' });
      setReceiveTarget(null);
      reloadOutletReturns();
    } catch {
      toast({ title: t('table.error'), variant: 'danger' });
    } finally {
      setReceiving(false);
    }
  }

  const itemOptions = items.map((i) => ({ value: i.id, label: `${i.name} (${i.baseUnit.code})` }));
  const areaOptions = areas.map((a) => ({ value: a.id, label: a.name }));
  const supplierOptions = suppliers.map((s) => ({ value: s.id, label: s.name }));

  const supplierColumns: DataTableColumn<ReturnDoc>[] = [
    { key: 'returnNumber', header: t('warehouse.return.number') },
    { key: 'status', header: t('common.status'), render: (r) => <StatusBadge domain="return" status={r.status} /> },
    { key: 'lines', header: t('outlet.opname.lineCount'), align: 'right', render: (r) => r.lines.length },
    {
      key: 'action',
      header: '',
      render: (r) =>
        r.status === 'approved' ? (
          <PermissionGate permission="return.ship">
            <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); handleShip(r); }}>
              {t('warehouse.return.ship')}
            </Button>
          </PermissionGate>
        ) : null,
    },
  ];

  const outletColumns: DataTableColumn<ReturnDoc>[] = [
    { key: 'returnNumber', header: t('warehouse.return.number') },
    { key: 'fromLocationName', header: t('warehouse.approvalQueue.outlet') },
    { key: 'shippedAt', header: t('warehouse.return.shippedAt'), render: (r) => fmtDate(r.shippedAt) },
    { key: 'status', header: t('common.status'), render: (r) => <StatusBadge domain="return" status={r.status} /> },
  ];

  return (
    <Tabs defaultValue="toSupplier">
      <TabsList>
        <TabsTrigger value="toSupplier">{t('warehouse.return.tabToSupplier')}</TabsTrigger>
        <TabsTrigger value="fromOutlet">{t('warehouse.return.tabFromOutlet')}</TabsTrigger>
      </TabsList>

      <TabsContent value="toSupplier">
        <div className="flex flex-col gap-4">
          <div className="flex justify-end">
            <PermissionGate permission="return.create">
              <Button leftIcon={<Plus className="size-4" />} size="touch" onClick={() => setCreateOpen(true)}>
                {t('warehouse.return.new')}
              </Button>
            </PermissionGate>
          </div>
          <DataTable
            columns={supplierColumns}
            data={{ rows: supplierRows, total: supplierRows.length, page: 1, pageSize: Math.max(supplierRows.length, 1) }}
            keyField={(r) => r.id}
            loading={supplierLoading}
            error={supplierError}
            emptyDescription={t('warehouse.return.empty')}
          />
          {supplierError && (
            <div className="flex justify-end">
              <Button variant="outline" size="sm" onClick={reloadSupplierReturns}>{t('common.retry')}</Button>
            </div>
          )}
        </div>

        <Modal open={createOpen} onClose={() => setCreateOpen(false)} title={t('warehouse.return.new')} size="lg">
          <div className="flex flex-col gap-4">
            <Select label={t('warehouse.return.supplier')} value={supplierId} onValueChange={setSupplierId} options={supplierOptions} placeholder={t('common.selectPlaceholder')} />
            {lines.map((line, idx) => (
              <div key={idx} className="grid gap-3 sm:grid-cols-2">
                <Select label={t('outlet.replenishment.item')} value={line.itemId} options={itemOptions}
                  onValueChange={(v) => setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, itemId: v } : l)))}
                  placeholder={t('common.selectPlaceholder')} />
                <Select label={t('outlet.receiving.storageArea')} value={line.storageAreaId} options={areaOptions}
                  onValueChange={(v) => setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, storageAreaId: v } : l)))}
                  placeholder={t('common.selectPlaceholder')} />
                <QtyInput label={t('outlet.opname.countedQty')} value={line.qty}
                  onChange={(v) => setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, qty: v } : l)))} />
                <Select label={t('warehouse.return.condition')} value={line.condition}
                  options={CONDITIONS.map((c) => ({ value: c, label: t(`warehouse.return.conditions.${c}`) }))}
                  onValueChange={(v) => setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, condition: v } : l)))} />
                <Textarea wrapperClassName="sm:col-span-2" label={t('common.reason')} required value={line.reason}
                  onChange={(e) => setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, reason: e.target.value } : l)))} />
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" leftIcon={<Plus className="size-4" />}
              onClick={() => setLines((ls) => [...ls, { itemId: '', storageAreaId: '', qty: null, condition: 'damaged', reason: '' }])}>
              {t('outlet.replenishment.addLine')}
            </Button>
            <PhotoCapture label={t('warehouse.return.photoLabel')} value={photo ? URL.createObjectURL(photo) : null}
              onCapture={setPhoto} onRemove={() => setPhoto(null)} required />
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setCreateOpen(false)}>{t('common.cancel')}</Button>
            <Button loading={saving} disabled={!photo || !supplierId} onClick={submitSupplierReturn}>{t('common.submit')}</Button>
          </div>
        </Modal>
      </TabsContent>

      <TabsContent value="fromOutlet">
        <div className="flex flex-col gap-4">
          <DataTable
            columns={outletColumns}
            data={{ rows: outletRows, total: outletRows.length, page: 1, pageSize: Math.max(outletRows.length, 1) }}
            keyField={(r) => r.id}
            loading={outletLoading}
            error={outletError}
            onRowClick={openReceive}
            emptyDescription={t('warehouse.return.emptyFromOutlet')}
          />
          {outletError && (
            <div className="flex justify-end">
              <Button variant="outline" size="sm" onClick={reloadOutletReturns}>{t('common.retry')}</Button>
            </div>
          )}
        </div>

        <Modal open={!!receiveTarget} onClose={() => setReceiveTarget(null)} title={receiveTarget?.returnNumber ?? ''} size="lg">
          {receiveTarget && (
            <div className="flex flex-col gap-4">
              {receiveTarget.lines.length === 0 && <EmptyState title={t('table.empty')} size="sm" />}
              {receiveTarget.lines.map((l) => (
                <div key={l.lineId} className="grid gap-3 sm:grid-cols-3 items-end">
                  <span className="text-sm font-medium text-text-primary sm:col-span-1">{l.itemName}</span>
                  <QtyInput label={t('outlet.receiving.qtyReceived')} value={receiveLines[l.lineId]?.qtyReceived ?? null}
                    onChange={(v) => setReceiveLines((prev) => ({ ...prev, [l.lineId]: { ...prev[l.lineId]!, qtyReceived: v } }))} />
                  <Select label={t('outlet.receiving.storageArea')} value={receiveLines[l.lineId]?.storageAreaId ?? ''} options={areaOptions}
                    onValueChange={(v) => setReceiveLines((prev) => ({ ...prev, [l.lineId]: { ...prev[l.lineId]!, storageAreaId: v } }))}
                    placeholder={t('common.selectPlaceholder')} />
                </div>
              ))}
              <PhotoCapture label={t('warehouse.return.receiveProofLabel')} value={receivePhoto ? URL.createObjectURL(receivePhoto) : null}
                onCapture={setReceivePhoto} onRemove={() => setReceivePhoto(null)} required />
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setReceiveTarget(null)}>{t('common.cancel')}</Button>
                <Button loading={receiving} disabled={!receivePhoto} onClick={submitReceive}>{t('outlet.receiving.confirm')}</Button>
              </div>
            </div>
          )}
        </Modal>
      </TabsContent>
    </Tabs>
  );
}
