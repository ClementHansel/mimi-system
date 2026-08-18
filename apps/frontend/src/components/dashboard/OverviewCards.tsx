import type { ReactNode } from 'react';
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { formatMoney, formatNumber, formatPercent } from '@/lib/formatters';
import type { OverviewResponse } from './lib/types';

/**
 * FR-DASH-01 top-line tiles. Every Money field renders via `formatMoney`
 * (string-safe, CONTRACTS §0) — the raw decimal strings from
 * `OverviewResponse` never pass through `Number()`/`parseFloat` here.
 *
 * `vs.revenuePct`/`vs.txPct` ARE the one exception, and deliberately so: the
 * backend (`overview.service.ts`) computes them as plain float percentages,
 * typed as a bare `string` (not `Money`) in CONTRACTS §4.18 precisely because
 * they are a display delta, not a ledger amount — `Number()` on those two
 * fields only is safe by the same reasoning the backend comment gives.
 */
export interface OverviewCardsProps {
  data: OverviewResponse | null;
  loading?: boolean;
}

function VsPill({ pct }: { pct: string }) {
  const { t } = useI18n();
  const n = Number(pct);
  const tone = n > 0 ? 'success' : n < 0 ? 'danger' : 'neutral';
  const Icon = n > 0 ? ArrowUpRight : n < 0 ? ArrowDownRight : Minus;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs font-medium',
        tone === 'success' && 'bg-success-50 text-success-700',
        tone === 'danger' && 'bg-danger-50 text-danger-700',
        tone === 'neutral' && 'bg-stone-100 text-stone-600',
      )}
      title={t('dashboard.overview.vsPreviousPeriod')}
    >
      <Icon className="size-3" aria-hidden />
      {formatPercent(Math.abs(n))}
    </span>
  );
}

function Tile({
  label,
  value,
  sub,
  loading,
}: {
  label: string;
  value: string;
  sub?: ReactNode;
  loading?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1 overflow-hidden rounded-lg border border-border bg-surface-raised p-4">
      <span className="text-sm text-text-secondary">{label}</span>
      {loading ? (
        <div className="h-7 w-24 animate-pulse rounded bg-surface-sunken" />
      ) : (
        // `whitespace-nowrap` matters specifically for a NEGATIVE Money figure
        // (`profitEstimate` can be a loss): browsers treat the leading `-` as
        // a soft line-break opportunity, so a long value at this font size
        // would otherwise wrap right after the sign — reading as a bare "-"
        // stacked over the number, which could be misread as a lost/blank
        // value rather than a large negative one. `overflow-x-auto` on the
        // tile (see wrapper) is the fallback for the rare figure too wide
        // even for this, rather than silently clipping a money value.
        <span className="overflow-x-auto whitespace-nowrap font-display text-xl font-semibold text-text-primary">
          {value}
        </span>
      )}
      {sub && !loading && <div>{sub}</div>}
    </div>
  );
}

export function OverviewCards({ data, loading }: OverviewCardsProps) {
  const { t } = useI18n();

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
      <Tile
        label={t('dashboard.overview.revenue')}
        value={formatMoney(data?.revenue)}
        sub={data && <VsPill pct={data.vs.revenuePct} />}
        loading={loading}
      />
      <Tile
        label={t('dashboard.overview.revenueOnline')}
        value={formatMoney(data?.revenueOnline)}
        loading={loading}
      />
      <Tile
        label={t('dashboard.overview.profitEstimate')}
        value={formatMoney(data?.profitEstimate)}
        loading={loading}
      />
      <Tile
        label={t('dashboard.overview.txCount')}
        value={formatNumber(data?.txCount)}
        sub={data && <VsPill pct={data.vs.txPct} />}
        loading={loading}
      />
      <Tile
        label={t('dashboard.overview.avgTicket')}
        value={formatMoney(data?.avgTicket)}
        loading={loading}
      />
      <Tile
        label={t('dashboard.overview.activeOutlets')}
        value={formatNumber(data?.activeOutlets)}
        loading={loading}
      />
    </div>
  );
}
