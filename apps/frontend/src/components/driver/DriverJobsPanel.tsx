'use client';

import { useCallback, useEffect, useState } from 'react';
import { RefreshCcw, WifiOff } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import Link from 'next/link';
import { Button, EmptyState, Select, SyncStatusPill, toast } from '@/components/ui';
import { useSessionStore } from '@/stores/session-store';
import { toDateInput } from '@/lib/dates';
import { getMyJobs, getDrivers } from './lib/driver-api';
import { SjJobCard } from './SjJobCard';
import { loadJobs, saveJobs } from './lib/job-cache';
import { DaySummary } from './DaySummary';
import type { Drop, SuratJalan } from './lib/types';

function fmtCachedAt(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '-'
    : d.toLocaleString('id-ID', {
        hour: '2-digit',
        minute: '2-digit',
        day: 'numeric',
        month: 'short',
      });
}

/** A device cache read that has not answered in this long is treated as a miss — see `reload`. */
const CACHE_READ_TIMEOUT_MS = 3_000;

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
  // Role, not "did the list come back empty" — a driver with a genuinely quiet
  // day must still see "no Surat Jalan today", not be told this screen is not
  // for them.
  const isDriver = useSessionStore((st) => st.user?.roleKey === 'driver');
  // Owner and superadmin only. Deliberately NOT kepala gudang or manager: the
  // server enforces the same two roles, and offering a picker that silently
  // returns your own (empty) run to everyone else would be worse than not
  // offering it.
  const canPickDriver = useSessionStore(
    (st) => st.user?.roleKey === 'owner' || st.user?.roleKey === 'superadmin',
  );
  const [fleet, setFleet] = useState<{ id: string; name: string }[]>([]);
  const [viewDriverId, setViewDriverId] = useState<string | null>(null);
  /**
   * True once the fleet request has SETTLED — resolved or failed. `reload`
   * needs to tell "the picker has not answered yet" (keep the spinner) apart
   * from "the picker answered and there is nobody to show" (stop the spinner).
   * Without that distinction an owner whose fleet call fails, or whose
   * `drivers` table is empty, sat on "Memuat data…" forever: `reload` returned
   * early on every render and nothing ever set `loading` back to false.
   */
  const [fleetResolved, setFleetResolved] = useState(false);
  const [jobs, setJobs] = useState<SuratJalan[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  /** Non-null when what is on screen came from the device, not the server. */
  const [servedFromCache, setServedFromCache] = useState<string | null>(null);

  // Load the fleet once, and default to its first driver so the screen opens on
  // a real route rather than on a "choose someone" prompt — the owner's question
  // is "what is happening out there", and making them pick before answering it
  // is a step for nothing.
  useEffect(() => {
    if (!canPickDriver) return;
    let cancelled = false;
    void getDrivers()
      .then((rows) => {
        if (cancelled) return;
        // Only rows we can actually select on: an id-less row would set the
        // picker to null and strand the fetch below.
        const selectable = rows.filter((r) => !!r.id);
        setFleet(selectable);
        setViewDriverId((current) => current ?? selectable[0]?.id ?? null);
      })
      .catch(() => {
        // A missing picker is survivable; the empty state below still explains
        // why the page has nothing on it.
      })
      .finally(() => {
        if (!cancelled) setFleetResolved(true);
      });
    return () => {
      cancelled = true;
    };
  }, [canPickDriver]);

  const reload = useCallback(() => {
    const businessDate = toDateInput(new Date());
    // Nothing to fetch until the fleet has loaded: firing without a driverId
    // would return the owner's own (empty) run and flash the empty state before
    // the real route arrives.
    if (canPickDriver && !viewDriverId) {
      // Still waiting on the fleet: keep the spinner. Fleet already back and
      // still nothing to select (empty `drivers` table, or the call failed):
      // stop the spinner so the empty state below can say so.
      if (fleetResolved) setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(false);
    getMyJobs(businessDate, canPickDriver ? (viewDriverId ?? undefined) : undefined)
      .then((fresh) => {
        setJobs(fresh);
        setServedFromCache(null);
        // Cache AFTER a successful fetch only, so a failed request can never
        // overwrite a good route with an empty one.
        void saveJobs(businessDate, fresh);
      })
      .catch(async () => {
        // The network is the expected failure here, not the exceptional one.
        // Fall back to the device's own copy before declaring the day lost.
        // Raced against a timeout: a blocked IndexedDB upgrade (another tab
        // holding the old version) leaves `loadJobs` pending forever, and a
        // promise that never settles here is what turns a failed fetch into a
        // permanent "Memuat data…".
        const cached = await Promise.race([
          loadJobs(businessDate).catch(() => null),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), CACHE_READ_TIMEOUT_MS)),
        ]);
        if (cached) {
          setJobs(cached.jobs);
          setServedFromCache(cached.cachedAt);
          return;
        }
        setLoadError(true);
        toast({ title: t('table.error'), variant: 'danger' });
      })
      .finally(() => setLoading(false));
    // `viewDriverId` belongs here: changing the picker must refetch, and
    // `useEffect(reload, [reload])` below is what turns that into a reload.
  }, [t, canPickDriver, viewDriverId, fleetResolved]);

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
    (sj) =>
      OPEN_SJ_STATUSES.has(sj.status) ||
      sj.drops.some((d) => !TERMINAL_DROP_STATUSES.has(d.status)),
  );

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* AppShell already owns the single OfflineBanner for this (non-chromeless) route. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="font-display text-2xl font-semibold text-text-primary">
          {t('driver.today')}
        </h1>
        <div className="flex items-center gap-2">
          <SyncStatusPill />
          <Button
            variant="outline"
            size="sm"
            onClick={reload}
            leftIcon={<RefreshCcw className="size-4" />}
          >
            {t('common.refresh')}
          </Button>
        </div>
      </div>

      {/* Two different empty states, because they mean opposite things.
          
          `/delivery/my-jobs` resolves the caller through the `drivers` table and
          returns only THAT driver's run. For anyone without a driver record —
          owner, kepala gudang, manager — it is empty every single day, and the
          generic "no Surat Jalan today" then reads as "the warehouse dispatched
          nothing", which is usually false and sent the owner looking for a bug
          in the data twice.
          
          Say who the screen is for and point at the one that answers their
          actual question. */}
      {/* The picker sits ABOVE the route, not under it: it is the control that
          decides what the rest of the screen is showing, and an owner should
          never have to scroll past a spinner to find out whose day they are
          looking at. */}
      {canPickDriver && fleet.length > 0 && (
        <div className="flex items-center gap-2">
          <Select
            label={t('driver.picker.label')}
            value={viewDriverId ?? ''}
            onValueChange={(value) => setViewDriverId(value || null)}
            options={fleet.map((d) => ({ value: d.id, label: d.name }))}
          />
        </div>
      )}

      {loading && <EmptyState title={t('table.loading')} size="lg" />}
      {!loading && loadError && jobs.length === 0 && (
        <EmptyState title={t('table.error')} size="lg" />
      )}
      {/* A supervisor with an empty `drivers` table would otherwise get the
          driver's own "no Surat Jalan today" — which reads as "the warehouse
          dispatched nothing" when the truth is that no driver is registered. */}
      {!loading && canPickDriver && fleetResolved && fleet.length === 0 && (
        <EmptyState title={t('driver.picker.noFleet')} size="lg" />
      )}

      {/* The "this screen is not for you" state now only applies when there is
          no picker to offer — i.e. a kepala gudang or manager, who oversees
          deliveries but is not allowed to page through individual drivers. */}
      {!loading && !loadError && openJobs.length === 0 && !isDriver && !canPickDriver && (
        <EmptyState
          title={t('driver.notADriver.title')}
          description={t('driver.notADriver.description')}
          size="lg"
          action={
            <Link href="/delivery">
              <Button variant="secondary">{t('driver.notADriver.action')}</Button>
            </Link>
          }
        />
      )}
      {!loading &&
        !loadError &&
        openJobs.length === 0 &&
        (isDriver || (canPickDriver && fleet.length > 0)) && (
          <EmptyState title={t('driver.empty')} size="lg" />
        )}

      {/* Stale data is shown, but never passed off as live: a driver who does
          not know the route is a cached copy cannot know to re-check it for a
          dispatcher's amendment. */}
      {servedFromCache && (
        <div className="flex items-start gap-2 rounded-lg bg-warning-50 p-2.5 text-sm text-warning-800">
          <WifiOff className="mt-0.5 size-4 flex-none" aria-hidden />
          <div>
            <p className="font-medium">{t('driver.cache.offline')}</p>
            <p className="text-xs text-warning-700">
              {t('driver.cache.cachedAt', { time: fmtCachedAt(servedFromCache) })}
            </p>
          </div>
        </div>
      )}

      {!loading &&
        openJobs.map((sj) => <SjJobCard key={sj.id} sj={sj} onChanged={applyDropPatch} />)}

      {/* The end-of-day picture, once nothing is left to drive to. */}
      {!loading && jobs.length > 0 && openJobs.length === 0 && <DaySummary jobs={jobs} />}
    </div>
  );
}
