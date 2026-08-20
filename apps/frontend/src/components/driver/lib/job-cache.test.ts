import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryDatabase } from '@/lib/local/store/memory-database';
import { STORE_KEY_PATH } from '@/lib/local/types';
import type { SuratJalan } from './types';

const db = createMemoryDatabase(STORE_KEY_PATH);

// `job-cache` reaches the database through the browser runtime singleton,
// which needs a real IndexedDB. Swapping just that boundary keeps the test on
// the module's actual logic (eviction, tolerance of a broken write) instead of
// on `idb`.
vi.mock('./driver-runtime', () => ({
  getDriverRuntime: () => Promise.resolve({ db }),
}));

const { loadJobs, saveJobs } = await import('./job-cache');

function sj(id: string): SuratJalan {
  return { id, sjNumber: `SJ-${id}`, drops: [] } as unknown as SuratJalan;
}

describe('driver job cache', () => {
  beforeEach(async () => {
    await db.runTransaction(['driver_jobs'], 'readwrite', async (tx) => {
      const store = tx.store<{ key: string }>('driver_jobs');
      for (const r of await store.getAll()) await store.delete(r.key);
    });
  });

  it('round-trips a day, which is what makes a reload with no signal survivable', async () => {
    await saveJobs('2026-08-20', [sj('a'), sj('b')]);
    const cached = await loadJobs('2026-08-20');
    expect(cached?.jobs.map((j) => j.id)).toEqual(['a', 'b']);
    expect(cached?.cachedAt).toBeTruthy();
  });

  it('keeps days apart — loading a date never returns another date’s route', async () => {
    await saveJobs('2026-08-19', [sj('yesterday')]);
    await saveJobs('2026-08-20', [sj('today')]);
    expect((await loadJobs('2026-08-19'))?.jobs.map((j) => j.id)).toEqual(['yesterday']);
    expect((await loadJobs('2026-08-20'))?.jobs.map((j) => j.id)).toEqual(['today']);
  });

  it('returns null for a day never cached, rather than an empty route', async () => {
    // The distinction matters: `null` means "unknown, show the error", while
    // `[]` would mean "the dispatcher gave you no work today".
    expect(await loadJobs('2026-01-01')).toBeNull();
  });

  it('evicts the oldest days so months of runs cannot grow without bound', async () => {
    for (const d of ['01', '02', '03', '04', '05', '06', '07']) {
      await saveJobs(`2026-08-${d}`, [sj(d)]);
    }
    expect(await loadJobs('2026-08-01')).toBeNull();
    expect(await loadJobs('2026-08-02')).toBeNull();
    expect((await loadJobs('2026-08-07'))?.jobs).toHaveLength(1);
    expect((await loadJobs('2026-08-03'))?.jobs).toHaveLength(1);
  });

  it('a storage failure is swallowed, because losing the cache must not break the screen', async () => {
    const broken = {
      db: {
        runTransaction: () => Promise.reject(new Error('QuotaExceededError')),
      },
    };
    const mod = await import('./driver-runtime');
    const spy = vi
      .spyOn(mod, 'getDriverRuntime')
      .mockResolvedValue(broken.db as unknown as Awaited<ReturnType<typeof mod.getDriverRuntime>>);
    await expect(saveJobs('2026-08-20', [sj('a')])).resolves.toBeUndefined();
    await expect(loadJobs('2026-08-20')).resolves.toBeNull();
    spy.mockRestore();
  });
});
