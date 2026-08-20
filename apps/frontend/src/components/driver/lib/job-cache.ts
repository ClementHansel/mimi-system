'use client';

import type { DriverJobsRecord } from '@/lib/local/types';
import { getDriverRuntime } from './driver-runtime';
import type { SuratJalan } from './types';

/**
 * Keeps the day's route on the device.
 *
 * Before this, `GET /delivery/my-jobs` was fetched once into React state and
 * nowhere else — `DriverJobsPanel`'s own doc comment admitted it: a hard
 * reload with no signal lost the whole day's route, and the driver's only
 * recovery was to find coverage. On the Balikpapan–Samarinda run that is a
 * long way to drive back.
 *
 * The cache is a READ fallback only. It never competes with the offline
 * outbox, which remains the authority for actions the driver has taken: a
 * queued depart/arrive/serah-terima lives in the outbox and is replayed from
 * there. This store answers a narrower question — "what stops was I given
 * today" — which is otherwise unrecoverable offline.
 *
 * Stale data is preferred to no data, and is labelled rather than hidden: the
 * panel shows when the cached copy was taken so a driver can judge whether the
 * dispatcher may have amended the route since.
 */

/** Keep a few days rather than one: a run that crosses midnight WITA, or a driver reopening yesterday to check what was signed for, both break with a single-slot cache. */
const KEEP_DAYS = 5;

export async function saveJobs(businessDate: string, jobs: SuratJalan[]): Promise<void> {
  try {
    const runtime = await getDriverRuntime();
    await runtime.db.runTransaction(['driver_jobs'], 'readwrite', async (tx) => {
      const store = tx.store<DriverJobsRecord>('driver_jobs');
      await store.put({ key: businessDate, jobs, cachedAt: new Date().toISOString() });

      // Evict oldest by date key. Not a size cap: a route is small, and the
      // real risk is unbounded growth over months of runs, not one big day.
      const all = await store.getAll();
      if (all.length > KEEP_DAYS) {
        const doomed = all
          .map((r) => r.key)
          .sort()
          .slice(0, all.length - KEEP_DAYS);
        for (const key of doomed) await store.delete(key);
      }
    });
  } catch {
    // A failed cache write must never break the screen: the driver still has
    // the jobs in memory, which is exactly the state we were in before this
    // cache existed. Storage-full is the realistic cause and it is survivable.
  }
}

export interface CachedJobs {
  jobs: SuratJalan[];
  cachedAt: string;
}

export async function loadJobs(businessDate: string): Promise<CachedJobs | null> {
  try {
    const runtime = await getDriverRuntime();
    const record = await runtime.db.runTransaction(['driver_jobs'], 'readonly', (tx) =>
      tx.store<DriverJobsRecord>('driver_jobs').get(businessDate),
    );
    if (!record || !Array.isArray(record.jobs)) return null;
    return { jobs: record.jobs as SuratJalan[], cachedAt: record.cachedAt };
  } catch {
    return null;
  }
}
