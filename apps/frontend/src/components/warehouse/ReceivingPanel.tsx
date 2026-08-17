'use client';

import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { Modal, DataTable, StatusBadge, PhotoCapture, Select, QtyInput, Textarea, toast, Button, EmptyState } from '@/components/ui';
import type { DataTableColumn } from '@/components/ui';
import { formatMoney, formatQty } from '@/lib/formatters';
import { useWarehouseLocation } from './lib/use-warehouse-location';
import { getStorageAreas, listPurchaseOrders, getPurchaseOrder, receivePurchaseOrder } from './lib/warehouse-api';
import { uploadAttachment } from './lib/attachments';
import type { PurchaseOrder, StorageArea } from './lib/types';
import type { Qty } from '@/lib/shared-types';

const OPEN_PO_STATUSES = ['issued', 'partially_received'];

interface ReceiptLineDraft {
  poLineId: string;
  qtyReceived: Qty | null;
  storageAreaId: string;
  conditionNotes: string;
}

/**
 * PO receiving from suppliers (FR-PO-02/03/04). Records qty ordered vs
 * received per line — the discrepancy is visible directly in the table
 * (`qtyOrdered` vs the already-received `qtyReceived` plus what's being
 * entered now) — and a photo is wajib per FR-PO-04, same
 * presign→PUT→confirm helper `components/outlet/lib/attachments.ts` already
 * exports (shared upload plumbing, not surface-specific, so this reuses it
 * rather than re-implementing the 3-step dance).
 */
export function ReceivingPanel() {
  const { t } = useI18n();
  const { locationId } = useWarehouseLocation();
  const [rows, setRows] = useState<PurchaseOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [areas, setAreas] = useState<StorageArea[]>([]);
  const [active, setActive] = useState<PurchaseOrder | null>(null);
  const [lines, setLines] = useState<Record<string, ReceiptLineDraft>>({});
  const [photo, setPhoto] = useState<File | null>(null);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  function reload() {
    setLoading(true);
    Promise.all(OPEN_PO_STATUSES.map((status) => listPurchaseOrders({ status })))
      .then((results) => setRows(results.flatMap((r) => r.rows)))
      .catch(() => toast({ title: t('table.error'), variant: 'danger' }))
      .finally(() => setLoading(false));
  }

  useEffect(reload, []);
  useEffect(() => {
    if (locationId) getStorageAreas(locationId).then(setAreas);
  }, [locationId]);

  async function openReceive(row: PurchaseOrder) {
    const full = await getPurchaseOrder(row.id);
    setActive(full);
    setLines(
      Object.fromEntries(
        full.lines
          .filter((l) => l.qtyReceived !== l.qtyOrdered)
          .map((l) => [l.id, { poLineId: l.id, qtyReceived: null, storageAreaId: '', conditionNotes: '' }]),
      ),
    );
    setPhoto(null);
    setNotes('');
  }

  const draftLines = useMemo(() => (active ? active.lines.filter((l) => lines[l.id]) : []), [active, lines]);
  const canSubmit =
    !!photo && draftLines.length > 0 && draftLines.every((l) => lines[l.id]!.qtyReceived !== null && lines[l.id]!.storageAreaId !== '');

  async function submit() {
    if (!active || !photo || !canSubmit) return;
    setSubmitting(true);
    try {
      const photoAttachmentId = await uploadAttachment({ file: photo, fileName: photo.name, mimeType: photo.type || 'image/jpeg', kind: 'po_receipt_photo' });
      await receivePurchaseOrder(active.id, {
        lines: draftLines.map((l) => ({
          poLineId: l.id,
          qtyReceived: lines[l.id]!.qtyReceived as string,
          storageAreaId: lines[l.id]!.storageAreaId,
          conditionNotes: lines[l.id]!.conditionNotes || undefined,
        })),
        photoAttachmentIds: [photoAttachmentId],
        notes: notes.trim() || undefined,
      });
      toast({ title: t('warehouse.receiving.received'), variant: 'success' });
      setActive(null);
      reload();
    } catch {
      toast({ title: t('table.error'), variant: 'danger' });
    } finally {
      setSubmitting(false);
    }
  }

  const columns: DataTableColumn<PurchaseOrder>[] = [
    { key: 'poNumber', header: t('warehouse.receiving.poNumber') },
    { key: 'supplierName', header: t('warehouse.receiving.supplier') },
    { key: 'total', header: t('warehouse.receiving.total'), align: 'right', render: (r) => formatMoney(r.total) },
    { key: 'status', header: t('common.status'), render: (r) => <StatusBadge domain="purchaseOrder" status={r.status} /> },
  ];

  const areaOptions = areas.map((a) => ({ value: a.id, label: a.name }));

  return (
    <div className="flex flex-col gap-4">
      <DataTable
        columns={columns}
        data={{ rows, total: rows.length, page: 1, pageSize: Math.max(rows.length, 1) }}
        keyField={(r) => r.id}
        loading={loading}
        onRowClick={openReceive}
        emptyDescription={t('warehouse.receiving.empty')}
      />

      <Modal open={!!active} onClose={() => setActive(null)} title={active?.poNumber ?? ''} size="xl">
        {active && (
          <div className="flex flex-col gap-4">
            {active.lines.length === 0 && <EmptyState title={t('table.empty')} size="sm" />}
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-sunken text-left text-text-secondary">
                  <th className="px-3 py-2">{t('outlet.replenishment.item')}</th>
                  <th className="px-3 py-2 text-right">{t('warehouse.receiving.qtyOrdered')}</th>
                  <th className="px-3 py-2 text-right">{t('warehouse.receiving.qtyAlreadyReceived')}</th>
                  <th className="px-3 py-2">{t('warehouse.receiving.qtyReceivedNow')}</th>
                  <th className="px-3 py-2">{t('outlet.receiving.storageArea')}</th>
                  <th className="px-3 py-2">{t('warehouse.receiving.conditionNotes')}</th>
                </tr>
              </thead>
              <tbody>
                {active.lines.map((l) => {
                  const draft = lines[l.id];
                  const done = l.qtyReceived === l.qtyOrdered;
                  return (
                    <tr key={l.id} className="border-b border-border align-top last:border-0">
                      <td className="px-3 py-2.5 font-medium text-text-primary">{l.itemName}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{formatQty(l.qtyOrdered, l.unitCode)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{formatQty(l.qtyReceived, l.unitCode)}</td>
                      <td className="px-3 py-2.5">
                        {done ? (
                          <span className="text-text-muted">—</span>
                        ) : (
                          <QtyInput
                            value={draft?.qtyReceived ?? null}
                            onChange={(v) => setLines((prev) => ({ ...prev, [l.id]: { ...prev[l.id]!, qtyReceived: v } }))}
                            unitCode={l.unitCode}
                            size="touch"
                            wrapperClassName="w-32"
                            disabled={submitting}
                          />
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        {!done && (
                          <Select
                            value={draft?.storageAreaId ?? ''}
                            onValueChange={(v) => setLines((prev) => ({ ...prev, [l.id]: { ...prev[l.id]!, storageAreaId: v } }))}
                            options={areaOptions}
                            placeholder={t('common.selectPlaceholder')}
                            size="touch"
                            wrapperClassName="w-40"
                            disabled={submitting}
                          />
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        {!done && (
                          <Textarea
                            rows={1}
                            value={draft?.conditionNotes ?? ''}
                            onChange={(e) => setLines((prev) => ({ ...prev, [l.id]: { ...prev[l.id]!, conditionNotes: e.target.value } }))}
                            wrapperClassName="w-48"
                            disabled={submitting}
                          />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <PhotoCapture
              label={t('warehouse.receiving.photoLabel')}
              value={photo ? URL.createObjectURL(photo) : null}
              onCapture={setPhoto}
              onRemove={() => setPhoto(null)}
              required
              disabled={submitting}
            />
            <Textarea label={t('common.notes')} value={notes} onChange={(e) => setNotes(e.target.value)} disabled={submitting} />

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setActive(null)}>{t('common.cancel')}</Button>
              <Button loading={submitting} disabled={!canSubmit} onClick={submit}>{t('common.submit')}</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
