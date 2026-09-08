import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api } from '@/lib/api';
import type { Replenishment } from './types';
import { listApprovedRequests } from './delivery-api';

/**
 * The Surat Jalan picker's request source, and the two ways it used to lose
 * the request a dispatcher had just approved.
 *
 * 1. IT ASKED FOR ONE PAGE OF FIFTY, OLDEST FIRST. `listApprovedRequests` sent
 *    no `page`/`pageSize`, so `GET /replenishment/queue/warehouse` applied its
 *    own defaults — page 1, `pageSize` 50, `ORDER BY submitted_at ASC NULLS
 *    LAST`. That order is correct for the queue the endpoint was written for
 *    (Gudang's approval list is FIFO work) and exactly wrong here: a request
 *    leaves `approved`/`processing` only when its Surat Jalan is dispatched, so
 *    the open set is a growing backlog, and the first time it passed fifty rows
 *    the NEWEST request — the one just approved, the only one anybody is
 *    looking for — sorted past the cut and never appeared. "We approved it and
 *    there is no way to create the SJ, the list is gone."
 * 2. IT ASKED ONLY FOR `approved`. Pressing "Mulai Pemrosesan" moved a request
 *    to `processing` and out of the picker (fixed 2026-09-08; kept asserted
 *    here so the pair cannot regress independently).
 */
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, get: vi.fn() } };
});

function requestAt(n: number, status: string): Replenishment {
  return {
    id: `req-${status}-${n}`,
    requestNumber: `RR/202609/${String(n).padStart(4, '0')}`,
    locationId: 'loc-1',
    locationName: 'Outlet Kemang',
    status,
    source: 'manual',
    requestedBy: 'Budi',
    // Ascending with n, so "newest" is the highest n — the same relationship
    // the server's own `submitted_at ASC` ordering has to the page cut.
    submittedAt: `2026-09-${String((n % 28) + 1).padStart(2, '0')}T0${n % 10}:00:00Z`,
    neededBy: null,
    sjId: null,
    sjNumber: null,
    approval: null,
    lines: [
      {
        id: `line-${status}-${n}`,
        itemId: 'item-1',
        itemName: 'Ayam Fillet Beku',
        unitCode: 'kg',
        storageType: 'frozen',
        qtyRequested: '1.000',
        qtyApproved: '1.000',
        qtyShipped: null,
        qtyReceived: null,
        amendReason: null,
      },
    ],
  };
}

/** A server that holds `count` rows for `status` and honours page/pageSize. */
function pagedServer(counts: Record<string, number>) {
  return (path: string) => {
    const qs = new URLSearchParams(path.split('?')[1] ?? '');
    const status = qs.get('status') ?? '';
    const page = Number(qs.get('page') ?? '1');
    const pageSize = Number(qs.get('pageSize') ?? '50');
    const total = counts[status] ?? 0;
    const all = Array.from({ length: total }, (_, i) => requestAt(i + 1, status));
    const rows = all.slice((page - 1) * pageSize, page * pageSize);
    return Promise.resolve({ rows, total, page, pageSize });
  };
}

describe('listApprovedRequests — the SJ picker sees every shippable request', () => {
  // A BLOCK body, not a concise one. `mockReset()` returns the mock, and an
  // implicitly-returned value from `beforeEach` is treated by Vitest as this
  // hook's TEARDOWN function — so the concise form had the runner calling
  // `api.get()` with no arguments after every test.
  beforeEach(() => {
    vi.mocked(api.get).mockReset();
  });

  it('asks for both `approved` and `processing`', async () => {
    vi.mocked(api.get).mockImplementation(pagedServer({ approved: 1, processing: 1 }) as never);
    await listApprovedRequests();
    const statuses = vi
      .mocked(api.get)
      .mock.calls.map(([path]) =>
        new URLSearchParams((path as string).split('?')[1]).get('status'),
      );
    expect(new Set(statuses)).toEqual(new Set(['approved', 'processing']));
  });

  it('pages past the first page instead of stopping at the endpoint`s default cut', async () => {
    // 260 open approved requests: more than one page at the endpoint's `@Max`
    // pageSize of 200, and five times its default of 50.
    vi.mocked(api.get).mockImplementation(pagedServer({ approved: 260, processing: 0 }) as never);
    const res = await listApprovedRequests();

    expect(res.rows).toHaveLength(260);
    expect(res.total).toBe(260);

    // Every request the warehouse could ship is offered — including the newest,
    // which is precisely the one the old single-page-of-fifty read dropped.
    expect(res.rows.map((r) => r.requestNumber)).toContain('RR/202609/0260');

    // And within the endpoint's own limits while doing it.
    for (const [path] of vi.mocked(api.get).mock.calls) {
      const qs = new URLSearchParams((path as string).split('?')[1]);
      expect(Number(qs.get('pageSize'))).toBeLessThanOrEqual(200);
    }
  });

  it('puts the newest request first, because that is the one just approved', async () => {
    vi.mocked(api.get).mockImplementation(pagedServer({ approved: 60, processing: 3 }) as never);
    const res = await listApprovedRequests();

    const submitted = res.rows.map((r) => r.submittedAt!);
    const sortedDesc = [...submitted].sort().reverse();
    expect(submitted).toEqual(sortedDesc);
  });

  it('merges the two statuses by id so an overlap cannot list a request twice', async () => {
    // The SAME row reported under both statuses — a read straddling a status
    // change mid-fetch is exactly how that happens in production.
    const shared = (path: string) => {
      const status = new URLSearchParams(path.split('?')[1] ?? '').get('status');
      const row = requestAt(7, 'shared');
      return Promise.resolve({
        rows: status === 'approved' || status === 'processing' ? [row] : [],
        total: 1,
        page: 1,
        pageSize: 200,
      });
    };
    vi.mocked(api.get).mockImplementation(shared as never);

    const res = await listApprovedRequests();
    expect(res.rows).toHaveLength(1);
  });

  it('propagates a failed fetch instead of resolving to an empty picker', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('boom'));
    // The modal's own load state depends on this rejecting: a resolved-but-empty
    // result is indistinguishable from "the warehouse queue is genuinely empty",
    // which is the message the dispatcher used to get after a 500.
    await expect(listApprovedRequests()).rejects.toThrow();
  });
});
