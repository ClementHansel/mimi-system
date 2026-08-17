'use client';

import { useEffect, useState } from 'react';
import { Snowflake, Package, Truck, MapPin } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { Card, CardContent, CardHeader, CardTitle, Input, EmptyState, toast } from '@/components/ui';
import { formatQty } from '@/lib/formatters';
import { getDailyRecap } from './lib/warehouse-api';
import type { DailyRecap } from './lib/types';

function todayISODate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Daily delivery recap (FR-LOG-04/08) — what is going where today: SJ and
 * drop counts, the frozen/dry split, and per-city breakdown of items moving.
 */
export function RecapPanel() {
  const { t } = useI18n();
  const [date, setDate] = useState(todayISODate());
  const [recap, setRecap] = useState<DailyRecap | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    getDailyRecap(date)
      .then(setRecap)
      .catch(() => toast({ title: t('table.error'), variant: 'danger' }))
      .finally(() => setLoading(false));
  }, [date, t]);

  return (
    <div className="flex flex-col gap-4">
      <Input type="date" label={t('common.date')} value={date} onChange={(e) => setDate(e.target.value)} wrapperClassName="max-w-xs" />

      {loading && <EmptyState title={t('table.loading')} size="lg" />}

      {!loading && recap && (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            <Card>
              <CardContent className="flex items-center gap-3 p-4">
                <Truck className="size-6 text-brand-600" aria-hidden />
                <div>
                  <p className="text-2xl font-semibold text-text-primary tabular-nums">{recap.sjCount}</p>
                  <p className="text-sm text-text-muted">{t('warehouse.recap.sjCount')}</p>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="flex items-center gap-3 p-4">
                <MapPin className="size-6 text-brand-600" aria-hidden />
                <div>
                  <p className="text-2xl font-semibold text-text-primary tabular-nums">{recap.dropCount}</p>
                  <p className="text-sm text-text-muted">{t('warehouse.recap.dropCount')}</p>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="flex items-center gap-3 p-4">
                <Snowflake className="size-6 text-cold-600" aria-hidden />
                <div>
                  <p className="text-2xl font-semibold text-text-primary tabular-nums">{recap.frozenSjCount}</p>
                  <p className="text-sm text-text-muted">{t('warehouse.recap.frozenSjCount')}</p>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="flex items-center gap-3 p-4">
                <Package className="size-6 text-text-muted" aria-hidden />
                <div>
                  <p className="text-2xl font-semibold text-text-primary tabular-nums">{recap.drySjCount}</p>
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
                <span className="text-sm text-text-muted">{t('warehouse.recap.outletsCount', { count: city.outlets })}</span>
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
