'use client';

import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import {
  Button, Modal, DataTable, StatusBadge, Select, QtyInput, Textarea, PhotoCapture, Tabs, TabsList,
  TabsTrigger, TabsContent, toast, PermissionGate,
} from '@/components/ui';
import type { DataTableColumn } from '@/components/ui';
import { formatQty } from '@/lib/formatters';
import { useOutletLocation } from './lib/use-outlet-location';
import { getStorageAreas, getItems, listWaste, createWaste, listReturns, createReturn, submitReturn } from './lib/outlet-api';
import { uploadAttachment } from './lib/attachments';
import type { WasteRecord, ReturnDoc, StorageArea, Item } from './lib/types';
import type { Qty } from '@/lib/shared-types';

const WASTE_REASONS = ['expired', 'damaged', 'spoiled', 'prep_error', 'other'] as const;

interface WasteLineDraft {
  storageAreaId: string;
  itemId: string;
  qty: Qty | null;
  reason: string;
  reasonDetail: string;
}

interface ReturnLineDraft {
  itemId: string;
  storageAreaId: string;
  qty: Qty | null;
  condition: string;
  reason: string;
}

/** Waste (with photo) and retur-to-warehouse — both live under one tab set since they share the same source data (items/areas) and both post to the warehouse. */
export function WastePanel() {
  const { t } = useI18n();
  const { locationId } = useOutletLocation();
  const [areas, setAreas] = useState<StorageArea[]>([]);
  const [items, setItems] = useState<Item[]>([]);

  const [wasteRows, setWasteRows] = useState<WasteRecord[]>([]);
  const [wasteLoading, setWasteLoading] = useState(true);
  const [wasteOpen, setWasteOpen] = useState(false);
  const [wasteLines, setWasteLines] = useState<WasteLineDraft[]>([
    { storageAreaId: '', itemId: '', qty: null, reason: 'expired', reasonDetail: '' },
  ]);
  const [wastePhoto, setWastePhoto] = useState<File | null>(null);
  const [wasteSaving, setWasteSaving] = useState(false);

  const [returnRows, setReturnRows] = useState<ReturnDoc[]>([]);
  const [returnLoading, setReturnLoading] = useState(true);
  const [returnOpen, setReturnOpen] = useState(false);
  const [returnLines, setReturnLines] = useState<ReturnLineDraft[]>([
    { itemId: '', storageAreaId: '', qty: null, condition: 'damaged', reason: '' },
  ]);
  const [returnPhoto, setReturnPhoto] = useState<File | null>(null);
  const [returnSaving, setReturnSaving] = useState(false);

  useEffect(() => {
    if (!locationId) return;
    getStorageAreas(locationId).then(setAreas);
    getItems().then((r) => setItems(r.rows));
  }, [locationId]);

  function reloadWaste() {
    if (!locationId) return;
    setWasteLoading(true);
    listWaste(locationId).then((r) => setWasteRows(r.rows)).finally(() => setWasteLoading(false));
  }
  function reloadReturns() {
    if (!locationId) return;
    setReturnLoading(true);
    // `ReturnDirection` (`@mimi/shared`) is `outlet_to_warehouse` |
    // `warehouse_to_supplier` — the Indonesian-slang value here never
    // matched the DTO's `@IsIn`, so this 400'd with ERR_VALIDATION on every
    // call (same root cause as FIX-LOADS #2's warehouse-side Retur bug).
    listReturns(locationId, 'outlet_to_warehouse').then((r) => setReturnRows(r.rows)).finally(() => setReturnLoading(false));
  }
  useEffect(reloadWaste, [locationId]);
  useEffect(reloadReturns, [locationId]);

  async function submitWaste() {
    if (!locationId || !wastePhoto) {
      toast({ title: t('validation.photoRequired'), variant: 'warning' });
      return;
    }
    const valid = wasteLines.filter((l) => l.storageAreaId && l.itemId && l.qty);
    if (valid.length === 0) return;
    setWasteSaving(true);
    try {
      const photoAttachmentId = await uploadAttachment({
        file: wastePhoto, fileName: wastePhoto.name, mimeType: wastePhoto.type || 'image/jpeg', kind: 'waste_photo',
      });
      await createWaste({
        locationId,
        items: valid.map((l) => ({
          storageAreaId: l.storageAreaId, itemId: l.itemId, qty: l.qty as string, reason: l.reason,
          reasonDetail: l.reasonDetail || undefined,
        })),
        photoAttachmentIds: [photoAttachmentId],
      });
      toast({ title: t('outlet.waste.created'), variant: 'success' });
      setWasteOpen(false);
      setWastePhoto(null);
      setWasteLines([{ storageAreaId: '', itemId: '', qty: null, reason: 'expired', reasonDetail: '' }]);
      reloadWaste();
    } catch {
      toast({ title: t('table.error'), variant: 'danger' });
    } finally {
      setWasteSaving(false);
    }
  }

  async function submitReturnDoc() {
    if (!locationId || !returnPhoto) {
      toast({ title: t('validation.photoRequired'), variant: 'warning' });
      return;
    }
    const valid = returnLines.filter((l) => l.itemId && l.storageAreaId && l.qty && l.reason.trim());
    if (valid.length === 0) return;
    setReturnSaving(true);
    try {
      const photoAttachmentId = await uploadAttachment({
        file: returnPhoto, fileName: returnPhoto.name, mimeType: returnPhoto.type || 'image/jpeg', kind: 'return_proof',
      });
      const created = await createReturn({
        direction: 'outlet_to_warehouse',
        fromLocationId: locationId,
        lines: valid.map((l) => ({ itemId: l.itemId, storageAreaId: l.storageAreaId, qty: l.qty as string, condition: l.condition, reason: l.reason })),
        photoAttachmentIds: [photoAttachmentId],
      });
      await submitReturn(created.id);
      toast({ title: t('outlet.return.created'), variant: 'success' });
      setReturnOpen(false);
      setReturnPhoto(null);
      setReturnLines([{ itemId: '', storageAreaId: '', qty: null, condition: 'damaged', reason: '' }]);
      reloadReturns();
    } catch {
      toast({ title: t('table.error'), variant: 'danger' });
    } finally {
      setReturnSaving(false);
    }
  }

  const wasteColumns: DataTableColumn<WasteRecord>[] = [
    { key: 'wasteNumber', header: t('outlet.waste.number') },
    { key: 'itemName', header: t('outlet.replenishment.item') },
    { key: 'qty', header: t('outlet.opname.countedQty'), align: 'right', render: (r) => formatQty(r.qty) },
    { key: 'reason', header: t('common.reason'), render: (r) => t(`outlet.waste.reason.${r.reason}`) },
    { key: 'status', header: t('common.status'), render: (r) => <StatusBadge domain="waste" status={r.status} /> },
  ];

  const returnColumns: DataTableColumn<ReturnDoc>[] = [
    { key: 'returnNumber', header: t('outlet.return.number') },
    { key: 'status', header: t('common.status'), render: (r) => <StatusBadge domain="return" status={r.status} /> },
    { key: 'lines', header: t('outlet.opname.lineCount'), align: 'right', render: (r) => r.lines.length },
  ];

  const itemOptions = items.map((i) => ({ value: i.id, label: `${i.name} (${i.baseUnit.code})` }));
  const areaOptions = areas.map((a) => ({ value: a.id, label: a.name }));

  return (
    <Tabs defaultValue="waste">
      <TabsList>
        <TabsTrigger value="waste">{t('outlet.waste.tab')}</TabsTrigger>
        <TabsTrigger value="return">{t('outlet.return.tab')}</TabsTrigger>
      </TabsList>

      <TabsContent value="waste">
        <div className="flex flex-col gap-4">
          <div className="flex justify-end">
            <PermissionGate permission="waste.create">
              <Button leftIcon={<Plus className="size-4" />} size="touch" onClick={() => setWasteOpen(true)}>
                {t('outlet.waste.new')}
              </Button>
            </PermissionGate>
          </div>
          <DataTable
            columns={wasteColumns}
            data={{ rows: wasteRows, total: wasteRows.length, page: 1, pageSize: Math.max(wasteRows.length, 1) }}
            keyField={(r) => r.id}
            loading={wasteLoading}
            emptyDescription={t('outlet.waste.empty')}
          />
        </div>

        <Modal open={wasteOpen} onClose={() => setWasteOpen(false)} title={t('outlet.waste.new')} size="lg">
          <div className="flex flex-col gap-4">
            {wasteLines.map((line, idx) => (
              <div key={idx} className="grid gap-3 sm:grid-cols-2">
                <Select label={t('outlet.receiving.storageArea')} value={line.storageAreaId} options={areaOptions}
                  onValueChange={(v) => setWasteLines((ls) => ls.map((l, i) => (i === idx ? { ...l, storageAreaId: v } : l)))}
                  placeholder={t('common.selectPlaceholder')} />
                <Select label={t('outlet.replenishment.item')} value={line.itemId} options={itemOptions}
                  onValueChange={(v) => setWasteLines((ls) => ls.map((l, i) => (i === idx ? { ...l, itemId: v } : l)))}
                  placeholder={t('common.selectPlaceholder')} />
                <QtyInput label={t('outlet.opname.countedQty')} value={line.qty}
                  onChange={(v) => setWasteLines((ls) => ls.map((l, i) => (i === idx ? { ...l, qty: v } : l)))} />
                <Select label={t('common.reason')} value={line.reason}
                  options={WASTE_REASONS.map((r) => ({ value: r, label: t(`outlet.waste.reason.${r}`) }))}
                  onValueChange={(v) => setWasteLines((ls) => ls.map((l, i) => (i === idx ? { ...l, reason: v } : l)))} />
                <Textarea wrapperClassName="sm:col-span-2" label={t('common.notes')} value={line.reasonDetail}
                  onChange={(e) => setWasteLines((ls) => ls.map((l, i) => (i === idx ? { ...l, reasonDetail: e.target.value } : l)))} />
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" leftIcon={<Plus className="size-4" />}
              onClick={() => setWasteLines((ls) => [...ls, { storageAreaId: '', itemId: '', qty: null, reason: 'expired', reasonDetail: '' }])}>
              {t('outlet.replenishment.addLine')}
            </Button>
            <PhotoCapture label={t('outlet.waste.photoLabel')} value={wastePhoto ? URL.createObjectURL(wastePhoto) : null}
              onCapture={setWastePhoto} onRemove={() => setWastePhoto(null)} required />
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setWasteOpen(false)}>{t('common.cancel')}</Button>
            <Button loading={wasteSaving} disabled={!wastePhoto} onClick={submitWaste}>{t('common.submit')}</Button>
          </div>
        </Modal>
      </TabsContent>

      <TabsContent value="return">
        <div className="flex flex-col gap-4">
          <div className="flex justify-end">
            <PermissionGate permission="return.create">
              <Button leftIcon={<Plus className="size-4" />} size="touch" onClick={() => setReturnOpen(true)}>
                {t('outlet.return.new')}
              </Button>
            </PermissionGate>
          </div>
          <DataTable
            columns={returnColumns}
            data={{ rows: returnRows, total: returnRows.length, page: 1, pageSize: Math.max(returnRows.length, 1) }}
            keyField={(r) => r.id}
            loading={returnLoading}
            emptyDescription={t('outlet.return.empty')}
          />
        </div>

        <Modal open={returnOpen} onClose={() => setReturnOpen(false)} title={t('outlet.return.new')} size="lg">
          <div className="flex flex-col gap-4">
            {returnLines.map((line, idx) => (
              <div key={idx} className="grid gap-3 sm:grid-cols-2">
                <Select label={t('outlet.replenishment.item')} value={line.itemId} options={itemOptions}
                  onValueChange={(v) => setReturnLines((ls) => ls.map((l, i) => (i === idx ? { ...l, itemId: v } : l)))}
                  placeholder={t('common.selectPlaceholder')} />
                <Select label={t('outlet.receiving.storageArea')} value={line.storageAreaId} options={areaOptions}
                  onValueChange={(v) => setReturnLines((ls) => ls.map((l, i) => (i === idx ? { ...l, storageAreaId: v } : l)))}
                  placeholder={t('common.selectPlaceholder')} />
                <QtyInput label={t('outlet.opname.countedQty')} value={line.qty}
                  onChange={(v) => setReturnLines((ls) => ls.map((l, i) => (i === idx ? { ...l, qty: v } : l)))} />
                <Textarea label={t('common.reason')} required value={line.reason}
                  onChange={(e) => setReturnLines((ls) => ls.map((l, i) => (i === idx ? { ...l, reason: e.target.value } : l)))} />
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" leftIcon={<Plus className="size-4" />}
              onClick={() => setReturnLines((ls) => [...ls, { itemId: '', storageAreaId: '', qty: null, condition: 'damaged', reason: '' }])}>
              {t('outlet.replenishment.addLine')}
            </Button>
            <PhotoCapture label={t('outlet.return.photoLabel')} value={returnPhoto ? URL.createObjectURL(returnPhoto) : null}
              onCapture={setReturnPhoto} onRemove={() => setReturnPhoto(null)} required />
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setReturnOpen(false)}>{t('common.cancel')}</Button>
            <Button loading={returnSaving} disabled={!returnPhoto} onClick={submitReturnDoc}>{t('common.submit')}</Button>
          </div>
        </Modal>
      </TabsContent>
    </Tabs>
  );
}
