'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, ArrowRight, Truck, ClipboardCheck, Snowflake } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { usePermissions } from '@/lib/permissions';
import { Card, CardContent, EmptyState } from '@/components/ui';
import { WAREHOUSE_PANELS } from '@/lib/warehouse-panels';
import { dashboardApi } from '@/components/dashboard/lib/dashboard-api';
import type { OpsStatusResponse } from '@/components/dashboard/lib/types';

/**
 * Gudang Pusat's own front page.
 *
 * It used to be a title above an eight-tab strip — a container, not a page.
 * Owner, 2026-08-24: "the gudang pusat page is supposed to be dashboard of all
 * gudang." Now that each area has its own route and sidebar entry, this is free
 * to answer the question a warehouse lead actually opens the system with: what
 * needs me this morning.
 *
 * Built on `/dashboard/ops-status`, which already computes exactly these
 * counts. Reusing it rather than adding a warehouse-specific endpoint keeps ONE
 * definition of "how many approvals are pending" — two implementations of that
 * would disagree eventually, and the day they do, nobody would know which
 * screen to believe.
 *
 * Every tile links somewhere. A number a person cannot act on is decoration,
 * and decoration on an operations screen trains people to ignore it.
 */
export function WarehouseDashboard() {
  const { t } = useI18n();
  const { can } = usePermissions();
  const [status, setStatus] = useState<OpsStatusResponse | null>(null);
  const [failed, setFailed] = useState(false);

  /**
   * `/dashboard/ops-status` requires `dashboard.view`, which KEPALA GUDANG does
   * not hold — so the warehouse head, whose front page this is, got a bare
   * "Gagal memuat data" where the owner gets four live tiles, plus two 403s per
   * visit. Found 2026-09-01 by the per-role e2e walk; every owner-run test
   * passed this screen.
   *
   * Asking for something you are not allowed to have and reporting the refusal
   * as a load failure is wrong twice: the request should not be made, and "we
   * could not load this" is not what happened. So the fetch is gated on the
   * permission, and a role without it gets the tiles omitted rather than an
   * error — the rest of the page (the area cards, which ARE their work) is
   * unaffected and still renders.
   *
   * WHETHER KGD SHOULD SEE THESE NUMBERS IS A SEPARATE, OPEN QUESTION. The
   * owner's ruling that built this page ("the gudang pusat page is supposed to
   * be dashboard of all gudang") suggests yes, and every count here is already
   * `locationScope`-filtered server-side, so granting it would widen FORMAT and
   * not REACH. That is a CONTRACTS §3 change and is not made here.
   */
  const canSeeOpsStatus = can('dashboard.view');

  useEffect(() => {
    if (!canSeeOpsStatus) return;
    let cancelled = false;
    dashboardApi
      .getOpsStatus()
      .then((res) => !cancelled && setStatus(res))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [canSeeOpsStatus]);

  const tiles = [
    {
      key: 'sjInTransit',
      label: t('warehouse.dash.inTransit'),
      value: status?.sjInTransit,
      icon: Truck,
      href: '/warehouse/pengiriman',
      tone: 'text-brand-600',
    },
    {
      key: 'pendingApprovals',
      label: t('warehouse.dash.pendingApprovals'),
      value: status?.pendingApprovals,
      icon: ClipboardCheck,
      href: '/warehouse/approvals',
      // Something waiting on a person is the one number that is always someone's
      // fault if it sits, so it is coloured as a call to action rather than a fact.
      tone: (status?.pendingApprovals ?? 0) > 0 ? 'text-warning-700' : 'text-text-muted',
    },
    {
      key: 'lowStockOutlets',
      label: t('warehouse.dash.lowStock'),
      value: status?.lowStockOutlets,
      icon: AlertTriangle,
      href: '/warehouse/stock',
      tone: (status?.lowStockOutlets ?? 0) > 0 ? 'text-danger-600' : 'text-text-muted',
    },
    {
      key: 'coldChainBreaches24h',
      label: t('warehouse.dash.coldChain'),
      value: status?.coldChainBreaches24h,
      icon: Snowflake,
      href: '/warehouse/pengiriman',
      tone: (status?.coldChainBreaches24h ?? 0) > 0 ? 'text-danger-600' : 'text-text-muted',
    },
  ];

  return (
    <div className="flex flex-col gap-4 p-4">
      <h1 className="font-display text-2xl font-semibold text-text-primary">
        {t('nav.warehouse')}
      </h1>

      {!canSeeOpsStatus ? null : failed ? (
        <EmptyState title={t('table.error')} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {tiles.map((tile) => (
            <Link key={tile.key} href={tile.href}>
              <Card className="transition-colors hover:border-brand-400">
                <CardContent className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm text-text-muted">{tile.label}</p>
                    {/* An em dash while loading, not 0 — "nothing to do" and "we
                        do not know yet" must never look the same on a screen
                        someone uses to decide their morning. */}
                    <p className={`text-3xl font-semibold ${tile.tone}`}>{tile.value ?? '—'}</p>
                  </div>
                  <tile.icon className={`size-8 flex-none ${tile.tone}`} aria-hidden />
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}

      <h2 className="mt-2 font-display text-lg font-semibold text-text-primary">
        {t('warehouse.dash.areas')}
      </h2>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {WAREHOUSE_PANELS.filter((p) => can(p.permission)).map((panel) => (
          <Link key={panel.slug} href={`/warehouse/${panel.slug}`}>
            <Card className="h-full transition-colors hover:border-brand-400">
              <CardContent className="flex items-center gap-3">
                <panel.icon className="size-5 flex-none text-text-muted" aria-hidden />
                <span className="flex-1 font-medium text-text-primary">{t(panel.labelKey)}</span>
                <ArrowRight className="size-4 flex-none text-text-muted" aria-hidden />
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
