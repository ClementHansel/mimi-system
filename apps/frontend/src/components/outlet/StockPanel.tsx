'use client';

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Boxes } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Badge,
  Input,
  EmptyState,
} from '@/components/ui';
import { formatQty } from '@/lib/formatters';
import { toast } from '@/components/ui';
import { ExportButton } from '@/components/common/ExportButton';
import { useOutletLocationContext } from './lib/outlet-location-context';
import { getBalances } from './lib/outlet-api';
import { BALANCE_EXPORT_COLUMNS } from './lib/outlet-export-columns';
import type { Balance } from './lib/types';

/**
 * "Stok per storage area" (freezer/chiller/dry store/display/kitchen line) —
 * grouped by area, not one outlet total, per the ticket's explicit ask: stock
 * is keyed by area on the wire (`Balance.storageAreaId`), so the screen keeps
 * that grouping instead of flattening it.
 */
export function StockPanel() {
  const { t } = useI18n();
  const { locationId, locationName } = useOutletLocationContext();
  const [balances, setBalances] = useState<Balance[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getBalances({ locationId })
      .then((res) => !cancelled && setBalances(res.rows))
      .catch(() => toast({ title: t('table.error'), variant: 'danger' }))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [locationId, t]);

  const filtered = useMemo(
    () =>
      q.trim()
        ? balances.filter(
            (b) =>
              b.itemName.toLowerCase().includes(q.trim().toLowerCase()) ||
              b.sku.toLowerCase().includes(q.trim().toLowerCase()),
          )
        : balances,
    [balances, q],
  );

  const byArea = useMemo(() => {
    const groups = new Map<string, Balance[]>();
    for (const b of filtered) {
      const key = b.storageAreaName;
      groups.set(key, [...(groups.get(key) ?? []), b]);
    }
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Input
          placeholder={t('common.filter')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          wrapperClassName="max-w-sm"
        />
        {/* `fetchAll` needs no request: every balance is already held client-side
            (the list fetches pageSize=500), so "everything" vs "what I filtered
            to" is a real and free choice. */}
        <ExportButton
          rows={filtered}
          columns={BALANCE_EXPORT_COLUMNS}
          filenameBase={`stok-${locationName.toLowerCase().replace(/\s+/g, '-')}`}
          fetchAll={async () => balances}
          pdfTitle={t('outlet.stock.reportTitle', { outlet: locationName })}
        />
      </div>

      {loading && <EmptyState title={t('table.loading')} size="lg" />}

      {!loading && byArea.length === 0 && <EmptyState title={t('table.empty')} size="lg" />}

      {!loading &&
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
                      className="border-b border-border last:border-0"
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
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        ))}
    </div>
  );
}
