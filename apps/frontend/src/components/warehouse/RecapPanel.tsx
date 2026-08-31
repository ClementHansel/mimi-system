'use client';

import { useEffect, useMemo, useState } from 'react';
import { Snowflake, Package, Truck, MapPin } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Select,
  EmptyState,
  Button,
} from '@/components/ui';
import { ExportButton } from '@/components/common/ExportButton';
import type { CsvColumn } from '@/lib/export/csv';
import { formatQty } from '@/lib/formatters';
import { ApiError } from '@/lib/api';
import { getDailyRecap } from './lib/warehouse-api';
import type { DailyRecap, DailyRecapItem } from './lib/types';

const ALL = 'all';

function todayISODate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * EXPORT ONLY, and there is no import to add here.
 *
 * The recap is DERIVED — the backend computes it from the day's Surat Jalan and
 * drops (`GET /reports/daily-recap`). There is nothing to import into: a CSV of
 * "yesterday's totals" would either be ignored or, worse, become a second,
 * hand-editable version of numbers the documents already determine. Bulk import
 * on this screen belongs upstream, on the Surat Jalan the recap counts.
 *
 * ONE ROW PER CITY+OUTLET+ITEM — the finest grain the API returns, and finer
 * than the screen shows, because a spreadsheet pivots UP but cannot pivot down
 * into a grain the file never carried. The rows exported are the rows the
 * current city/outlet filter selects, so the file matches what was on screen.
 * The four headline counts are repeated on every row rather than left out — a
 * filtered pivot of this file otherwise loses the totals it was filtered from —
 * and they are the SCOPED counts, matching the cards above the table.
 */
interface RecapExportRow {
  date: string;
  city: string;
  outletName: string;
  itemName: string;
  qty: string;
  sjCount: number;
  dropCount: number;
  frozenSjCount: number;
  drySjCount: number;
}

const EXPORT_COLUMNS: CsvColumn<RecapExportRow>[] = [
  { key: 'date', header: 'Tanggal' },
  { key: 'city', header: 'Kota' },
  { key: 'outletName', header: 'Outlet' },
  { key: 'itemName', header: 'Nama Barang' },
  { key: 'qty', header: 'Jumlah', format: (r) => formatQty(r.qty) },
  { key: 'sjCount', header: 'Total Surat Jalan' },
  { key: 'dropCount', header: 'Total Drop' },
  { key: 'frozenSjCount', header: 'SJ Frozen' },
  { key: 'drySjCount', header: 'SJ Dry' },
];

/** Sum per-item rows across outlets/cities into one item-name-ordered list. */
function mergeItems(lists: DailyRecapItem[][]): DailyRecapItem[] {
  const merged = new Map<string, DailyRecapItem>();
  for (const list of lists) {
    for (const item of list) {
      const seen = merged.get(item.itemId);
      if (seen) seen.qty = String(Number(seen.qty) + Number(item.qty));
      else merged.set(item.itemId, { ...item });
    }
  }
  return [...merged.values()].sort((a, b) => a.itemName.localeCompare(b.itemName));
}

/**
 * Daily delivery recap (FR-LOG-04/08) — what is going where today: SJ and
 * drop counts, the frozen/dry split, and the items moving.
 *
 * ONE TABLE, NOT A STACK OF CITY CARDS. The panel used to render every city's
 * full item list on one page, which is a long scroll with no total anywhere:
 * the reader had to add four tables in their head to answer "how much chicken
 * moves today". The default is now the AGGREGATE across all cities, narrowed by
 * two filters (city, then outlet within it) — so the day total, a city, and a
 * single outlet are all one view with the same shape, and the headline cards
 * re-scope with the filter instead of silently staying day-wide.
 */
export function RecapPanel() {
  const { t } = useI18n();
  const [date, setDate] = useState(todayISODate());
  const [recap, setRecap] = useState<DailyRecap | null>(null);
  const [city, setCity] = useState<string>(ALL);
  const [outlet, setOutlet] = useState<string>(ALL);
  const [itemQuery, setItemQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    getDailyRecap(date)
      .then((res) => !cancelled && setRecap(res))
      .catch(
        (err: unknown) =>
          !cancelled && setError(err instanceof ApiError ? err.message : t('table.error')),
      )
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [date, t, reloadToken]);

  // A city that had drops yesterday may have none today. Left alone, the filter
  // would keep pointing at it and the panel would read "no items" on a day that
  // has plenty — so a selection the new day cannot honour falls back to ALL.
  const selectedCity = useMemo(
    () => recap?.byCity.find((c) => c.city === city) ?? null,
    [recap, city],
  );
  useEffect(() => {
    if (recap && city !== ALL && !selectedCity) setCity(ALL);
  }, [recap, city, selectedCity]);

  const selectedOutlet = useMemo(
    () => selectedCity?.byOutlet.find((o) => o.locationId === outlet) ?? null,
    [selectedCity, outlet],
  );
  useEffect(() => {
    if (outlet !== ALL && !selectedOutlet) setOutlet(ALL);
  }, [outlet, selectedOutlet]);

  const cityOptions = useMemo(
    () => [
      { value: ALL, label: t('warehouse.recap.allCities') },
      ...(recap?.byCity ?? []).map((c) => ({ value: c.city, label: c.city })),
    ],
    [recap, t],
  );

  const outletOptions = useMemo(
    () => [
      { value: ALL, label: t('warehouse.recap.allOutlets') },
      ...(selectedCity?.byOutlet ?? []).map((o) => ({
        value: o.locationId,
        label: o.locationName,
      })),
    ],
    [selectedCity, t],
  );

  /**
   * The one view model the cards, the table and the export all read from, so
   * the three cannot disagree about what "the current filter" means.
   */
  const scope = useMemo(() => {
    if (!recap) return null;
    if (selectedCity && selectedOutlet) {
      return {
        title: `${selectedCity.city} — ${selectedOutlet.locationName}`,
        sjCount: selectedOutlet.sjCount,
        dropCount: selectedOutlet.dropCount,
        frozenSjCount: selectedOutlet.frozenSjCount,
        drySjCount: selectedOutlet.drySjCount,
        items: selectedOutlet.items,
      };
    }
    if (selectedCity) {
      return {
        title: selectedCity.city,
        sjCount: selectedCity.sjCount,
        dropCount: selectedCity.dropCount,
        frozenSjCount: selectedCity.frozenSjCount,
        drySjCount: selectedCity.drySjCount,
        items: selectedCity.items,
      };
    }
    return {
      title: t('warehouse.recap.scopeAll'),
      sjCount: recap.sjCount,
      dropCount: recap.dropCount,
      frozenSjCount: recap.frozenSjCount,
      drySjCount: recap.drySjCount,
      items: mergeItems(recap.byCity.map((c) => c.items)),
    };
  }, [recap, selectedCity, selectedOutlet, t]);

  const visibleItems = useMemo(() => {
    if (!scope) return [];
    const q = itemQuery.trim().toLowerCase();
    if (!q) return scope.items;
    return scope.items.filter((i) => i.itemName.toLowerCase().includes(q));
  }, [scope, itemQuery]);

  const outletsInScope = useMemo(() => {
    if (!recap) return 0;
    if (selectedOutlet) return 1;
    if (selectedCity) return selectedCity.outlets;
    return recap.byCity.reduce((n, c) => n + c.outlets, 0);
  }, [recap, selectedCity, selectedOutlet]);

  const exportRows = useMemo<RecapExportRow[]>(() => {
    if (!recap || !scope) return [];
    const cities = selectedCity ? [selectedCity] : recap.byCity;
    const q = itemQuery.trim().toLowerCase();
    return cities.flatMap((c) =>
      c.byOutlet
        .filter((o) => !selectedOutlet || o.locationId === selectedOutlet.locationId)
        .flatMap((o) =>
          o.items
            .filter((item) => !q || item.itemName.toLowerCase().includes(q))
            .map((item) => ({
              date: recap.date,
              city: c.city,
              outletName: o.locationName,
              itemName: item.itemName,
              qty: item.qty,
              sjCount: scope.sjCount,
              dropCount: scope.dropCount,
              frozenSjCount: scope.frozenSjCount,
              drySjCount: scope.drySjCount,
            })),
        ),
    );
  }, [recap, scope, selectedCity, selectedOutlet, itemQuery]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="flex flex-wrap items-end gap-2">
          <Input
            type="date"
            label={t('common.date')}
            value={date}
            onChange={(e) => setDate(e.target.value)}
            wrapperClassName="max-w-[12rem]"
          />
          <Select
            label={t('warehouse.recap.city')}
            options={cityOptions}
            value={city}
            onValueChange={(v) => {
              setCity(v);
              // The outlet list is a list of THIS city's outlets; keeping the
              // old pick across a city change would leave the select holding a
              // value that is not in its own dropdown.
              setOutlet(ALL);
            }}
            wrapperClassName="min-w-[10rem]"
          />
          <Select
            label={t('warehouse.recap.outlet')}
            options={outletOptions}
            value={outlet}
            onValueChange={setOutlet}
            disabled={!selectedCity}
            wrapperClassName="min-w-[12rem]"
          />
        </div>
        {/* The date is part of the filename via `businessDateFilename`, but the
            recap is for the CHOSEN day, which is not necessarily today — so the
            selected date leads the base name too, otherwise a folder of exports
            all claim to be the day they were downloaded. */}
        <ExportButton
          rows={exportRows}
          columns={EXPORT_COLUMNS}
          filenameBase={`rekap-harian-${date}`}
          pdfTitle={`${t('warehouse.tabs.recap')} — ${date}`}
        />
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

      {!loading && !error && recap && scope && (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            <Card>
              <CardContent className="flex items-center gap-3 p-4">
                <Truck className="size-6 text-brand-600" aria-hidden />
                <div>
                  <p className="text-2xl font-semibold text-text-primary tabular-nums">
                    {scope.sjCount}
                  </p>
                  <p className="text-sm text-text-muted">{t('warehouse.recap.sjCount')}</p>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="flex items-center gap-3 p-4">
                <MapPin className="size-6 text-brand-600" aria-hidden />
                <div>
                  <p className="text-2xl font-semibold text-text-primary tabular-nums">
                    {scope.dropCount}
                  </p>
                  <p className="text-sm text-text-muted">{t('warehouse.recap.dropCount')}</p>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="flex items-center gap-3 p-4">
                <Snowflake className="size-6 text-cold-600" aria-hidden />
                <div>
                  <p className="text-2xl font-semibold text-text-primary tabular-nums">
                    {scope.frozenSjCount}
                  </p>
                  <p className="text-sm text-text-muted">{t('warehouse.recap.frozenSjCount')}</p>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="flex items-center gap-3 p-4">
                <Package className="size-6 text-text-muted" aria-hidden />
                <div>
                  <p className="text-2xl font-semibold text-text-primary tabular-nums">
                    {scope.drySjCount}
                  </p>
                  <p className="text-sm text-text-muted">{t('warehouse.recap.drySjCount')}</p>
                </div>
              </CardContent>
            </Card>
          </div>

          {recap.byCity.length === 0 && <EmptyState title={t('warehouse.recap.empty')} size="lg" />}

          {recap.byCity.length > 0 && (
            <Card>
              <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
                <div>
                  <CardTitle className="text-base">{scope.title}</CardTitle>
                  <p className="text-sm text-text-muted">
                    {t('warehouse.recap.outletsCount', { count: outletsInScope })} ·{' '}
                    {t('warehouse.recap.itemsCount', { count: scope.items.length })}
                  </p>
                </div>
                <Input
                  type="search"
                  value={itemQuery}
                  onChange={(e) => setItemQuery(e.target.value)}
                  placeholder={t('warehouse.recap.searchItem')}
                  aria-label={t('warehouse.recap.searchItem')}
                  wrapperClassName="max-w-[14rem]"
                />
              </CardHeader>
              <CardContent className="overflow-x-auto p-0">
                {visibleItems.length === 0 ? (
                  <EmptyState title={t('warehouse.recap.noItems')} size="sm" />
                ) : (
                  <table className="w-full border-collapse text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-text-muted">
                        <th className="px-4 py-2 font-medium">{t('warehouse.recap.item')}</th>
                        <th className="px-4 py-2 text-right font-medium">
                          {t('warehouse.recap.qty')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleItems.map((item) => (
                        <tr key={item.itemId} className="border-b border-border last:border-0">
                          <td className="px-4 py-2 text-text-primary">{item.itemName}</td>
                          <td className="px-4 py-2 text-right tabular-nums">
                            {formatQty(item.qty)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
