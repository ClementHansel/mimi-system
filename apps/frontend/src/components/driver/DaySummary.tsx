'use client';

import { CheckCircle2, AlertTriangle, XCircle, Snowflake } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui';
import { routeProgress } from './lib/route-progress';
import type { SuratJalan } from './lib/types';

/**
 * What the day actually amounted to, shown once every stop is closed out.
 *
 * Deliberately NOT a "finish run" button that flips a status. The Surat Jalan
 * already completes when its last drop does — server-side, from the drops
 * themselves — and adding a second, driver-pressed notion of "done" would
 * create two sources of truth that disagree the moment a driver forgets to
 * press it. What was missing was not a state transition; it was the driver
 * being able to SEE that the run closed cleanly, and what did not.
 *
 * Failures and discrepancies are given equal billing to successes on purpose.
 * A summary that reports "7 selesai" and quietly omits two shortfalls is worse
 * than no summary, because it invites the driver to leave without mentioning
 * them.
 */
export function DaySummary({ jobs }: { jobs: SuratJalan[] }) {
  const { t } = useI18n();

  const allDrops = jobs.flatMap((sj) => sj.drops);
  const progress = routeProgress(allDrops);
  const breaches = jobs.flatMap((sj) => sj.tempLogs.filter((l) => l.isBreach)).length;

  if (progress.total === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('driver.summary.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <Row
          icon={<CheckCircle2 className="size-4 text-success-700" aria-hidden />}
          label={t('driver.summary.delivered')}
          value={`${progress.done} / ${progress.total}`}
        />
        {progress.withDiscrepancy > 0 && (
          <Row
            icon={<AlertTriangle className="size-4 text-warning-700" aria-hidden />}
            label={t('driver.summary.discrepancy')}
            value={String(progress.withDiscrepancy)}
          />
        )}
        {progress.failed > 0 && (
          <Row
            icon={<XCircle className="size-4 text-danger-700" aria-hidden />}
            label={t('driver.summary.failed')}
            value={String(progress.failed)}
          />
        )}
        {breaches > 0 && (
          <Row
            icon={<Snowflake className="size-4 text-cold-700" aria-hidden />}
            label={t('driver.summary.coldChainBreach')}
            value={String(breaches)}
          />
        )}
        <p className="mt-1 text-xs text-text-secondary">
          {progress.failed > 0 || progress.withDiscrepancy > 0
            ? t('driver.summary.reportHint')
            : t('driver.summary.cleanHint')}
        </p>
      </CardContent>
    </Card>
  );
}

function Row({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="inline-flex items-center gap-2 text-sm text-text-secondary">
        {icon}
        {label}
      </span>
      <span className="text-sm font-semibold text-text-primary">{value}</span>
    </div>
  );
}
