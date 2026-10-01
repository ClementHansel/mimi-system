'use client';

import { AlertTriangle, ShieldCheck } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/Button';
import type { AnomalyResponse } from './lib/anomaly-types';

export interface AnomalyStripProps {
  data: AnomalyResponse | null;
  loading: boolean;
  /** Switches the dashboard to the Anomali tab. */
  onOpen: () => void;
}

/**
 * A single line under the operational-status tiles: how many data anomalies
 * are waiting for a look, with a way into the Anomali tab. Renders nothing
 * while the first response is in flight or when it failed — the tab itself
 * carries the error; a strip that says "all clear" because it never heard back
 * would be the one lie this whole feature exists to avoid.
 */
export function AnomalyStrip({ data, loading, onOpen }: AnomalyStripProps) {
  const { t } = useI18n();
  if (loading && !data) return null;
  if (!data) return null;
  const failed = data.detectors.some((d) => d.failed);
  const open = data.openCount;
  if (open === 0 && failed) return null;
  const flagged = open > 0;
  const Icon = flagged ? AlertTriangle : ShieldCheck;
  return (
    <div
      data-testid="anomaly-strip"
      className={cn(
        'mt-3 flex items-center gap-3 rounded-lg border p-3',
        flagged ? 'border-warning-200 bg-warning-50' : 'border-border bg-surface-raised',
      )}
    >
      <Icon
        className={cn('size-5 flex-none', flagged ? 'text-warning-700' : 'text-success-600')}
        aria-hidden
      />
      <span className="flex-1 text-sm text-text-primary">
        {flagged
          ? t('dashboard.anomaly.strip.open', { count: open })
          : t('dashboard.anomaly.strip.none')}
      </span>
      {flagged && (
        <Button variant="outline" size="sm" onClick={onOpen}>
          {t('dashboard.anomaly.strip.view')}
        </Button>
      )}
    </div>
  );
}
