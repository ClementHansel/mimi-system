'use client';

import { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  SlidersHorizontal,
} from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { errMsg } from '@/lib/api-error';
import { cn } from '@/lib/utils';
import { formatNumber } from '@/lib/formatters';
import { useSessionStore } from '@/stores/session-store';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { EmptyState } from '@/components/ui/EmptyState';
import { toast } from '@/components/ui/Toast';
import type { ISODate } from '@/lib/shared-types';
import { dashboardApi } from './lib/dashboard-api';
import {
  detailKey,
  detailParams,
  formatDrillCell,
  formatMeasure,
  severityVariant,
} from './lib/anomaly-format';
import type {
  AnomalyDetectorKey,
  AnomalyDetectorResult,
  AnomalyItem,
  AnomalyResponse,
  DrillResult,
} from './lib/anomaly-types';
import { AnomalyThresholdsDialog } from './AnomalyThresholdsDialog';

/** Roles that may change the thresholds — mirrors the server's own check (`THRESHOLD_ROLES`); the server is what enforces it. */
const THRESHOLD_ROLES = new Set(['owner', 'superadmin']);

export interface AnomalyPanelProps {
  from: ISODate;
  to: ISODate;
  data: AnomalyResponse | null;
  loading: boolean;
  error?: string;
  showReviewed: boolean;
  onShowReviewedChange: (show: boolean) => void;
  /** After a review or a threshold change: re-fetch. */
  onChanged: () => void;
}

/**
 * "Anomali" — data the owner's spreadsheets never flagged: a day of revenue
 * 30x the outlet's norm, a product selling 1,394 where it normally sells ~0,
 * a recipe that used 48x what the count says, a till whose cash never leaves.
 * Seven detectors, each with a configurable threshold, over the dashboard's
 * date range.
 *
 * The panel owns no data fetching of its own (the shell does, so the tab's
 * badge reads the same response); it owns what to expand, which finding's
 * rows are open, and the two actions — mark reviewed, and the owner's
 * thresholds.
 */
export function AnomalyPanel({
  from,
  to,
  data,
  loading,
  error,
  showReviewed,
  onShowReviewedChange,
  onChanged,
}: AnomalyPanelProps) {
  const { t } = useI18n();
  const roleKey = useSessionStore((s) => s.user?.roleKey);
  const canEditThresholds = roleKey !== undefined && THRESHOLD_ROLES.has(roleKey);
  const [open, setOpen] = useState<Partial<Record<AnomalyDetectorKey, boolean>>>({});
  const [thresholdsOpen, setThresholdsOpen] = useState(false);

  const detectors = data?.detectors ?? [];
  const firstWithItems = detectors.find((d) => d.items.length > 0)?.key;
  const isOpen = (key: AnomalyDetectorKey) => open[key] ?? key === firstWithItems;
  const toggle = (key: AnomalyDetectorKey) => setOpen((o) => ({ ...o, [key]: !isOpen(key) }));
  const reveal = (key: AnomalyDetectorKey) => {
    setOpen((o) => ({ ...o, [key]: true }));
    document.getElementById(`anomaly-section-${key}`)?.scrollIntoView?.({ behavior: 'smooth' });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-display text-lg font-semibold text-text-primary">
            {t('dashboard.anomaly.title')}
          </h3>
          <p className="text-sm text-text-secondary">{t('dashboard.anomaly.description')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Checkbox
            label={t('dashboard.anomaly.showReviewed')}
            checked={showReviewed}
            onCheckedChange={onShowReviewedChange}
          />
          {canEditThresholds && (
            <Button
              variant="outline"
              size="sm"
              leftIcon={<SlidersHorizontal className="size-4" />}
              onClick={() => setThresholdsOpen(true)}
            >
              {t('dashboard.anomaly.thresholds.open')}
            </Button>
          )}
        </div>
      </div>

      {error && (
        <p role="alert" className="text-sm text-danger-600">
          {error}
        </p>
      )}

      <SummaryRow detectors={detectors} loading={loading && !data} onPick={reveal} />

      {loading && !data && <p className="text-sm text-text-secondary">{t('table.loading')}</p>}

      {data && data.openCount === 0 && !showReviewed && !detectors.some((d) => d.failed) && (
        <EmptyState
          icon={CheckCircle2}
          title={t('dashboard.anomaly.noneOpen')}
          description={t('dashboard.anomaly.noneOpenHint', { from, to })}
        />
      )}

      <div className="flex flex-col gap-3">
        {detectors.map((d) => (
          <DetectorSection
            key={d.key}
            detector={d}
            from={from}
            to={to}
            expanded={isOpen(d.key)}
            onToggle={() => toggle(d.key)}
            onChanged={onChanged}
          />
        ))}
      </div>

      {canEditThresholds && (
        <AnomalyThresholdsDialog
          open={thresholdsOpen}
          onClose={() => setThresholdsOpen(false)}
          onSaved={onChanged}
        />
      )}
    </div>
  );
}

function SummaryRow({
  detectors,
  loading,
  onPick,
}: {
  detectors: AnomalyDetectorResult[];
  loading: boolean;
  onPick: (key: AnomalyDetectorKey) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
      {detectors.map((d) => {
        const flagged = d.count > 0;
        return (
          <button
            key={d.key}
            type="button"
            onClick={() => onPick(d.key)}
            data-testid={`anomaly-summary-${d.key}`}
            className={cn(
              'flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors',
              d.failed
                ? 'border-danger-200 bg-danger-50'
                : flagged
                  ? 'border-warning-200 bg-warning-50 hover:bg-warning-100'
                  : 'border-border bg-surface-raised hover:bg-stone-50',
            )}
          >
            {loading ? (
              <span className="h-6 w-8 animate-pulse rounded bg-surface-sunken" />
            ) : (
              <span
                className={cn(
                  'font-display text-2xl font-semibold',
                  d.failed ? 'text-danger-700' : flagged ? 'text-warning-800' : 'text-text-primary',
                )}
              >
                {d.failed ? '!' : formatNumber(d.count)}
              </span>
            )}
            <span className="text-xs text-text-secondary">
              {t(`dashboard.anomaly.detectors.${d.key}.label`)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function DetectorSection({
  detector,
  from,
  to,
  expanded,
  onToggle,
  onChanged,
}: {
  detector: AnomalyDetectorResult;
  from: ISODate;
  to: ISODate;
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <section
      id={`anomaly-section-${detector.key}`}
      className="rounded-lg border border-border bg-surface-raised"
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-center gap-3 p-3 text-left"
      >
        <Chevron className="size-4 flex-none text-text-muted" aria-hidden />
        <span className="flex flex-1 flex-col">
          <span className="font-medium text-text-primary">
            {t(`dashboard.anomaly.detectors.${detector.key}.label`)}
          </span>
          <span className="text-xs text-text-secondary">
            {t(`dashboard.anomaly.detectors.${detector.key}.hint`)}
          </span>
        </span>
        {detector.failed ? (
          <Badge variant="danger">{t('dashboard.anomaly.failedBadge')}</Badge>
        ) : (
          <Badge variant={detector.count > 0 ? 'warning' : 'neutral'}>
            {t('dashboard.anomaly.countBadge', { count: formatNumber(detector.count) })}
          </Badge>
        )}
      </button>

      {expanded && (
        <div className="flex flex-col gap-2 border-t border-border p-3">
          {detector.failed && (
            <p className="text-sm text-danger-600">{t('dashboard.anomaly.failed')}</p>
          )}
          {detector.notice && (
            <p className="rounded bg-info-50 p-2 text-sm text-info-700">
              {t(`dashboard.anomaly.notice.${detector.notice}`)}
            </p>
          )}
          {!detector.failed && !detector.notice && detector.items.length === 0 && (
            <p className="text-sm text-text-secondary">{t('dashboard.anomaly.sectionEmpty')}</p>
          )}
          {detector.items.map((item) => (
            <AnomalyRow
              key={item.fingerprint}
              detector={detector.key}
              item={item}
              from={from}
              to={to}
              onChanged={onChanged}
            />
          ))}
          {detector.truncated && (
            <p className="text-xs text-text-muted">
              {t('dashboard.anomaly.truncated', {
                shown: formatNumber(detector.items.length),
                total: formatNumber(detector.total),
              })}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function AnomalyRow({
  detector,
  item,
  from,
  to,
  onChanged,
}: {
  detector: AnomalyDetectorKey;
  item: AnomalyItem;
  from: ISODate;
  to: ISODate;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [rowsOpen, setRowsOpen] = useState(false);
  const [drill, setDrill] = useState<DrillResult | null>(null);
  const [drillError, setDrillError] = useState<string | undefined>();
  const [drillLoading, setDrillLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  async function toggleRows() {
    const next = !rowsOpen;
    setRowsOpen(next);
    if (next && !drill) {
      setDrillLoading(true);
      setDrillError(undefined);
      try {
        setDrill(await dashboardApi.getAnomalyDrilldown(detector, from, to, item.ref));
      } catch (err) {
        setDrillError(errMsg(err, t('table.error')));
      } finally {
        setDrillLoading(false);
      }
    }
  }

  async function setReviewed(reviewed: boolean) {
    setBusy(true);
    try {
      await dashboardApi.reviewAnomaly({
        detector,
        fingerprint: item.fingerprint,
        locationId: item.locationId,
        reviewed,
      });
      toast({
        title: t(
          reviewed ? 'dashboard.anomaly.reviewedToast' : 'dashboard.anomaly.unreviewedToast',
        ),
        variant: 'success',
      });
      onChanged();
    } catch (err) {
      toast({ title: errMsg(err, t('dashboard.anomaly.reviewFailed')), variant: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  const when =
    item.date ?? (item.period ? `${item.period.from ?? '…'} – ${item.period.to ?? '…'}` : null);

  return (
    <article
      data-testid="anomaly-item"
      className={cn(
        'flex flex-col gap-2 rounded-md border p-3',
        item.reviewed ? 'border-border bg-surface-sunken opacity-80' : 'border-border',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={severityVariant(item.severity)} size="sm">
          <AlertTriangle className="size-3" aria-hidden />
          {t(`dashboard.anomaly.severity.${item.severity}`)}
        </Badge>
        <span className="font-medium text-text-primary">
          {item.locationName ?? t('dashboard.anomaly.companyLevel')}
        </span>
        {when && <span className="text-sm text-text-secondary">{when}</span>}
        {item.reviewed && (
          <Badge variant="success" size="sm">
            {t('dashboard.anomaly.reviewedBadge')}
          </Badge>
        )}
      </div>

      <dl className="grid grid-cols-3 gap-2 text-sm">
        <div>
          <dt className="text-xs text-text-muted">{t('dashboard.anomaly.metricLabel')}</dt>
          <dd className="text-text-primary">{t(`dashboard.anomaly.metric.${item.metric}`)}</dd>
        </div>
        <div>
          <dt className="text-xs text-text-muted">{t('dashboard.anomaly.expected')}</dt>
          <dd className="text-text-primary">{formatMeasure(item, item.expected)}</dd>
        </div>
        <div>
          <dt className="text-xs text-text-muted">{t('dashboard.anomaly.actual')}</dt>
          <dd className="font-medium text-text-primary">
            {formatMeasure(item, item.actual)}
            {item.ratio !== null && (
              <span className="ml-1 text-xs text-text-muted">
                {t('dashboard.anomaly.ratio', { ratio: formatNumber(item.ratio, 2) })}
              </span>
            )}
          </dd>
        </div>
      </dl>

      <p className="text-sm text-text-secondary">{t(detailKey(item), detailParams(item))}</p>

      {item.reviewed && (
        <p className="text-xs text-text-muted">
          {t('dashboard.anomaly.reviewedBy', {
            name: item.reviewedByName ?? '—',
            at: item.reviewedAt ? new Date(item.reviewedAt).toLocaleDateString('id-ID') : '—',
          })}
          {item.reviewNote ? ` — ${item.reviewNote}` : ''}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={toggleRows} aria-expanded={rowsOpen}>
          {rowsOpen ? t('dashboard.anomaly.hideRows') : t('dashboard.anomaly.showRows')}
        </Button>
        {item.reviewed ? (
          <Button variant="ghost" size="sm" loading={busy} onClick={() => setReviewed(false)}>
            {t('dashboard.anomaly.unreview')}
          </Button>
        ) : (
          <Button size="sm" loading={busy} onClick={() => setReviewed(true)}>
            {t('dashboard.anomaly.review')}
          </Button>
        )}
        {item.link && (
          <a className="text-sm text-brand-600 hover:underline" href={item.link}>
            {t('dashboard.anomaly.openRecord')}
          </a>
        )}
      </div>

      {rowsOpen && (
        <div className="overflow-x-auto rounded border border-border">
          {drillLoading && <p className="p-2 text-sm text-text-secondary">{t('table.loading')}</p>}
          {drillError && <p className="p-2 text-sm text-danger-600">{drillError}</p>}
          {drill && drill.rows.length === 0 && (
            <p className="p-2 text-sm text-text-secondary">{t('dashboard.anomaly.noRows')}</p>
          )}
          {drill && drill.rows.length > 0 && (
            <table className="w-full text-sm">
              <thead className="bg-surface-sunken text-left text-xs text-text-muted">
                <tr>
                  {drill.columns.map((c) => (
                    <th
                      key={c.key}
                      className={cn(
                        'px-2 py-1 font-medium',
                        (c.type === 'money' || c.type === 'qty') && 'text-right',
                      )}
                    >
                      {t(`dashboard.anomaly.cols.${c.key}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {drill.rows.map((row, i) => (
                  <tr key={i} className="border-t border-border">
                    {drill.columns.map((c) => (
                      <td
                        key={c.key}
                        className={cn(
                          'px-2 py-1',
                          (c.type === 'money' || c.type === 'qty') && 'text-right tabular-nums',
                        )}
                      >
                        {formatDrillCell(c, row[c.key] ?? null)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </article>
  );
}
