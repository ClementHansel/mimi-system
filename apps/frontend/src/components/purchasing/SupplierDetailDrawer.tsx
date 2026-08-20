'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus, Star, Trash2 } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { usePermissions } from '@/lib/permissions';
import { Button, Drawer, EmptyState, Input, Select, toast } from '@/components/ui';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs';
import { formatMoney } from '@/lib/formatters';
import {
  deleteSupplierItem,
  getItems,
  getSupplierItems,
  getSupplierPriceHistory,
  getSupplierTransactions,
  upsertSupplierItem,
} from './lib/api';
import type {
  Item,
  PriceHistoryEntry,
  Supplier,
  SupplierItem,
  SupplierTransaction,
} from './lib/types';

/**
 * One supplier in depth: what we buy from them and at what price (FR-SUP-03),
 * how that price has moved (FR-SUP-04), and what we have actually ordered
 * (FR-SUP-02/05).
 *
 * All three tabs sit behind price permissions, and they differ: `items` and
 * `history` need `supplier.price.read`, editing needs `supplier.price.manage`.
 * A user with neither still sees the drawer — the transactions tab only needs
 * `supplier.read` — rather than being shown an empty shell.
 *
 * Price history is READ-ONLY here by design: it is append-only server-side,
 * written as a side effect of changing a price on the items tab. Offering an
 * "edit history" affordance would imply the audit trail is editable.
 */
export function SupplierDetailDrawer({
  supplier,
  onClose,
}: {
  supplier: Supplier;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { can } = usePermissions();
  const canReadPrice = can('supplier.price.read');

  return (
    <Drawer open onClose={onClose} title={`${supplier.code} — ${supplier.name}`} side="right">
      <Tabs defaultValue={canReadPrice ? 'items' : 'transactions'}>
        <TabsList>
          {canReadPrice && (
            <TabsTrigger value="items">{t('purchasing.suppliers.tabItems')}</TabsTrigger>
          )}
          {canReadPrice && (
            <TabsTrigger value="history">{t('purchasing.suppliers.tabHistory')}</TabsTrigger>
          )}
          <TabsTrigger value="transactions">
            {t('purchasing.suppliers.tabTransactions')}
          </TabsTrigger>
        </TabsList>

        {canReadPrice && (
          <TabsContent value="items">
            <ItemsTab supplier={supplier} />
          </TabsContent>
        )}
        {canReadPrice && (
          <TabsContent value="history">
            <HistoryTab supplierId={supplier.id} />
          </TabsContent>
        )}
        <TabsContent value="transactions">
          <TransactionsTab supplierId={supplier.id} />
        </TabsContent>
      </Tabs>
    </Drawer>
  );
}

function ItemsTab({ supplier }: { supplier: Supplier }) {
  const { t } = useI18n();
  const { can } = usePermissions();
  const canManage = can('supplier.price.manage');

  const [rows, setRows] = useState<SupplierItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);

  const reload = useCallback(() => {
    setLoading(true);
    getSupplierItems(supplier.id)
      .then(setRows)
      .catch(() => toast({ title: t('table.error'), variant: 'danger' }))
      .finally(() => setLoading(false));
  }, [supplier.id, t]);

  useEffect(reload, [reload]);

  async function remove(itemId: string) {
    try {
      await deleteSupplierItem(supplier.id, itemId);
      reload();
    } catch {
      toast({ title: t('auth.genericError'), variant: 'danger' });
    }
  }

  if (loading) return <EmptyState title={t('table.loading')} />;

  return (
    <div className="flex flex-col gap-3">
      {canManage && (
        <div className="flex justify-end">
          <Button size="sm" leftIcon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
            {t('purchasing.suppliers.addItem')}
          </Button>
        </div>
      )}

      {rows.length === 0 && <EmptyState title={t('purchasing.suppliers.noItems')} />}

      {rows.map((row) => (
        <SupplierItemRow
          key={row.id}
          supplierId={supplier.id}
          row={row}
          canManage={canManage}
          onSaved={reload}
          onRemove={() => void remove(row.itemId)}
        />
      ))}

      {adding && (
        <AddItemForm
          supplierId={supplier.id}
          existingItemIds={rows.map((r) => r.itemId)}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            reload();
          }}
        />
      )}
    </div>
  );
}

function SupplierItemRow({
  supplierId,
  row,
  canManage,
  onSaved,
  onRemove,
}: {
  supplierId: string;
  row: SupplierItem;
  canManage: boolean;
  onSaved: () => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const [price, setPrice] = useState(row.currentPrice);
  const [saving, setSaving] = useState(false);
  const dirty = price !== row.currentPrice;

  async function save() {
    setSaving(true);
    try {
      await upsertSupplierItem(supplierId, row.itemId, {
        supplierSku: row.supplierSku,
        currentPrice: price,
        leadTimeDays: row.leadTimeDays,
        isPreferred: row.isPreferred,
      });
      toast({ title: t('purchasing.suppliers.priceUpdated'), variant: 'success' });
      onSaved();
    } catch {
      toast({ title: t('auth.genericError'), variant: 'danger' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-wrap items-end justify-between gap-3 rounded-lg border border-border p-3">
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-sm font-medium text-text-primary">
          {row.isPreferred && <Star className="size-3.5 text-warning-600" aria-hidden />}
          {row.itemName}
        </p>
        <p className="text-xs text-text-muted">
          {row.supplierSku ?? t('purchasing.suppliers.noSku')} ·{' '}
          {t('purchasing.suppliers.leadTime', { days: row.leadTimeDays })}
        </p>
      </div>
      <div className="flex items-end gap-2">
        <label className="block">
          <span className="mb-1 block text-xs text-text-secondary">
            {t('purchasing.suppliers.price')}
          </span>
          <Input
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            disabled={!canManage}
            inputMode="decimal"
            className="w-32"
          />
        </label>
        {canManage && (
          <>
            {/* Only offered once something actually changed — a live Save on
                every row invites accidental no-op writes, and each write that
                changes a price appends a permanent history entry. */}
            {dirty && (
              <Button size="sm" onClick={() => void save()} loading={saving}>
                {t('common.save')}
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={onRemove} aria-label={t('common.remove')}>
              <Trash2 className="size-4" aria-hidden />
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function AddItemForm({
  supplierId,
  existingItemIds,
  onClose,
  onSaved,
}: {
  supplierId: string;
  existingItemIds: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [items, setItems] = useState<Item[]>([]);
  const [itemId, setItemId] = useState('');
  const [price, setPrice] = useState('');
  const [sku, setSku] = useState('');
  const [leadTime, setLeadTime] = useState('0');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getItems()
      .then((res) =>
        // Items already on this supplier are filtered out: adding one again is
        // an UPDATE the row above already does, and offering it here would
        // silently overwrite a price from a blank form.
        setItems(res.rows.filter((i) => !existingItemIds.includes(i.id))),
      )
      .catch(() => setItems([]));
  }, [existingItemIds]);

  const canSubmit = itemId !== '' && price.trim() !== '' && !saving;

  async function submit() {
    if (!canSubmit) return;
    setSaving(true);
    try {
      await upsertSupplierItem(supplierId, itemId, {
        supplierSku: sku.trim() || null,
        currentPrice: price.trim(),
        leadTimeDays: Number.parseInt(leadTime, 10) || 0,
      });
      onSaved();
    } catch {
      toast({ title: t('auth.genericError'), variant: 'danger' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-brand-500 bg-surface-raised p-3">
      <Select
        value={itemId}
        onValueChange={setItemId}
        placeholder={t('purchasing.suppliers.selectItem')}
        options={items.map((i) => ({ value: i.id, label: i.name }))}
      />
      <div className="grid grid-cols-3 gap-2">
        <Input
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          placeholder={t('purchasing.suppliers.price')}
          inputMode="decimal"
        />
        <Input
          value={sku}
          onChange={(e) => setSku(e.target.value)}
          placeholder={t('purchasing.suppliers.sku')}
        />
        <Input
          value={leadTime}
          onChange={(e) => setLeadTime(e.target.value)}
          placeholder={t('purchasing.suppliers.leadTimeLabel')}
          inputMode="numeric"
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button size="sm" onClick={() => void submit()} loading={saving} disabled={!canSubmit}>
          {t('common.create')}
        </Button>
      </div>
    </div>
  );
}

function HistoryTab({ supplierId }: { supplierId: string }) {
  const { t } = useI18n();
  const [rows, setRows] = useState<PriceHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getSupplierPriceHistory(supplierId, { pageSize: 50 })
      .then((res) => setRows(res.rows))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [supplierId]);

  if (loading) return <EmptyState title={t('table.loading')} />;
  if (rows.length === 0) return <EmptyState title={t('purchasing.suppliers.noHistory')} />;

  return (
    <ul className="flex flex-col gap-2">
      {rows.map((r, idx) => (
        <li
          key={`${r.itemId}-${r.effectiveDate}-${idx}`}
          className="flex items-center justify-between gap-3 rounded-lg border border-border p-2.5 text-sm"
        >
          <div>
            <p className="font-medium text-text-primary">{r.itemName}</p>
            <p className="text-xs text-text-muted">{r.effectiveDate}</p>
          </div>
          <span className="font-mono">{formatMoney(r.price)}</span>
        </li>
      ))}
    </ul>
  );
}

function TransactionsTab({ supplierId }: { supplierId: string }) {
  const { t } = useI18n();
  const [rows, setRows] = useState<SupplierTransaction[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getSupplierTransactions(supplierId, { pageSize: 50 })
      .then((res) => setRows(res.rows))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [supplierId]);

  if (loading) return <EmptyState title={t('table.loading')} />;
  if (rows.length === 0) return <EmptyState title={t('purchasing.suppliers.noTransactions')} />;

  return (
    <ul className="flex flex-col gap-2">
      {rows.map((r) => (
        <li
          key={r.poId}
          className="flex items-center justify-between gap-3 rounded-lg border border-border p-2.5 text-sm"
        >
          <div>
            <p className="font-medium text-text-primary">{r.poNumber}</p>
            <p className="text-xs text-text-muted">
              {r.orderDate} · {r.status}
              {r.paymentStatus && ` · ${r.paymentStatus}`}
            </p>
          </div>
          <span className="font-mono">{formatMoney(r.total)}</span>
        </li>
      ))}
    </ul>
  );
}
