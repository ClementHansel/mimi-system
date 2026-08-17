'use client';

import { useEffect, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { ApiError } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fmtDate } from '@/lib/dates';
import { formatMoney } from '@/lib/formatters';
import { DataTable, type DataTableColumn } from '@/components/ui/DataTable';
import { Select } from '@/components/ui/Select';
import { EmptyState } from '@/components/ui/EmptyState';
import { getItems, getSuppliers, getSupplierPriceHistory } from './lib/api';
import type { Item, PriceHistoryEntry } from './lib/types';
import type { Paginated } from '@/lib/shared-types';

function errMsg(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/**
 * FR-SUP-04 — append-only supplier price history, role-locked behind
 * `supplier.price.read` (D-20/Amendment 3: outlet roles see a supplier's
 * name/contact via the directory but never its pricing). `PurchasingShell`
 * already hides this tab entirely for a role without the permission; the
 * explicit 403 branch here is the defensive second layer the ticket calls
 * for — a stale session, a deep link, or a role change mid-session still
 * gets a real "no access" message instead of a silently empty table.
 *
 * Not built on `useApiList` (unlike the other two panels): the list only
 * makes sense once a supplier is picked, and that hook always fires its GET
 * on mount regardless of whether `path` is meaningful yet — this panel owns
 * its own fetch so it never calls `/suppliers//price-history` before a
 * supplier is selected.
 */
export function SupplierPriceHistoryPanel() {
  const { t } = useI18n();
  const { can } = usePermissions();
  const [suppliers, setSuppliers] = useState<{ id: string; name: string }[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [supplierId, setSupplierId] = useState('');
  const [itemId, setItemId] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [data, setData] = useState<Paginated<PriceHistoryEntry>>({ rows: [], total: 0, page: 1, pageSize: 25 });
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!can('supplier.read') || !can('supplier.price.read')) return;
    getSuppliers().then((r) => { setSuppliers(r.rows); if (r.rows[0]) setSupplierId(r.rows[0].id); })
      .catch((err) => setLoadError(errMsg(err, t('auth.genericError'))));
    getItems().then((r) => setItems(r.rows)).catch(() => {});
  }, [can, t]);

  useEffect(() => {
    if (!supplierId) { setData({ rows: [], total: 0, page: 1, pageSize }); return; }
    let cancelled = false;
    setLoading(true); setListError(undefined);
    getSupplierPriceHistory(supplierId, { itemId: itemId || undefined, page, pageSize })
      .then((res) => { if (!cancelled) setData(res); })
      .catch((err) => { if (!cancelled) setListError(errMsg(err, t('table.error'))); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [supplierId, itemId, page, pageSize, t]);

  if (!can('supplier.price.read')) {
    return <EmptyState icon={ShieldAlert} title={t('permissionGate.noAccess')} size="lg" />;
  }

  if (loadError) {
    return <EmptyState icon={ShieldAlert} title={loadError} size="lg" />;
  }

  const columns: DataTableColumn<PriceHistoryEntry>[] = [
    { key: 'itemName', header: t('purchasing.priceHistory.columnItem') },
    { key: 'price', header: t('purchasing.priceHistory.columnPrice'), align: 'right', render: (r) => formatMoney(r.price) },
    { key: 'effectiveDate', header: t('purchasing.priceHistory.columnEffectiveDate'), render: (r) => fmtDate(r.effectiveDate) },
    { key: 'source', header: t('purchasing.priceHistory.columnSource'), render: (r) => t(`purchasing.priceHistory.source.${r.source}`) },
    { key: 'recordedBy', header: t('purchasing.priceHistory.columnRecordedBy'), render: (r) => r.recordedBy ?? '—' },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-2">
        <Select
          label={t('purchasing.priceHistory.supplier')}
          value={supplierId}
          onValueChange={(v) => { setSupplierId(v); setPage(1); }}
          options={suppliers.map((s) => ({ value: s.id, label: s.name }))}
          placeholder={t('common.selectPlaceholder')}
          wrapperClassName="w-56"
        />
        <Select
          label={t('purchasing.priceHistory.item')}
          value={itemId}
          onValueChange={(v) => { setItemId(v); setPage(1); }}
          options={items.map((i) => ({ value: i.id, label: i.name }))}
          placeholder={t('purchasing.priceHistory.filterItemAll')}
          wrapperClassName="w-56"
        />
      </div>

      {!supplierId ? (
        <EmptyState title={t('purchasing.priceHistory.selectSupplier')} size="sm" />
      ) : (
        <DataTable
          columns={columns}
          data={data}
          keyField={(r) => `${r.itemId}-${r.effectiveDate}-${r.recordedBy}`}
          loading={loading}
          error={listError}
          emptyDescription={t('purchasing.priceHistory.empty')}
          onPageChange={setPage}
          onPageSizeChange={(n) => { setPageSize(n); setPage(1); }}
        />
      )}
    </div>
  );
}
