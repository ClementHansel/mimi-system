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
  toast,
  PermissionGate,
  EmptyState,
} from '@/components/ui';
import type { DataTableColumn } from '@/components/ui';
import { formatQty, formatMoney } from '@/lib/formatters';
import { fmtDate } from '@/lib/dates';
import { ApiError } from '@/lib/api';
import { useWarehouseLocation } from './lib/use-warehouse-location';
import { getStorageAreas, getItems, listWaste, createWaste } from './lib/warehouse-api';
import { uploadAttachment } from './lib/attachments';
import type { WasteRecord, StorageArea, Item } from './lib/types';
import type { Qty } from '@/lib/shared-types';

const WASTE_REASONS = ['expired', 'damaged', 'spoiled', 'prep_error', 'other'] as const;

interface WasteLineDraft {
  storageAreaId: string;
  itemId: string;
  qty: Qty | null;
  reason: string;
  reasonDetail: string;
}

/**
 * Waste records at the central warehouse (FR-WST-01/02, CONTRACTS §4.12) —
 * expired/damaged/spoiled stock written off with a mandatory photo, same
 * flow as `components/outlet/WastePanel.tsx`'s waste tab but scoped to the
 * warehouse's own location and without the retur-to-warehouse half (that
 * doesn't apply here — the warehouse IS the retur destination; its own
 * outbound retur is `ReturnPanel`'s "Retur ke Supplier" tab, and inbound
 * retur from outlets is that same panel's "Retur dari Outlet" tab).
 */
export function WastePanel() {
  const { t } = useI18n();
  const { locationId, loading: warehouseLoading } = useWarehouseLocation();
  const [areas, setAreas] = useState<StorageArea[]>([]);
  const [items, setItems] = useState<Item[]>([]);

  const [rows, setRows] = useState<WasteRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [createOpen, setCreateOpen] = useState(false);
  const [lines, setLines] = useState<WasteLineDraft[]>([
    { storageAreaId: '', itemId: '', qty: null, reason: 'expired', reasonDetail: '' },
  ]);
  const [photo, setPhoto] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!locationId) return;
    getStorageAreas(locationId)
      .then(setAreas)
      .catch(() => {});
    getItems()
      .then((r) => setItems(r.rows))
      .catch(() => {});
  }, [locationId]);

  function reload() {
    if (!locationId) return;
    setLoading(true);
    setError(undefined);
    listWaste(locationId)
      .then((r) => setRows(r.rows))
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : t('table.error')))
      .finally(() => setLoading(false));
  }
  useEffect(reload, [locationId]);

  async function submit() {
    if (!locationId || !photo) {
      toast({ title: t('validation.photoRequired'), variant: 'warning' });
      return;
    }
    const valid = lines.filter((l) => l.storageAreaId && l.itemId && l.qty);
    if (valid.length === 0) return;
    setSaving(true);
    try {
      const photoAttachmentId = await uploadAttachment({
        file: photo,
        fileName: photo.name,
        mimeType: photo.type || 'image/jpeg',
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
      setCreateOpen(false);
      setPhoto(null);
      setLines([{ storageAreaId: '', itemId: '', qty: null, reason: 'expired', reasonDetail: '' }]);
      reload();
    } catch {
      toast({ title: t('table.error'), variant: 'danger' });
    } finally {
      setSaving(false);
    }
  }

  const columns: DataTableColumn<WasteRecord>[] = [
    { key: 'wasteNumber', header: t('outlet.waste.number') },
    { key: 'itemName', header: t('outlet.replenishment.item') },
    { key: 'storageAreaName', header: t('outlet.receiving.storageArea') },
    {
      key: 'qty',
      header: t('outlet.opname.countedQty'),
      align: 'right',
      render: (r) => formatQty(r.qty),
    },
    {
      key: 'unitCost',
      header: t('warehouse.waste.unitCost'),
      align: 'right',
      render: (r) => formatMoney(r.unitCost),
    },
    {
      key: 'reason',
      header: t('common.reason'),
      render: (r) => t(`outlet.waste.reason.${r.reason}`),
    },
    { key: 'occurredAt', header: t('common.date'), render: (r) => fmtDate(r.occurredAt) },
    {
      key: 'status',
      header: t('common.status'),
      render: (r) => <StatusBadge domain="waste" status={r.status} />,
    },
  ];

  const itemOptions = items.map((i) => ({ value: i.id, label: `${i.name} (${i.baseUnit.code})` }));
  const areaOptions = areas.map((a) => ({ value: a.id, label: a.name }));

  // Previously `return null` — worse than an empty state, per the standing
  // rule against errors masquerading as empty states: an account with no
  // `warehouse`-type location (e.g. Owner) saw literally nothing on this
  // tab (FIX-LOADS #2), no different from an infinite spinner. Say plainly
  // there's no location instead.
  // `loading` first: a central role has no warehouse in its session and one
  // is fetched, so checking only `locationId` renders "no warehouse" for a
  // frame — the exact wrong message, shown to the people who own the place.
  if (warehouseLoading) return <EmptyState title={t('table.loading')} size="lg" />;
  if (!locationId) return <EmptyState title={t('warehouse.noLocation')} size="lg" />;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <PermissionGate permission="waste.create">
          <Button
            leftIcon={<Plus className="size-4" />}
            size="touch"
            onClick={() => setCreateOpen(true)}
          >
            {t('outlet.waste.new')}
          </Button>
        </PermissionGate>
      </div>

      <DataTable
        columns={columns}
        data={{ rows, total: rows.length, page: 1, pageSize: Math.max(rows.length, 1) }}
        keyField={(r) => r.id}
        loading={loading}
        error={error}
        emptyDescription={t('outlet.waste.empty')}
      />
      {error && (
        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={reload}>
            {t('common.retry')}
          </Button>
        </div>
      )}

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title={t('outlet.waste.new')}
        size="lg"
      >
        <div className="flex flex-col gap-4">
          {lines.map((line, idx) => (
            <div key={idx} className="grid gap-3 sm:grid-cols-2">
              <Select
                label={t('outlet.receiving.storageArea')}
                value={line.storageAreaId}
                options={areaOptions}
                onValueChange={(v) =>
                  setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, storageAreaId: v } : l)))
                }
                placeholder={t('common.selectPlaceholder')}
              />
              <Select
                label={t('outlet.replenishment.item')}
                value={line.itemId}
                options={itemOptions}
                onValueChange={(v) =>
                  setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, itemId: v } : l)))
                }
                placeholder={t('common.selectPlaceholder')}
              />
              <QtyInput
                label={t('outlet.opname.countedQty')}
                value={line.qty}
                onChange={(v) =>
                  setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, qty: v } : l)))
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
                  setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, reason: v } : l)))
                }
              />
              <Textarea
                wrapperClassName="sm:col-span-2"
                label={t('common.notes')}
                value={line.reasonDetail}
                onChange={(e) =>
                  setLines((ls) =>
                    ls.map((l, i) => (i === idx ? { ...l, reasonDetail: e.target.value } : l)),
                  )
                }
              />
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            leftIcon={<Plus className="size-4" />}
            onClick={() =>
              setLines((ls) => [
                ...ls,
                { storageAreaId: '', itemId: '', qty: null, reason: 'expired', reasonDetail: '' },
              ])
            }
          >
            {t('outlet.replenishment.addLine')}
          </Button>
          <PhotoCapture
            label={t('outlet.waste.photoLabel')}
            value={photo ? URL.createObjectURL(photo) : null}
            onCapture={setPhoto}
            onRemove={() => setPhoto(null)}
            required
          />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setCreateOpen(false)}>
            {t('common.cancel')}
          </Button>
          <Button loading={saving} disabled={!photo} onClick={submit}>
            {t('common.submit')}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
