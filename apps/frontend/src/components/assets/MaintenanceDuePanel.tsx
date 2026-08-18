'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, CalendarClock } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { useSessionStore } from '@/stores/session-store';
import {
  Card,
  CardContent,
  Select,
  Button,
  EmptyState,
  PermissionGate,
  toast,
} from '@/components/ui';
import { fmtDate } from '@/lib/dates';
import { cn } from '@/lib/utils';
import { getMaintenanceDue, startJob, createJob } from './lib/assets-api';
import { CompleteJobModal } from './CompleteJobModal';
import type { DueItem, Job } from './lib/types';

const WINDOW_OPTIONS = [7, 14, 30, 60, 90];

/**
 * Tab 2 — due reminders (FR-PMS-02/03): the scheduler-created list of
 * what's coming due or already overdue. A `dueItem` with no `jobId` yet has
 * no job row on the server — starting it here creates the corrective/
 * scheduled job first, then immediately opens `CompleteJobModal` so a
 * technician standing in front of the asset finishes the whole thing in
 * one pass instead of two trips.
 */
export function MaintenanceDuePanel() {
  const { t } = useI18n();
  const locations = useSessionStore((s) => s.user?.locations ?? []);
  const [windowDays, setWindowDays] = useState(30);
  const [locationId, setLocationId] = useState('');
  const [rows, setRows] = useState<DueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingJob, setPendingJob] = useState<Job | null>(null);
  const [starting, setStarting] = useState<string | null>(null);

  function reload() {
    setLoading(true);
    getMaintenanceDue(windowDays, locationId || undefined)
      .then(setRows)
      .catch(() => toast({ title: t('table.error'), variant: 'danger' }))
      .finally(() => setLoading(false));
  }
  useEffect(reload, [windowDays, locationId]);

  async function handleStart(item: DueItem) {
    setStarting(item.scheduleId);
    try {
      const job = item.jobId
        ? await startJob(item.jobId)
        : await startJob((await createJob(item.assetId, item.name)).id);
      setPendingJob(job);
    } catch {
      toast({ title: t('table.error'), variant: 'danger' });
    } finally {
      setStarting(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <Select
          label={t('assets.due.windowLabel')}
          value={String(windowDays)}
          onValueChange={(v) => setWindowDays(Number(v))}
          options={WINDOW_OPTIONS.map((d) => ({
            value: String(d),
            label: t('assets.due.windowDays', { days: d }),
          }))}
          wrapperClassName="w-48"
        />
        <Select
          label={t('common.location')}
          value={locationId}
          onValueChange={setLocationId}
          options={locations.map((l) => ({ value: l.id, label: l.name }))}
          placeholder={t('common.all')}
          wrapperClassName="w-44"
        />
      </div>

      {!loading && rows.length === 0 && (
        <EmptyState icon={CalendarClock} title={t('assets.due.empty')} size="lg" />
      )}

      <div className="flex flex-col gap-3">
        {rows.map((item) => (
          <Card key={item.scheduleId} className={cn(item.overdue && 'border-danger-600/40')}>
            <CardContent className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-medium text-text-primary">
                  {item.name} — {item.assetName}
                </p>
                <p className="text-sm text-text-muted">{item.locationName}</p>
                <p
                  className={cn(
                    'mt-1 inline-flex items-center gap-1 text-sm',
                    item.overdue ? 'font-medium text-danger-600' : 'text-text-secondary',
                  )}
                >
                  {item.overdue && <AlertTriangle className="size-4" aria-hidden />}
                  {t('assets.due.dueDate')}: {fmtDate(item.dueDate)}
                </p>
              </div>
              <PermissionGate permission="asset.job.execute">
                <Button
                  size="touch"
                  loading={starting === item.scheduleId}
                  onClick={() => handleStart(item)}
                >
                  {t('assets.due.startButton')}
                </Button>
              </PermissionGate>
            </CardContent>
          </Card>
        ))}
      </div>

      {pendingJob && (
        <CompleteJobModal
          job={pendingJob}
          onClose={() => setPendingJob(null)}
          onDone={() => {
            setPendingJob(null);
            reload();
          }}
        />
      )}
    </div>
  );
}
