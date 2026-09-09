import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api } from '@/lib/api';
import { loadAllEmployeesForPicker } from './hr-api';

/**
 * A PICKER OFFERS EVERY EMPLOYEE, NOT THE FIRST PAGE OF THEM.
 *
 * `listEmployees` is a paginated table read — `pageSize=50`, `ORDER BY name` —
 * and the contract form fed a `<Select>` straight from `{ page: 1 }`. With 295
 * employees on production that offered the alphabetically-first 50 and silently
 * dropped the rest, so a newly added person was simply absent from the picker
 * unless their name happened to sort early (MA-187, reported by the client as
 * "pegawai yang baru ditambahkan tidak tampil saat membuat kontrak baru").
 *
 * The same defect had already been found and fixed once, with an inline page
 * walk in `SalaryComponentsPanel`. The contract picker was missed — which is the
 * whole argument for the walk living in one shared function, and for this test
 * guarding that function rather than either screen.
 */
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, get: vi.fn() } };
});

/** A server holding `total` employees and honouring page/pageSize. */
function pagedEmployees(total: number) {
  return (path: string) => {
    const qs = new URLSearchParams(path.split('?')[1] ?? '');
    const page = Number(qs.get('page') ?? '1');
    const pageSize = Number(qs.get('pageSize') ?? '50');
    const all = Array.from({ length: total }, (_, i) => ({
      id: `emp-${i + 1}`,
      // Zero-padded so alphabetical order matches creation order and "the last
      // one added" is unambiguous.
      name: `Employee ${String(i + 1).padStart(4, '0')}`,
      employeeNumber: `EMP${String(i + 1).padStart(4, '0')}`,
    }));
    return Promise.resolve({
      rows: all.slice((page - 1) * pageSize, page * pageSize),
      total,
      page,
      pageSize,
    });
  };
}

describe('loadAllEmployeesForPicker', () => {
  beforeEach(() => {
    vi.mocked(api.get).mockReset();
  });

  it('walks past the first page so a late-sorting employee is still offered', async () => {
    vi.mocked(api.get).mockImplementation(pagedEmployees(295) as never);

    const all = await loadAllEmployeesForPicker();

    expect(all).toHaveLength(295);
    // The one the client could not find: 295th by name, six pages in.
    expect(all.map((e) => e.employeeNumber)).toContain('EMP0295');
    expect(vi.mocked(api.get).mock.calls.length).toBeGreaterThan(1);
  });

  it('stops as soon as it has them all, rather than walking its whole bound', async () => {
    vi.mocked(api.get).mockImplementation(pagedEmployees(12) as never);

    const all = await loadAllEmployeesForPicker();

    expect(all).toHaveLength(12);
    // One short page is the end — no reason for a second request.
    expect(vi.mocked(api.get)).toHaveBeenCalledTimes(1);
  });

  it('is bounded, so a server that ignores `page` cannot spin it forever', async () => {
    // Every request answers with the same full page and an enormous total —
    // exactly what a server that drops the `page` parameter would do.
    vi.mocked(api.get).mockResolvedValue({
      rows: Array.from({ length: 50 }, (_, i) => ({
        id: `emp-${i}`,
        name: `Employee ${i}`,
        employeeNumber: `EMP${i}`,
      })),
      total: 1_000_000,
      page: 1,
      pageSize: 50,
    } as never);

    const all = await loadAllEmployeesForPicker();

    expect(vi.mocked(api.get).mock.calls.length).toBeLessThanOrEqual(40);
    expect(all.length).toBeLessThanOrEqual(40 * 50);
  });

  it('returns what it has when a page fails, instead of throwing the picker away', async () => {
    let call = 0;
    vi.mocked(api.get).mockImplementation((() => {
      call += 1;
      if (call === 1) {
        return Promise.resolve({
          rows: Array.from({ length: 50 }, (_, i) => ({
            id: `emp-${i}`,
            name: `Employee ${i}`,
            employeeNumber: `EMP${i}`,
          })),
          total: 200,
          page: 1,
          pageSize: 50,
        });
      }
      return Promise.reject(new Error('boom'));
    }) as never);

    // A half-full picker beats an empty one: the caller's `.catch` would
    // otherwise blank the whole list because page 2 of 4 failed.
    const all = await loadAllEmployeesForPicker();
    expect(all).toHaveLength(50);
  });
});
