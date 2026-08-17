'use client';

import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import {
  Button, Modal, DataTable, StatusBadge, Select, Input, MoneyInput, PhotoCapture, toast, PermissionGate,
} from '@/components/ui';
import type { DataTableColumn, SelectOption } from '@/components/ui';
import { formatMoney } from '@/lib/formatters';
import { useOutletLocation } from './lib/use-outlet-location';
import { getItems, listPettyCash, createPettyCash, getSupplierDirectory } from './lib/outlet-api';
import { uploadAttachment } from './lib/attachments';
import type { PettyCash, Item } from './lib/types';
import type { Money, Qty } from '@/lib/shared-types';

interface LineDraft {
  description: string;
  itemId: string;
  qty: Qty | null;
  amount: Money | null;
  expenseCategory: string;
}

const EXPENSE_CATEGORIES = ['bahan_baku', 'kebersihan', 'operasional_lain'] as const;

/**
 * Petty cash: a small purchase with payment proof + item photo (both wajib).
 * The supplier picker uses `GET /api/suppliers/directory` — name + contact
 * only (D-20: outlet roles never see prices/payment terms) — with a
 * free-text fallback for a warung that isn't a registered supplier.
 */
export function PettyCashPanel() {
  const { t } = useI18n();
  const { locationId } = useOutletLocation();
  const [rows, setRows] = useState<PettyCash[]>([]);
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<Item[]>([]);
  const [supplierOptions, setSupplierOptions] = useState<SelectOption[]>([]);
  const [open, setOpen] = useState(false);
  const [useFreeText, setUseFreeText] = useState(false);
  const [storeName, setStoreName] = useState('');
  const [purchaseDate, setPurchaseDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [lines, setLines] = useState<LineDraft[]>([
    { description: '', itemId: '', qty: null, amount: null, expenseCategory: 'bahan_baku' },
  ]);
  const [paymentProof, setPaymentProof] = useState<File | null>(null);
  const [goodsPhoto, setGoodsPhoto] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);

  function reload() {
    if (!locationId) return;
    setLoading(true);
    listPettyCash(locationId).then((r) => setRows(r.rows)).finally(() => setLoading(false));
  }
  useEffect(reload, [locationId]);
  useEffect(() => {
    getItems().then((r) => setItems(r.rows));
    getSupplierDirectory()
      .then((r) => setSupplierOptions(r.rows.map((s) => ({ value: s.name, label: s.name }))))
      .catch(() => setUseFreeText(true)); // directory is online-only (Amendment 3) — offline falls back to free text
  }, []);

  const totalAmount = lines.reduce((sum, l) => sum + Number(l.amount ?? 0), 0);

  async function submit() {
    if (!locationId || !paymentProof || !goodsPhoto || !storeName.trim()) {
      toast({ title: t('validation.photoRequired'), variant: 'warning' });
      return;
    }
    const valid = lines.filter((l) => l.description.trim() && l.amount);
    if (valid.length === 0) return;
    setSaving(true);
    try {
      const [paymentProofAttachmentId, goodsPhotoAttachmentId] = await Promise.all([
        uploadAttachment({ file: paymentProof, fileName: paymentProof.name, mimeType: paymentProof.type || 'image/jpeg', kind: 'payment_proof' }),
        uploadAttachment({ file: goodsPhoto, fileName: goodsPhoto.name, mimeType: goodsPhoto.type || 'image/jpeg', kind: 'petty_cash_photo' }),
      ]);
      await createPettyCash({
        locationId,
        purchaseDate,
        storeName: storeName.trim(),
        lines: valid.map((l) => ({
          description: l.description, itemId: l.itemId || undefined, qty: l.qty ?? undefined,
          amount: l.amount as string, expenseCategory: l.expenseCategory,
        })),
        paymentProofAttachmentId,
        goodsPhotoAttachmentId,
      });
      toast({ title: t('outlet.pettyCash.created'), variant: 'success' });
      setOpen(false);
      setStoreName('');
      setLines([{ description: '', itemId: '', qty: null, amount: null, expenseCategory: 'bahan_baku' }]);
      setPaymentProof(null);
      setGoodsPhoto(null);
      reload();
    } catch {
      toast({ title: t('table.error'), variant: 'danger' });
    } finally {
      setSaving(false);
    }
  }

  const columns: DataTableColumn<PettyCash>[] = [
    { key: 'pcNumber', header: t('outlet.pettyCash.number') },
    { key: 'storeName', header: t('outlet.pettyCash.storeName') },
    { key: 'totalAmount', header: t('common.total'), align: 'right', render: (r) => formatMoney(r.totalAmount) },
    { key: 'status', header: t('common.status'), render: (r) => <StatusBadge domain="pettyCash" status={r.status} /> },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <PermissionGate permission="pettycash.create">
          <Button leftIcon={<Plus className="size-4" />} size="touch" onClick={() => setOpen(true)}>
            {t('outlet.pettyCash.new')}
          </Button>
        </PermissionGate>
      </div>

      <DataTable
        columns={columns}
        data={{ rows, total: rows.length, page: 1, pageSize: Math.max(rows.length, 1) }}
        keyField={(r) => r.id}
        loading={loading}
        emptyDescription={t('outlet.pettyCash.empty')}
      />

      <Modal open={open} onClose={() => setOpen(false)} title={t('outlet.pettyCash.new')} size="lg">
        <div className="flex flex-col gap-4">
          <Input type="date" label={t('common.date')} value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} />

          {!useFreeText && supplierOptions.length > 0 ? (
            <div className="flex items-end gap-2">
              <Select
                label={t('outlet.pettyCash.storeName')}
                value={storeName}
                onValueChange={setStoreName}
                options={supplierOptions}
                placeholder={t('common.selectPlaceholder')}
                wrapperClassName="flex-1"
              />
              <Button type="button" variant="ghost" size="sm" onClick={() => setUseFreeText(true)}>
                {t('outlet.pettyCash.useFreeText')}
              </Button>
            </div>
          ) : (
            <Input label={t('outlet.pettyCash.storeName')} value={storeName} onChange={(e) => setStoreName(e.target.value)} required />
          )}

          {lines.map((line, idx) => (
            <div key={idx} className="grid gap-3 sm:grid-cols-2">
              <Input label={t('outlet.pettyCash.description')} value={line.description}
                onChange={(e) => setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, description: e.target.value } : l)))} />
              <Select label={`${t('outlet.replenishment.item')} ${t('common.optional')}`} value={line.itemId}
                options={items.map((i) => ({ value: i.id, label: i.name }))}
                onValueChange={(v) => setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, itemId: v } : l)))}
                placeholder={t('common.selectPlaceholder')} />
              <MoneyInput label={t('common.total')} value={line.amount}
                onChange={(v) => setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, amount: v } : l)))} />
              <Select label={t('outlet.pettyCash.category')} value={line.expenseCategory}
                options={EXPENSE_CATEGORIES.map((c) => ({ value: c, label: t(`outlet.pettyCash.categoryOptions.${c}`) }))}
                onValueChange={(v) => setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, expenseCategory: v } : l)))} />
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" leftIcon={<Plus className="size-4" />}
            onClick={() => setLines((ls) => [...ls, { description: '', itemId: '', qty: null, amount: null, expenseCategory: 'bahan_baku' }])}>
            {t('outlet.replenishment.addLine')}
          </Button>

          <p className="text-right text-sm font-medium text-text-primary">
            {t('common.total')}: {formatMoney(String(totalAmount) as Money)}
          </p>

          <div className="grid gap-4 sm:grid-cols-2">
            <PhotoCapture label={t('outlet.pettyCash.paymentProofLabel')} value={paymentProof ? URL.createObjectURL(paymentProof) : null}
              onCapture={setPaymentProof} onRemove={() => setPaymentProof(null)} required />
            <PhotoCapture label={t('outlet.pettyCash.goodsPhotoLabel')} value={goodsPhoto ? URL.createObjectURL(goodsPhoto) : null}
              onCapture={setGoodsPhoto} onRemove={() => setGoodsPhoto(null)} required />
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
          <Button loading={saving} disabled={!paymentProof || !goodsPhoto} onClick={submit}>{t('common.submit')}</Button>
        </div>
      </Modal>
    </div>
  );
}
