'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { api } from '@/lib/api';
import { Card, CardContent, EmptyState, Input, Select } from '@/components/ui';
import { formatQty } from '@/lib/formatters';

/**
 * Chain-wide stock, filterable to one location.
 *
 * Gudang has a stock screen and so does each outlet — but the OFFICE had none,
 * so the one role that needs to compare branches (owner, manager, finance)
 * could only look at one location at a time by signing into its interface.
 * Owner, 2026-08-24: "dashboard need to have inventory list too for all items
 * and filterable per location or gudang including office itself."
 *
 * Reuses `GET /inventory/balances`, which already takes an optional
 * `locationId` — no new endpoint, so the numbers here cannot drift from the
 * ones the warehouse and outlet screens show. Omitting `locationId` returns
 * everything the caller's RLS scope allows, which for a central role is the
 * whole chain and for anyone else is exactly their own locations. That is the
 * correct behaviour and it is the database's decision, not this component's.
 *
 * `pageSize` is capped at 200 backend-wide; asking for more returns
 * ERR_VALIDATION rather than more rows (a bug that once left the gudang stock
 * tab permanently showing "Gagal memuat data"). With no location filter the
 * chain has far more than 200 balance rows, so the count of what is being shown
 * is stated plainly rather than implying the list is complete.
 */
interface BalanceRow {
  locationId: string;
  locationName?: string;
  storageAreaName: string;
  itemName: string;
  sku: string;
  unitCode: string;
  qtyOnHand: string;
  minQty: string | null;
  belowMin: boolean;
}

interface LocationOption {
  id: string;
  code: string;
  name: string;
  type: string;
}

const PAGE_SIZE = 200;

export function InventoryPanel() {
  const { t } = useI18n();
  const [locations, setLocations] = useState<LocationOption[]>([]);
  const [locationId, setLocationId] = useState('');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<BalanceRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ rows?: LocationOption[]; data?: LocationOption[] } | LocationOption[]>(
        '/locations?active=true',
      )
      .then((res) => {
        if (cancelled) return;
        setLocations(Array.isArray(res) ? res : (res.rows ?? res.data ?? []));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    setFailed(false);
    const qs = new URLSearchParams({ page: '1', pageSize: String(PAGE_SIZE) });
    if (locationId) qs.set('locationId', locationId);
    if (q.trim()) qs.set('q', q.trim());
    api
      // `{ rows, total, page, pageSize }` — read off the running API. I wrote
      // `data` here from memory and shipped a panel that rendered "no matching
      // stock" over 1,372 real balance rows; that is the second time in one
      // session I have guessed this envelope wrong.
      .get<{ rows: BalanceRow[]; total: number }>(`/inventory/balances?${qs.toString()}`)
      .then((res) => {
        setRows(res.rows ?? []);
        setTotal(res.total ?? 0);
      })
      .catch(() => setFailed(true))
      .finally(() => setLoading(false));
  }, [locationId, q]);

  useEffect(load, [load]);

  const options = [
    { value: '', label: t('dashboard.inventory.allLocations') },
    ...locations.map((l) => ({ value: l.id, label: `${l.code} — ${l.name}` })),
  ];

  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <Select
            label={t('dashboard.inventory.location')}
            value={locationId}
            onValueChange={setLocationId}
            options={options}
            wrapperClassName="min-w-[16rem]"
          />
          <Input
            label={t('dashboard.inventory.search')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('dashboard.inventory.searchPlaceholder')}
            wrapperClassName="min-w-[14rem] flex-1"
          />
        </div>

        {loading ? (
          <EmptyState title={t('table.loading')} />
        ) : failed ? (
          <EmptyState title={t('table.error')} />
        ) : rows.length === 0 ? (
          <EmptyState title={t('dashboard.inventory.empty')} />
        ) : (
          <>
            {/* Said out loud rather than implied: the endpoint caps at 200 rows,
                and the whole chain has many more than that. A truncated list
                that looks complete is how someone concludes an item is not
                stocked anywhere. */}
            {total > rows.length && (
              <p className="text-xs text-warning-800">
                {t('dashboard.inventory.truncated', { shown: rows.length, total })}
              </p>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-text-muted">
                    <th className="py-2 pr-3 font-medium">{t('dashboard.inventory.item')}</th>
                    <th className="py-2 pr-3 font-medium">{t('dashboard.inventory.area')}</th>
                    <th className="py-2 pr-3 text-right font-medium">
                      {t('dashboard.inventory.onHand')}
                    </th>
                    <th className="py-2 pr-3 text-right font-medium">
                      {t('dashboard.inventory.minQty')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr
                      key={`${r.locationId}-${r.storageAreaName}-${r.sku}-${i}`}
                      className="border-b border-border/60"
                    >
                      <td className="py-2 pr-3">
                        <span className="font-medium text-text-primary">{r.itemName}</span>
                        <span className="ml-2 font-mono text-xs text-text-muted">{r.sku}</span>
                      </td>
                      <td className="py-2 pr-3 text-text-secondary">{r.storageAreaName}</td>
                      <td className="py-2 pr-3 text-right">
                        <span
                          className={
                            r.belowMin ? 'font-semibold text-danger-600' : 'text-text-primary'
                          }
                        >
                          {formatQty(r.qtyOnHand)} {r.unitCode}
                        </span>
                        {r.belowMin && (
                          <AlertTriangle
                            className="ml-1 inline size-3.5 text-danger-600"
                            aria-label={t('dashboard.inventory.belowMin')}
                          />
                        )}
                      </td>
                      <td className="py-2 pr-3 text-right text-text-muted">
                        {r.minQty ? formatQty(r.minQty) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
