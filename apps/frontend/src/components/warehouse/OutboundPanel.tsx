'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Route, ArrowRight, Truck, PackageCheck } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { Card, CardContent, StatusBadge, EmptyState, Button } from '@/components/ui';
import { fmtDate } from '@/lib/dates';
import { SuratJalanStatus } from '@/lib/shared-types';
import { listSuratJalan } from './lib/warehouse-api';
import type { SuratJalan } from './lib/types';
import { errMsg } from '@/lib/api-error';

const STAGED = new Set<string>([
  SuratJalanStatus.DRAFT,
  SuratJalanStatus.READY,
  SuratJalanStatus.LOADING,
]);
const IN_TRANSIT = new Set<string>([SuratJalanStatus.IN_TRANSIT]);

/**
 * F-WAREHOUSE / F-DELIVERY: outbound is now a SINGLE surface. The full
 * Surat Jalan lifecycle (multi-drop create, driver/vehicle assignment,
 * ready → load → dispatch, cold-chain view, route-completion rollup) lives
 * at `/delivery` (`components/delivery/**`) — that surface reuses this
 * one's `SjCreateForm` directly rather than reimplementing it, so a second
 * create/manage UI here would just be two places doing the same job. This
 * panel is READ-ONLY: a compact "what's staged / already on the road" count
 * plus a pointer through to `/delivery` for anything beyond a glance,
 * exactly the shape the ticket asked for ("link to it, do not duplicate
 * it"). `components/delivery/**` is out of bounds from this side — do not
 * edit it, and nothing here imports from it.
 */
export function OutboundPanel() {
  const { t } = useI18n();
  const [rows, setRows] = useState<SuratJalan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    listSuratJalan()
      .then((res) => !cancelled && setRows(res.rows))
      .catch((err: unknown) => !cancelled && setError(errMsg(err, t('table.error'))))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [t, reloadToken]);

  const active = rows.filter((r) => STAGED.has(r.status) || IN_TRANSIT.has(r.status));
  const stagedCount = active.filter((r) => STAGED.has(r.status)).length;
  const inTransitCount = active.filter((r) => IN_TRANSIT.has(r.status)).length;

  return (
    <div className="flex flex-col gap-4">
      <Card className="border-brand-600/30 bg-brand-50/40">
        <CardContent className="flex flex-col items-start gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <Route className="mt-0.5 size-5 flex-none text-brand-600" aria-hidden />
            <div>
              <p className="font-medium text-text-primary">{t('warehouse.outbound.movedTitle')}</p>
              <p className="text-sm text-text-secondary">
                {t('warehouse.outbound.movedDescription')}
              </p>
            </div>
          </div>
          <Link
            href="/delivery"
            className="inline-flex h-10 flex-none items-center justify-center gap-2 whitespace-nowrap rounded-md bg-brand-500 px-4 text-sm font-medium text-white transition-colors hover:bg-brand-600"
          >
            {t('warehouse.outbound.openDelivery')}
            <ArrowRight className="size-4" aria-hidden />
          </Link>
        </CardContent>
      </Card>

      {error && (
        <EmptyState
          title={error}
          size="sm"
          action={
            <Button variant="outline" size="sm" onClick={() => setReloadToken((n) => n + 1)}>
              {t('common.retry')}
            </Button>
          }
        />
      )}

      {!error && loading && <EmptyState title={t('table.loading')} size="lg" />}

      {!error && !loading && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Card>
              <CardContent className="flex items-center gap-3 p-4">
                <PackageCheck className="size-6 text-brand-600" aria-hidden />
                <div>
                  <p className="text-2xl font-semibold text-text-primary tabular-nums">
                    {stagedCount}
                  </p>
                  <p className="text-sm text-text-muted">{t('warehouse.outbound.staged')}</p>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="flex items-center gap-3 p-4">
                <Truck className="size-6 text-brand-600" aria-hidden />
                <div>
                  <p className="text-2xl font-semibold text-text-primary tabular-nums">
                    {inTransitCount}
                  </p>
                  <p className="text-sm text-text-muted">{t('warehouse.outbound.inTransit')}</p>
                </div>
              </CardContent>
            </Card>
          </div>

          {active.length === 0 && <EmptyState title={t('warehouse.outbound.empty')} size="lg" />}

          {active.length > 0 && (
            <Card>
              <CardContent className="overflow-x-auto p-0">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-border bg-surface-sunken text-left text-text-secondary">
                      <th className="px-4 py-2">{t('warehouse.sj.number')}</th>
                      <th className="px-4 py-2">{t('warehouse.sj.driver')}</th>
                      <th className="px-4 py-2">{t('warehouse.sj.vehicle')}</th>
                      <th className="px-4 py-2 text-right">{t('warehouse.sj.dropsCount')}</th>
                      <th className="px-4 py-2">{t('warehouse.sj.plannedDate')}</th>
                      <th className="px-4 py-2">{t('common.status')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {active.map((r) => (
                      <tr key={r.id} className="border-b border-border last:border-0">
                        <td className="px-4 py-2.5 font-medium text-text-primary">{r.sjNumber}</td>
                        <td className="px-4 py-2.5">{r.driver.name}</td>
                        <td className="px-4 py-2.5">{r.vehicle.plateNumber}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums">{r.drops.length}</td>
                        <td className="px-4 py-2.5">{fmtDate(r.plannedDate)}</td>
                        <td className="px-4 py-2.5">
                          <StatusBadge domain="suratJalan" status={r.status} size="sm" />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}

          <div className="flex justify-end">
            <Link href="/delivery" className="text-sm font-medium text-brand-600 hover:underline">
              {t('warehouse.outbound.viewAll')}
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
