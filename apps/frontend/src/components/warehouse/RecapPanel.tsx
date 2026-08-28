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
  EmptyState,
  Button,
} from '@/components/ui';
import { ExportButton } from '@/components/common/ExportButton';
import type { CsvColumn } from '@/lib/export/csv';
import { formatQty } from '@/lib/formatters';
import { ApiError } from '@/lib/api';
import { getDailyRecap } from './lib/warehouse-api';
import type { DailyRecap } from './lib/types';

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
 * ONE ROW PER CITY+ITEM, which is the grain the on-screen cards and tables
 * already show, flattened: the per-city heading becomes a column, because a
 * spreadsheet pivots on a column and cannot pivot on a section header. The four
 * headline counts are repeated on every row rather than left out — a filtered
 * pivot of this file otherwise loses the document totals it was filtered from.
 */
interface RecapExportRow {
  date: string;
  city: string;
  outlets: number;
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
  { key: 'outlets', header: 'Jumlah Outlet' },
  { key: 'itemName', header: 'Nama Barang' },
  { key: 'qty', header: 'Jumlah', format: (r) => formatQty(r.qty) },
  { key: 'sjCount', header: 'Total Surat Jalan' },
  { key: 'dropCount', header: 'Total Drop' },
  { key: 'frozenSjCount', header: 'SJ Frozen' },
  { key: 'drySjCount', header: 'SJ Dry' },
];

/**
 * Daily delivery recap (FR-LOG-04/08) — what is going where today: SJ and
 * drop counts, the frozen/dry split, and per-city breakdown of items moving.
 */
export function RecapPanel() {
  const { t } = useI18n();
  const [date, setDate] = useState(todayISODate());
  const [recap, setRecap] = useState<DailyRecap | null>(null);
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

  const exportRows = useMemo<RecapExportRow[]>(() => {
    if (!recap) return [];
    return recap.byCity.flatMap((city) =>
      city.items.map((item) => ({
        date: recap.date,
        city: city.city,
        outlets: city.outlets,
        itemName: item.itemName,
        qty: item.qty,
        sjCount: recap.sjCount,
        dropCount: recap.dropCount,
        frozenSjCount: recap.frozenSjCount,
        drySjCount: recap.drySjCount,
      })),
    );
  }, [recap]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <Input
          type="date"
          label={t('common.date')}
          value={date}
          onChange={(e) => setDate(e.target.value)}
          wrapperClassName="max-w-xs"
        />
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

      {!loading && !error && recap && (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            <Card>
              <CardContent className="flex items-center gap-3 p-4">
                <Truck className="size-6 text-brand-600" aria-hidden />
                <div>
                  <p className="text-2xl font-semibold text-text-primary tabular-nums">
                    {recap.sjCount}
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
                    {recap.dropCount}
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
                    {recap.frozenSjCount}
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
                    {recap.drySjCount}
                  </p>
                  <p className="text-sm text-text-muted">{t('warehouse.recap.drySjCount')}</p>
                </div>
              </CardContent>
            </Card>
          </div>

          {recap.byCity.length === 0 && <EmptyState title={t('warehouse.recap.empty')} size="lg" />}

          {recap.byCity.map((city) => (
            <Card key={city.city}>
              <CardHeader className="flex-row items-center justify-between">
                <CardTitle className="text-base">{city.city}</CardTitle>
                <span className="text-sm text-text-muted">
                  {t('warehouse.recap.outletsCount', { count: city.outlets })}
                </span>
              </CardHeader>
              <CardContent className="overflow-x-auto p-0">
                <table className="w-full border-collapse text-sm">
                  <tbody>
                    {city.items.map((item) => (
                      <tr key={item.itemId} className="border-b border-border last:border-0">
                        <td className="px-4 py-2 text-text-primary">{item.itemName}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{formatQty(item.qty)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          ))}
        </>
      )}
    </div>
  );
}
