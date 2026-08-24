'use client';

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Boxes, History } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Badge,
  Input,
  EmptyState,
  Modal,
  Button,
} from '@/components/ui';
import { ExportButton } from '@/components/common/ExportButton';
import type { CsvColumn } from '@/lib/export/csv';
import { formatQty } from '@/lib/formatters';
import { fmtDateTime } from '@/lib/dates';
import { ApiError } from '@/lib/api';
import { useWarehouseLocation } from './lib/use-warehouse-location';
import { getBalances, getMovements } from './lib/warehouse-api';
import type { Balance, Movement } from './lib/types';

// Exported as a flat (non-grouped) row list — the on-screen table groups by
// storage area, but a CSV is read in a spreadsheet where that grouping would
// just be a repeated column, not a section header.
const EXPORT_COLUMNS: CsvColumn<Balance>[] = [
  { key: 'sku', header: 'SKU' },
  { key: 'itemName', header: 'Nama Barang' },
  { key: 'storageAreaName', header: 'Area Penyimpanan' },
  { key: 'qtyOnHand', header: 'Qty', format: (b) => formatQty(b.qtyOnHand, b.unitCode) },
  { key: 'belowMin', header: 'Di Bawah Minimum', format: (b) => (b.belowMin ? 'Ya' : 'Tidak') },
];

/**
 * Warehouse stock — balances per storage area (freezer/chiller/dry store),
 * min-stock alerts (`belowMin`, per FR-LOG-07/18/20), and per-item movement
 * history on demand (FR-LOG-21) so a discrepancy can be traced back to its
 * originating transfer/receipt/shipment without leaving this screen.
 */
export function StockPanel() {
  const { t } = useI18n();
  const { locationId } = useWarehouseLocation();
  const [balances, setBalances] = useState<Balance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [q, setQ] = useState('');
  const [historyFor, setHistoryFor] = useState<Balance | null>(null);
  const [movements, setMovements] = useState<Movement[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | undefined>(undefined);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!locationId) return;
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    getBalances({ locationId })
      .then((res) => !cancelled && setBalances(res.rows))
      .catch(
        (err: unknown) =>
          !cancelled && setError(err instanceof ApiError ? err.message : t('table.error')),
      )
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [locationId, t, reloadToken]);

  // Flat (non-grouped) list — shared by the on-screen table's grouping below
  // and by the CSV export, which wants one row per item, not a section per
  // storage area.
  const filteredBalances = useMemo(() => {
    const term = q.trim().toLowerCase();
    return term
      ? balances.filter(
          (b) => b.itemName.toLowerCase().includes(term) || b.sku.toLowerCase().includes(term),
        )
      : balances;
  }, [balances, q]);

  const byArea = useMemo(() => {
    const groups = new Map<string, Balance[]>();
    for (const b of filteredBalances)
      groups.set(b.storageAreaName, [...(groups.get(b.storageAreaName) ?? []), b]);
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [filteredBalances]);

  function openHistory(b: Balance) {
    if (!locationId) return;
    setHistoryFor(b);
    setHistoryLoading(true);
    setHistoryError(undefined);
    getMovements({ locationId, itemId: b.itemId, storageAreaId: b.storageAreaId })
      .then((res) => setMovements(res.rows))
      .catch((err: unknown) =>
        setHistoryError(err instanceof ApiError ? err.message : t('table.error')),
      )
      .finally(() => setHistoryLoading(false));
  }

  // This account has no `warehouse`-type location (e.g. a company-wide role
  // like Owner) — genuinely nothing to fetch or retry, so say that plainly
  // instead of the generic `table.error` (which reads as "the request
  // failed" when no request was ever attempted; FIX-LOADS #1).
  if (!locationId) return <EmptyState title={t('warehouse.noLocation')} size="lg" />;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Input
          placeholder={t('common.filter')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          wrapperClassName="max-w-sm"
        />
        <ExportButton rows={filteredBalances} columns={EXPORT_COLUMNS} filenameBase="stok-gudang" />
      </div>

      {loading && <EmptyState title={t('table.loading')} size="lg" />}
      {!loading && error && (
        <EmptyState
          title={error}
          size="lg"
          action={
            <Button variant="outline" size="sm" onClick={() => setReloadToken((n) => n + 1)}>
              {t('common.retry')}
            </Button>
          }
        />
      )}
      {!loading && !error && byArea.length === 0 && (
        <EmptyState title={t('table.empty')} size="lg" />
      )}

      {!loading &&
        !error &&
        byArea.map(([areaName, items]) => (
          <Card key={areaName}>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle className="flex items-center gap-2 text-base">
                <Boxes className="size-4" aria-hidden />
                {areaName}
              </CardTitle>
              <span className="text-sm text-text-muted">{items.length} item</span>
            </CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <table className="w-full border-collapse text-sm">
                <tbody>
                  {items.map((b) => (
                    <tr
                      key={`${b.storageAreaId}-${b.itemId}`}
                      className="cursor-pointer border-b border-border last:border-0 hover:bg-surface-sunken"
                      onClick={() => openHistory(b)}
                    >
                      <td className="px-4 py-2.5 text-text-primary">{b.itemName}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {formatQty(b.qtyOnHand, b.unitCode)}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {b.belowMin && (
                          <Badge variant="warning" size="sm">
                            <AlertTriangle className="size-3" aria-hidden />
                            {t('outlet.stock.belowMin')}
                          </Badge>
                        )}
                      </td>
                      <td className="w-8 px-2 py-2.5 text-right text-text-muted">
                        <History className="size-4" aria-hidden />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        ))}

      <Modal
        open={!!historyFor}
        onClose={() => setHistoryFor(null)}
        title={historyFor?.itemName ?? ''}
        size="lg"
      >
        {historyLoading && <EmptyState title={t('table.loading')} size="sm" />}
        {!historyLoading && historyError && (
          <EmptyState
            title={historyError}
            size="sm"
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={() => historyFor && openHistory(historyFor)}
              >
                {t('common.retry')}
              </Button>
            }
          />
        )}
        {!historyLoading && !historyError && movements.length === 0 && (
          <EmptyState title={t('table.empty')} size="sm" />
        )}
        {!historyLoading && !historyError && movements.length > 0 && (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-sunken text-left text-text-secondary">
                <th className="px-3 py-2">{t('common.date')}</th>
                <th className="px-3 py-2">{t('warehouse.stock.movementType')}</th>
                <th className="px-3 py-2 text-right">{t('outlet.replenishment.qty')}</th>
                <th className="px-3 py-2">{t('warehouse.stock.counterparty')}</th>
                <th className="px-3 py-2">{t('common.reason')}</th>
              </tr>
            </thead>
            <tbody>
              {movements.map((m) => (
                <tr key={m.id} className="border-b border-border last:border-0">
                  <td className="px-3 py-2.5 whitespace-nowrap">{fmtDateTime(m.occurredAt)}</td>
                  <td className="px-3 py-2.5">
                    {t(`warehouse.stock.movementTypes.${m.movementType}`) ===
                    `warehouse.stock.movementTypes.${m.movementType}`
                      ? m.movementType
                      : t(`warehouse.stock.movementTypes.${m.movementType}`)}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{formatQty(m.qty)}</td>
                  <td className="px-3 py-2.5">{m.counterpartyLocationName ?? '—'}</td>
                  <td className="px-3 py-2.5">{m.reason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="mt-4 flex justify-end">
          <Button variant="outline" onClick={() => setHistoryFor(null)}>
            {t('common.close')}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
