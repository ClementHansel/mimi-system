'use client';

import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import {
  Button,
  Modal,
  DataTable,
  StatusBadge,
  Select,
  QtyInput,
  Textarea,
  PhotoCapture,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  toast,
  PermissionGate,
} from '@/components/ui';
import type { DataTableColumn } from '@/components/ui';
import { formatQty } from '@/lib/formatters';
import { ExportButton } from '@/components/common/ExportButton';
import { LineImportButton } from '@/components/common/LineImportButton';
import { useOutletLocationContext } from './lib/outlet-location-context';
import { WASTE_EXPORT_COLUMNS, RETURN_EXPORT_COLUMNS } from './lib/outlet-export-columns';
import {
  WASTE_IMPORT_COLUMNS,
  RETURN_IMPORT_COLUMNS,
  makeWasteMapper,
  makeReturnMapper,
  type WasteImportLine,
  type ReturnImportLine,
} from './lib/outlet-line-import';
import {
  getStorageAreas,
  getItems,
  listWaste,
  createWaste,
  listReturns,
  createReturn,
  submitReturn,
  getReturnDestination,
} from './lib/outlet-api';
import { uploadAttachment } from './lib/attachments';
import type { WasteRecord, ReturnDoc, StorageArea, Item } from './lib/types';
import { WasteReason } from '@/lib/shared-types';
import type { Qty } from '@/lib/shared-types';

/** A refused fetch is not a crash: swallow it so it cannot become an unhandled rejection. */
const noop = () => {};

/**
 * THE SHARED ENUM, not a local list. This was five hand-written strings that
 * had drifted from `WasteReason` in both directions: `spoiled` and
 * `prep_error` are not in it (so the API rejected them — two of the five
 * options on this form could never be saved), while `lost`, `contaminated`,
 * `cold_chain_breach` and `production_error` are, and had no label here, so a
 * record carrying one rendered its raw i18n key on screen.
 */
const WASTE_REASONS = Object.values(WasteReason);

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
/**
 * `only` renders a single flow, for the per-flow sidebar routes. Omitted, it
 * renders both as tabs — what this component always did.
 */
export function WastePanel({ only }: { only?: 'waste' | 'return' } = {}) {
  const { t } = useI18n();
  const { locationId } = useOutletLocationContext();
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
    getStorageAreas(locationId).then(setAreas).catch(noop);
    getItems()
      .then((r) => setItems(r.rows))
      .catch(noop);
  }, [locationId]);

  function reloadWaste() {
    if (only === 'return') return;
    setWasteLoading(true);
    listWaste(locationId)
      .then((r) => setWasteRows(r.rows))
      // A refused or failed list must not become an UNHANDLED REJECTION. With
      // only `.finally`, a 403 here surfaced as a browser `pageerror` — the
      // whole-page crash signal — for a screen that was otherwise fine.
      .catch(() => setWasteRows([]))
      .finally(() => setWasteLoading(false));
  }
  function reloadReturns() {
    // DO NOT FETCH WHAT THIS VIEW DOES NOT RENDER. `only="waste"` is the
    // `/outlet/waste` route, whose `PermissionGate` asks for `waste.read`
    // alone — a Juru Masak holds that and NOT `return.read`, so fetching
    // returns anyway earned them a 403 on every visit to a screen they are
    // entitled to. The retur list is `/outlet/retur`'s, and is loaded there.
    if (only === 'waste') return;
    setReturnLoading(true);
    // `ReturnDirection` (`@mimi/shared`) is `outlet_to_warehouse` |
    // `warehouse_to_supplier` — the Indonesian-slang value here never
    // matched the DTO's `@IsIn`, so this 400'd with ERR_VALIDATION on every
    // call (same root cause as FIX-LOADS #2's warehouse-side Retur bug).
    listReturns(locationId, 'outlet_to_warehouse')
      .then((r) => setReturnRows(r.rows))
      .catch(() => setReturnRows([]))
      .finally(() => setReturnLoading(false));
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
        file: wastePhoto,
        fileName: wastePhoto.name,
        mimeType: wastePhoto.type || 'image/jpeg',
        kind: 'waste_photo',
      });
      await createWaste({
        locationId,
        items: valid.map((l) => ({
          storageAreaId: l.storageAreaId,
          itemId: l.itemId,
          qty: l.qty as string,
          reason: l.reason,
          reasonDetail: l.reasonDetail || undefined,
        })),
        photoAttachmentIds: [photoAttachmentId],
      });
      toast({ title: t('outlet.waste.created'), variant: 'success' });
      setWasteOpen(false);
      setWastePhoto(null);
      setWasteLines([
        { storageAreaId: '', itemId: '', qty: null, reason: 'expired', reasonDetail: '' },
      ]);
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
    const valid = returnLines.filter(
      (l) => l.itemId && l.storageAreaId && l.qty && l.reason.trim(),
    );
    if (valid.length === 0) return;
    setReturnSaving(true);
    try {
      const photoAttachmentId = await uploadAttachment({
        file: returnPhoto,
        fileName: returnPhoto.name,
        mimeType: returnPhoto.type || 'image/jpeg',
        kind: 'return_proof',
      });
      // WHERE IT IS GOING. `ReturnService` refuses an `outlet_to_warehouse`
      // return with no `toLocationId`, and this form never sent one, so every
      // retur an outlet raised came back 400 and the dialog simply stayed
      // open. It is not a choice to put in front of the supervisor — there is
      // one warehouse and "Retur ke Gudang" means it — so it is resolved here.
      const destination = await getReturnDestination();
      if (!destination) {
        toast({ title: t('outlet.return.noDestination'), variant: 'danger' });
        return;
      }
      const created = await createReturn({
        direction: 'outlet_to_warehouse',
        fromLocationId: locationId,
        toLocationId: destination.id,
        lines: valid.map((l) => ({
          itemId: l.itemId,
          storageAreaId: l.storageAreaId,
          qty: l.qty as string,
          condition: l.condition,
          reason: l.reason,
        })),
        photoAttachmentIds: [photoAttachmentId],
      });
      await submitReturn(created.id);
      toast({ title: t('outlet.return.created'), variant: 'success' });
      setReturnOpen(false);
      setReturnPhoto(null);
      setReturnLines([
        { itemId: '', storageAreaId: '', qty: null, condition: 'damaged', reason: '' },
      ]);
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
    {
      key: 'qty',
      header: t('outlet.opname.countedQty'),
      align: 'right',
      render: (r) => formatQty(r.qty),
    },
    {
      key: 'reason',
      header: t('common.reason'),
      render: (r) => t(`outlet.waste.reason.${r.reason}`),
    },
    {
      key: 'status',
      header: t('common.status'),
      render: (r) => <StatusBadge domain="waste" status={r.status} />,
    },
  ];

  const returnColumns: DataTableColumn<ReturnDoc>[] = [
    { key: 'returnNumber', header: t('outlet.return.number') },
    {
      key: 'status',
      header: t('common.status'),
      render: (r) => <StatusBadge domain="return" status={r.status} />,
    },
    {
      key: 'lines',
      header: t('outlet.opname.lineCount'),
      align: 'right',
      render: (r) => r.lines.length,
    },
  ];

  const itemOptions = items.map((i) => ({ value: i.id, label: `${i.name} (${i.baseUnit.code})` }));
  const areaOptions = areas.map((a) => ({ value: a.id, label: a.name }));

  // Split into named blocks so each flow can render on its own: the two are
  // separate sidebar routes now (`/outlet/waste`, `/outlet/retur`), and were
  // only ever tabs because they share this component's `items`/`areas` fetch.
  // They still share it — mounting either route loads both lists once — which
  // is why splitting the FILE in two would have been the costlier change.
  const wasteContent = (
    // The list and its create modal are siblings — a fragment, not a wrapper
    // div, so the surrounding layout is unchanged from when this was a tab.
    <>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-end gap-2">
          <ExportButton rows={wasteRows} columns={WASTE_EXPORT_COLUMNS} filenameBase="waste" />
          <PermissionGate permission="waste.create">
            <Button
              leftIcon={<Plus className="size-4" />}
              size="touch"
              onClick={() => setWasteOpen(true)}
            >
              {t('outlet.waste.new')}
            </Button>
          </PermissionGate>
        </div>
        <DataTable
          columns={wasteColumns}
          data={{
            rows: wasteRows,
            total: wasteRows.length,
            page: 1,
            pageSize: Math.max(wasteRows.length, 1),
          }}
          keyField={(r) => r.id}
          loading={wasteLoading}
          emptyDescription={t('outlet.waste.empty')}
        />
      </div>

      <Modal
        open={wasteOpen}
        onClose={() => setWasteOpen(false)}
        title={t('outlet.waste.new')}
        size="lg"
      >
        <div className="flex flex-col gap-4">
          {wasteLines.map((line, idx) => (
            <div key={idx} className="grid gap-3 sm:grid-cols-2">
              <Select
                label={t('outlet.receiving.storageArea')}
                value={line.storageAreaId}
                options={areaOptions}
                onValueChange={(v) =>
                  setWasteLines((ls) =>
                    ls.map((l, i) => (i === idx ? { ...l, storageAreaId: v } : l)),
                  )
                }
                placeholder={t('common.selectPlaceholder')}
              />
              <Select
                label={t('outlet.replenishment.item')}
                value={line.itemId}
                options={itemOptions}
                onValueChange={(v) =>
                  setWasteLines((ls) => ls.map((l, i) => (i === idx ? { ...l, itemId: v } : l)))
                }
                placeholder={t('common.selectPlaceholder')}
              />
              <QtyInput
                label={t('outlet.opname.countedQty')}
                value={line.qty}
                onChange={(v) =>
                  setWasteLines((ls) => ls.map((l, i) => (i === idx ? { ...l, qty: v } : l)))
                }
              />
              <Select
                label={t('common.reason')}
                value={line.reason}
                options={WASTE_REASONS.map((r) => ({
                  value: r,
                  label: t(`outlet.waste.reason.${r}`),
                }))}
                onValueChange={(v) =>
                  setWasteLines((ls) => ls.map((l, i) => (i === idx ? { ...l, reason: v } : l)))
                }
              />
              <Textarea
                wrapperClassName="sm:col-span-2"
                label={t('common.notes')}
                value={line.reasonDetail}
                onChange={(e) =>
                  setWasteLines((ls) =>
                    ls.map((l, i) => (i === idx ? { ...l, reasonDetail: e.target.value } : l)),
                  )
                }
              />
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              leftIcon={<Plus className="size-4" />}
              onClick={() =>
                setWasteLines((ls) => [
                  ...ls,
                  {
                    storageAreaId: '',
                    itemId: '',
                    qty: null,
                    reason: 'expired',
                    reasonDetail: '',
                  },
                ])
              }
            >
              {t('outlet.replenishment.addLine')}
            </Button>
            {/* The photo below stays mandatory. A CSV can say what was thrown
                  away; only the photo evidences that it was. */}
            <LineImportButton<WasteImportLine>
              title={t('outlet.waste.new')}
              note={t('outlet.waste.importNote')}
              columns={WASTE_IMPORT_COLUMNS}
              templateBase="waste"
              mapRow={makeWasteMapper(items, areas)}
              hasExistingLines={wasteLines.some((l) => l.itemId !== '' || l.qty !== null)}
              onLines={(imported, mode) =>
                setWasteLines((prev) => [
                  ...(mode === 'replace'
                    ? []
                    : prev.filter((l) => l.itemId !== '' || l.qty !== null)),
                  ...imported,
                ])
              }
            />
          </div>
          <PhotoCapture
            label={t('outlet.waste.photoLabel')}
            value={wastePhoto ? URL.createObjectURL(wastePhoto) : null}
            onCapture={setWastePhoto}
            onRemove={() => setWastePhoto(null)}
            required
          />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setWasteOpen(false)}>
            {t('common.cancel')}
          </Button>
          <Button loading={wasteSaving} disabled={!wastePhoto} onClick={submitWaste}>
            {t('common.submit')}
          </Button>
        </div>
      </Modal>
    </>
  );

  const returnContent = (
    // The list and its create modal are siblings — a fragment, not a wrapper
    // div, so the surrounding layout is unchanged from when this was a tab.
    <>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-end gap-2">
          <ExportButton rows={returnRows} columns={RETURN_EXPORT_COLUMNS} filenameBase="retur" />
          <PermissionGate permission="return.create">
            <Button
              leftIcon={<Plus className="size-4" />}
              size="touch"
              onClick={() => setReturnOpen(true)}
            >
              {t('outlet.return.new')}
            </Button>
          </PermissionGate>
        </div>
        <DataTable
          columns={returnColumns}
          data={{
            rows: returnRows,
            total: returnRows.length,
            page: 1,
            pageSize: Math.max(returnRows.length, 1),
          }}
          keyField={(r) => r.id}
          loading={returnLoading}
          emptyDescription={t('outlet.return.empty')}
        />
      </div>

      <Modal
        open={returnOpen}
        onClose={() => setReturnOpen(false)}
        title={t('outlet.return.new')}
        size="lg"
      >
        <div className="flex flex-col gap-4">
          {returnLines.map((line, idx) => (
            <div key={idx} className="grid gap-3 sm:grid-cols-2">
              <Select
                label={t('outlet.replenishment.item')}
                value={line.itemId}
                options={itemOptions}
                onValueChange={(v) =>
                  setReturnLines((ls) => ls.map((l, i) => (i === idx ? { ...l, itemId: v } : l)))
                }
                placeholder={t('common.selectPlaceholder')}
              />
              <Select
                label={t('outlet.receiving.storageArea')}
                value={line.storageAreaId}
                options={areaOptions}
                onValueChange={(v) =>
                  setReturnLines((ls) =>
                    ls.map((l, i) => (i === idx ? { ...l, storageAreaId: v } : l)),
                  )
                }
                placeholder={t('common.selectPlaceholder')}
              />
              <QtyInput
                label={t('outlet.opname.countedQty')}
                value={line.qty}
                onChange={(v) =>
                  setReturnLines((ls) => ls.map((l, i) => (i === idx ? { ...l, qty: v } : l)))
                }
              />
              <Textarea
                label={t('common.reason')}
                required
                value={line.reason}
                onChange={(e) =>
                  setReturnLines((ls) =>
                    ls.map((l, i) => (i === idx ? { ...l, reason: e.target.value } : l)),
                  )
                }
              />
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              leftIcon={<Plus className="size-4" />}
              onClick={() =>
                setReturnLines((ls) => [
                  ...ls,
                  { itemId: '', storageAreaId: '', qty: null, condition: 'damaged', reason: '' },
                ])
              }
            >
              {t('outlet.replenishment.addLine')}
            </Button>
            <LineImportButton<ReturnImportLine>
              title={t('outlet.return.new')}
              note={t('outlet.return.importNote')}
              columns={RETURN_IMPORT_COLUMNS}
              templateBase="retur"
              mapRow={makeReturnMapper(items, areas)}
              hasExistingLines={returnLines.some((l) => l.itemId !== '' || l.qty !== null)}
              onLines={(imported, mode) =>
                setReturnLines((prev) => [
                  ...(mode === 'replace'
                    ? []
                    : prev.filter((l) => l.itemId !== '' || l.qty !== null)),
                  ...imported,
                ])
              }
            />
          </div>
          <PhotoCapture
            label={t('outlet.return.photoLabel')}
            value={returnPhoto ? URL.createObjectURL(returnPhoto) : null}
            onCapture={setReturnPhoto}
            onRemove={() => setReturnPhoto(null)}
            required
          />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setReturnOpen(false)}>
            {t('common.cancel')}
          </Button>
          <Button loading={returnSaving} disabled={!returnPhoto} onClick={submitReturnDoc}>
            {t('common.submit')}
          </Button>
        </div>
      </Modal>
    </>
  );

  if (only === 'waste') return wasteContent;
  if (only === 'return') return returnContent;

  // No `only`: the combined view, unchanged. Kept so the component still works
  // standalone and its existing tests keep exercising both halves together.
  return (
    <Tabs defaultValue="waste">
      <TabsList>
        <TabsTrigger value="waste">{t('outlet.waste.tab')}</TabsTrigger>
        <TabsTrigger value="return">{t('outlet.return.tab')}</TabsTrigger>
      </TabsList>
      <TabsContent value="waste">{wasteContent}</TabsContent>
      <TabsContent value="return">{returnContent}</TabsContent>
    </Tabs>
  );
}
