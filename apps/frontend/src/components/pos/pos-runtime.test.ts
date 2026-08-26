import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { usePosLocation, loadCatalog } from './pos-runtime';
import { useSessionStore } from '@/stores/session-store';
import { api } from '@/lib/api';

/**
 * F02-FIX — the bug: Owner/Manager/Finance (`Me.locations: []`) got `null`
 * back from the old `usePosLocation`, and `app/pos/page.tsx`'s `if
 * (!location) return;` catalog effect meant the page spun on "Memuat…"
 * forever with zero API calls. These pin down the fix's state machine
 * directly: exactly-one-location keeps the old fixed behaviour untouched,
 * zero locations drives an outlet fetch (RBAC-authoritative — the server's
 * `location.read` filter decides what's offered, this hook never
 * pre-guesses), and every branch reaches a terminal status — 'ready',
 * 'choose', or 'error' — never stalls without a way out.
 */
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, api: { ...actual.api, get: vi.fn() } };
});

const mockedGet = vi.mocked(api.get);

function setUser(
  locations: {
    id: string;
    code: string;
    name: string;
    type: 'warehouse' | 'outlet';
    city: string;
  }[],
) {
  useSessionStore.setState({
    user: {
      id: 'u1',
      username: 'owner1',
      name: 'Owner Satu',
      roleKey: 'owner',
      permissions: ['location.read'],
      locations,
      employeeId: null,
      mustSetPin: false,
    },
  });
}

describe('usePosLocation', () => {
  beforeEach(() => {
    mockedGet.mockReset();
    window.localStorage.clear();
    useSessionStore.setState({ user: null });
  });

  it('behaves exactly as today when the user has exactly one assigned location: ready immediately, not changeable, no fetch', () => {
    setUser([
      { id: 'loc1', code: 'OUT1', name: 'Outlet Cempaka', type: 'outlet', city: 'Denpasar' },
    ]);

    const { result } = renderHook(() => usePosLocation());

    expect(result.current).toEqual({
      status: 'ready',
      location: { id: 'loc1', name: 'Outlet Cempaka' },
      canChange: false,
      change: expect.any(Function),
    });
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it('a head-office user with zero locations reaches a chooseable outlet list instead of spinning forever', async () => {
    setUser([]);
    mockedGet.mockResolvedValue({
      rows: [
        { id: 'out1', name: 'Outlet Cempaka' },
        { id: 'out2', name: 'Outlet Sanur' },
      ],
    });

    const { result } = renderHook(() => usePosLocation());

    expect(result.current.status).toBe('loading');
    expect(mockedGet).toHaveBeenCalledWith('/locations?type=outlet&active=true&pageSize=200');

    await waitFor(() => expect(result.current.status).toBe('choose'));
    if (result.current.status !== 'choose') throw new Error('expected choose');
    expect(result.current.options).toEqual([
      { id: 'out1', name: 'Outlet Cempaka' },
      { id: 'out2', name: 'Outlet Sanur' },
    ]);

    act(() => {
      if (result.current.status === 'choose') result.current.select('out2');
    });

    expect(result.current).toMatchObject({
      status: 'ready',
      location: { id: 'out2', name: 'Outlet Sanur' },
      canChange: true,
    });
    expect(window.localStorage.getItem('pos.selectedOutletId')).toBe('out2');
  });

  it('persists the chosen outlet across remounts (reload) instead of re-prompting', async () => {
    setUser([]);
    window.localStorage.setItem('pos.selectedOutletId', 'out1');
    mockedGet.mockResolvedValue({
      rows: [
        { id: 'out1', name: 'Outlet Cempaka' },
        { id: 'out2', name: 'Outlet Sanur' },
      ],
    });

    const { result } = renderHook(() => usePosLocation());

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current).toMatchObject({
      status: 'ready',
      location: { id: 'out1', name: 'Outlet Cempaka' },
    });
  });

  it('surfaces a terminal, retryable error instead of an indefinite spinner when the outlet list fails to load', async () => {
    setUser([]);
    mockedGet.mockRejectedValueOnce(new Error('network down'));
    mockedGet.mockResolvedValueOnce({ rows: [{ id: 'out1', name: 'Outlet Cempaka' }] });

    const { result } = renderHook(() => usePosLocation());

    await waitFor(() => expect(result.current.status).toBe('error'));

    act(() => {
      if (result.current.status === 'error') result.current.retry();
    });

    await waitFor(() => expect(result.current.status).toBe('choose'));
    expect(mockedGet).toHaveBeenCalledTimes(2);
  });

  it('a supervisor with several assigned locations gets the picker built from those locations directly, with no fetch', () => {
    setUser([
      { id: 'loc1', code: 'OUT1', name: 'Outlet Cempaka', type: 'outlet', city: 'Denpasar' },
      { id: 'loc2', code: 'OUT2', name: 'Outlet Sanur', type: 'outlet', city: 'Denpasar' },
    ]);

    const { result } = renderHook(() => usePosLocation());

    expect(result.current).toMatchObject({
      status: 'choose',
      options: [
        { id: 'loc1', name: 'Outlet Cempaka' },
        { id: 'loc2', name: 'Outlet Sanur' },
      ],
    });
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it('lets the active outlet be changed afterwards, clearing the persisted choice so the picker reappears', async () => {
    setUser([]);
    mockedGet.mockResolvedValue({ rows: [{ id: 'out1', name: 'Outlet Cempaka' }] });

    const { result } = renderHook(() => usePosLocation());
    await waitFor(() => expect(result.current.status).toBe('choose'));
    act(() => {
      if (result.current.status === 'choose') result.current.select('out1');
    });
    expect(result.current.status).toBe('ready');

    act(() => {
      if (result.current.status === 'ready') result.current.change();
    });

    expect(result.current.status).toBe('choose');
    expect(window.localStorage.getItem('pos.selectedOutletId')).toBeNull();
  });
});

/**
 * The catalog fetch used to pass `/api/pos/catalog` to a client that already
 * prepends `API_BASE` (`/api`), so it requested `/api/api/pos/catalog` and took
 * a 404 on every call. The failure was SILENT by design — `loadCatalog` falls
 * back to the last cached catalog on any error — so a device that had one
 * served stale data forever, and a device that had never had one showed
 * "Katalog produk belum tersedia" with no way forward. Nothing caught it
 * because no test asserted the URL and the fallback swallowed the status.
 *
 * Asserting the exact path is the point: this is a class of bug that cannot be
 * seen from the response.
 */
describe('loadCatalog — request path', () => {
  beforeEach(() => {
    mockedGet.mockReset();
    window.localStorage.clear();
  });

  it('requests the catalog WITHOUT a second /api prefix (the client adds it)', async () => {
    mockedGet.mockResolvedValue({ products: [], categories: [], version: '1' });

    await loadCatalog('loc-1');

    expect(mockedGet).toHaveBeenCalledTimes(1);
    const path = mockedGet.mock.calls[0]![0] as string;
    expect(path).toBe('/pos/catalog?locationId=loc-1');
    expect(path.startsWith('/api/')).toBe(false);
  });

  it('falls back to the cached catalog when the request fails, rather than throwing at the till', async () => {
    const cached = {
      products: [],
      categories: ['Ayam'],
      version: '7',
      fetchedAt: '2026-08-25T00:00:00.000Z',
    };
    window.localStorage.setItem('pos.catalog.loc-1', JSON.stringify(cached));
    mockedGet.mockRejectedValue(new Error('offline'));

    await expect(loadCatalog('loc-1')).resolves.toMatchObject({ version: '7' });
  });
});
