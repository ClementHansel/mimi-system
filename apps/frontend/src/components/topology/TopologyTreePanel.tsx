'use client';

import { useCallback, useEffect, useState } from 'react';
import { RefreshCcw, Waypoints } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { Button, Badge, EmptyState, toast } from '@/components/ui';
import { fmtRelative } from '@/lib/dates';
import { getTopologyTree } from './lib/topology-api';
import { sortOutletsBySeverity } from './lib/rollup';
import type { TopologyTree } from './lib/types';
import { OutletCard } from './OutletCard';

/**
 * The D-13 topology tree (Pusat -> Kota -> Outlet -> Node -> Device),
 * status-rolled-up per outlet so "every device under this outlet is dark"
 * reads at a glance (§7.3's outlet-offline alert precision rule is what
 * computed `outletStatus` server-side; this just renders it, worst-first).
 *
 * Manual refresh only for this ticket's scope — CONTRACTS §7.5 wires a
 * `topology:update`/`topology:sync` socket channel for real-time push, which
 * is a reasonable follow-up once F12 has a socket client (see report).
 */
export function TopologyTreePanel() {
  const { t } = useI18n();
  const [tree, setTree] = useState<TopologyTree | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    getTopologyTree()
      .then(setTree)
      .catch(() => {
        setError(t('table.error'));
        toast({ title: t('table.error'), variant: 'danger' });
      })
      .finally(() => setLoading(false));
  }, [t]);

  useEffect(load, [load]);

  if (loading && !tree) {
    return <div className="h-40 animate-pulse rounded-lg bg-surface-sunken" />;
  }
  if (error && !tree) {
    return <EmptyState title={error} size="lg" />;
  }
  if (!tree) return null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="success" size="sm">{t('topology.totals.devicesOnline', { count: tree.totals.online })}</Badge>
          <Badge variant="warning" size="sm">{t('topology.totals.devicesStale', { count: tree.totals.stale })}</Badge>
          <Badge variant="neutral" size="sm">{t('topology.totals.devicesOffline', { count: tree.totals.offline })}</Badge>
          {tree.totals.outletsOffline > 0 && (
            <Badge variant="danger" size="sm">{t('topology.totals.outletsOffline', { count: tree.totals.outletsOffline })}</Badge>
          )}
          {tree.totals.openConflicts > 0 && (
            <Badge variant="danger" size="sm">{t('topology.totals.openConflicts', { count: tree.totals.openConflicts })}</Badge>
          )}
          {tree.totals.openExceptions > 0 && (
            <Badge variant="warning" size="sm">{t('topology.totals.openExceptions', { count: tree.totals.openExceptions })}</Badge>
          )}
        </div>
        <div className="flex items-center gap-3 text-xs text-text-muted">
          <span>{t('topology.generatedAt', { when: fmtRelative(tree.generatedAt) })}</span>
          <Button variant="secondary" size="sm" onClick={load} disabled={loading}>
            <RefreshCcw className={loading ? 'size-4 animate-spin' : 'size-4'} aria-hidden />
            {t('topology.refresh')}
          </Button>
        </div>
      </div>

      <p className="text-xs text-text-muted">{t('topology.quietNote')}</p>

      {tree.pusat && (
        <section className="flex flex-col gap-3">
          <h2 className="inline-flex items-center gap-2 font-display text-lg font-semibold text-text-primary">
            <Waypoints className="size-5" aria-hidden />
            {t('topology.pusat')}
          </h2>
          <OutletCard location={tree.pusat} />
        </section>
      )}

      {tree.cities.map((cityGroup) => (
        <section key={cityGroup.city} className="flex flex-col gap-3">
          <h2 className="flex flex-wrap items-center gap-2 font-display text-lg font-semibold text-text-primary">
            {cityGroup.city}
            <Badge variant="neutral" size="sm">{t('topology.city.outletCount', { count: cityGroup.outlets.length })}</Badge>
          </h2>
          <div className="flex flex-col gap-3">
            {sortOutletsBySeverity(cityGroup.outlets).map((loc) => (
              <OutletCard key={loc.location.id} location={loc} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
