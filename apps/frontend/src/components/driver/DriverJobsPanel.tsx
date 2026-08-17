'use client';

import { useCallback, useEffect, useState } from 'react';
import { RefreshCcw } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { Button, EmptyState, SyncStatusPill, toast } from '@/components/ui';
import { toDateInput } from '@/lib/dates';
import { getMyJobs } from './lib/driver-api';
import { SjJobCard } from './SjJobCard';
import type { Drop, SuratJalan } from './lib/types';

const OPEN_SJ_STATUSES = new Set(['ready', 'loading', 'in_transit']);
const TERMINAL_DROP_STATUSES = new Set(['completed', 'completed_discrepancy', 'failed']);

/**
 * F13 `driver` — the whole surface. `GET /delivery/my-jobs` is a plain
 * online read (the "F13 pre-departure cache", CONTRACTS §4.10) fetched once
 * when the screen loads; every action a driver takes on a job after that —
 * depart, arrive, serah terima, temperature log — commits through the
 * offline outbox (`driver-runtime.ts`), so the route survives a signal drop
 * between Balikpapan and the next city.
 *
 * After a commit, this panel patches its OWN in-memory job state
 * (`applyDropPatch`) rather than refetching — a refetch is exactly the
 * network call that may not be available right after the driver just
 * queued an action offline, and re-showing the pre-commit status would
 * silently undo the UI's own progress. A manual "Muat Ulang" button is
 * still offered for when connectivity returns and the driver wants the
 * server's authoritative view (e.g. a dispatcher amended the route).
 *
 * Same scope note `ReceivingPanel.tsx` (F04) already flags for its own list
 * read: this device has no local cache of "my jobs" surviving a hard reload
 * while offline — the SJ list must have been fetched at least once (e.g.
 * over depot WiFi before departure) and stays in this component's React
 * state for the rest of the session. A true "SJ never seen by this device"
 * blind-entry path (SYNC-PROTOCOL §8 row 6) is a separate, larger feature
 * than this ticket's ask and is flagged as a follow-up, not attempted here.
 */
export function DriverJobsPanel() {
  const { t } = useI18n();
  const [jobs, setJobs] = useState<SuratJalan[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const reload = useCallback(() => {
    setLoading(true);
    setLoadError(false);
    getMyJobs(toDateInput(new Date()))
      .then(setJobs)
      .catch(() => {
        setLoadError(true);
        toast({ title: t('table.error'), variant: 'danger' });
      })
      .finally(() => setLoading(false));
  }, [t]);

  useEffect(reload, [reload]);

  function applyDropPatch(dropId: string, patch: Partial<Drop>) {
    setJobs((prev) =>
      prev.map((sj) => ({
        ...sj,
        drops: sj.drops.map((d) => (d.id === dropId ? { ...d, ...patch } : d)),
      })),
    );
  }

  const openJobs = jobs.filter(
    (sj) => OPEN_SJ_STATUSES.has(sj.status) || sj.drops.some((d) => !TERMINAL_DROP_STATUSES.has(d.status)),
  );

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* AppShell already owns the single OfflineBanner for this (non-chromeless) route. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="font-display text-2xl font-semibold text-text-primary">{t('driver.today')}</h1>
        <div className="flex items-center gap-2">
          <SyncStatusPill />
          <Button variant="outline" size="sm" onClick={reload} leftIcon={<RefreshCcw className="size-4" />}>
            {t('common.refresh')}
          </Button>
        </div>
      </div>

      {loading && <EmptyState title={t('table.loading')} size="lg" />}
      {!loading && loadError && jobs.length === 0 && <EmptyState title={t('table.error')} size="lg" />}
      {!loading && !loadError && openJobs.length === 0 && <EmptyState title={t('driver.empty')} size="lg" />}

      {!loading && openJobs.map((sj) => <SjJobCard key={sj.id} sj={sj} onChanged={applyDropPatch} />)}
    </div>
  );
}
