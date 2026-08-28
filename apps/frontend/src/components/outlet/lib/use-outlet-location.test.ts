/**
 * The bug this pins (owner, 2026-08-27): the Outlet surface showed a loading
 * skeleton forever for an owner/superadmin. `useOutletLocation` returned a
 * nullable `locationId` from `Me.locations`, a central role has that array
 * EMPTY by design (D-05), and all six panels guard with `if (!locationId)
 * return;` — so the fetch was never made. It looked like a hung request and was
 * actually a state the UI had no branch for.
 *
 * These assert the state machine reaches a TERMINAL, renderable state for every
 * kind of account, and specifically that "no assigned outlet" means PICK ONE,
 * never "nothing here".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useOutletLocation } from './use-outlet-location';
import { useSessionStore } from '@/stores/session-store';
import { api } from '@/lib/api';

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, api: { ...actual.api, get: vi.fn() } };
});

const mockedGet = vi.mocked(api.get);

type Loc = { id: string; code: string; name: string; type: 'warehouse' | 'outlet'; city: string };

function setLocations(locations: Loc[]) {
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

const OUTLET_A: Loc = { id: 'a', code: 'A', name: 'Outlet A', type: 'outlet', city: 'Balikpapan' };
const OUTLET_B: Loc = { id: 'b', code: 'B', name: 'Outlet B', type: 'outlet', city: 'Samarinda' };
const WAREHOUSE: Loc = {
  id: 'w',
  code: 'W',
  name: 'Gudang',
  type: 'warehouse',
  city: 'Balikpapan',
};

describe('useOutletLocation', () => {
  beforeEach(() => {
    mockedGet.mockReset();
    window.localStorage.clear();
  });

  it('a central role (no assigned outlet) gets a PICKER, not an endless spinner', async () => {
    setLocations([]);
    mockedGet.mockResolvedValue({ rows: [OUTLET_A, OUTLET_B] });

    const { result } = renderHook(() => useOutletLocation());

    await waitFor(() => expect(result.current.status).toBe('choose'));
    if (result.current.status !== 'choose') throw new Error('expected choose');
    expect(result.current.options.map((o) => o.name)).toEqual(['Outlet A', 'Outlet B']);
    // The server decides which outlets are on offer — this hook must not filter by role itself.
    expect(mockedGet).toHaveBeenCalledWith('/locations?type=outlet&active=true&pageSize=200');
  });

  it('selecting an outlet settles it, and it survives a remount', async () => {
    setLocations([]);
    mockedGet.mockResolvedValue({ rows: [OUTLET_A, OUTLET_B] });

    const first = renderHook(() => useOutletLocation());
    await waitFor(() => expect(first.result.current.status).toBe('choose'));
    if (first.result.current.status !== 'choose') throw new Error('expected choose');
    act(() => first.result.current.select('b'));

    await waitFor(() => expect(first.result.current.status).toBe('ready'));
    if (first.result.current.status !== 'ready') throw new Error('expected ready');
    expect(first.result.current.location.name).toBe('Outlet B');
    expect(first.result.current.canChange).toBe(true);

    // Reload: an owner monitoring one outlet should not re-pick on every visit.
    const second = renderHook(() => useOutletLocation());
    await waitFor(() => expect(second.result.current.status).toBe('ready'));
    if (second.result.current.status !== 'ready') throw new Error('expected ready');
    expect(second.result.current.location.id).toBe('b');
  });

  it('change() returns to the picker so an owner can monitor a different outlet', async () => {
    setLocations([]);
    mockedGet.mockResolvedValue({ rows: [OUTLET_A, OUTLET_B] });

    const { result } = renderHook(() => useOutletLocation());
    await waitFor(() => expect(result.current.status).toBe('choose'));
    if (result.current.status !== 'choose') throw new Error('expected choose');
    act(() => result.current.select('a'));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    if (result.current.status !== 'ready') throw new Error('expected ready');

    act(() => result.current.change());
    await waitFor(() => expect(result.current.status).toBe('choose'));
  });

  it('a single-outlet account resolves straight through and cannot switch', () => {
    setLocations([OUTLET_A]);
    const { result } = renderHook(() => useOutletLocation());

    expect(result.current.status).toBe('ready');
    if (result.current.status !== 'ready') throw new Error('expected ready');
    expect(result.current.location.id).toBe('a');
    // Unchanged pre-fix behaviour for Leader/Staff Outlet: no picker to get wrong.
    expect(result.current.canChange).toBe(false);
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it('a WAREHOUSE assignment is never treated as the outlet', async () => {
    // These panels edit outlet stock, waste and petty cash. Falling back to a
    // warehouse would point them at the wrong location's data entirely.
    setLocations([WAREHOUSE]);
    mockedGet.mockResolvedValue({ rows: [OUTLET_A] });

    const { result } = renderHook(() => useOutletLocation());
    await waitFor(() => expect(result.current.status).toBe('choose'));
  });

  it('a supervisor with several outlets picks from its OWN list, with no fetch', () => {
    setLocations([OUTLET_A, OUTLET_B]);
    const { result } = renderHook(() => useOutletLocation());

    expect(result.current.status).toBe('choose');
    if (result.current.status !== 'choose') throw new Error('expected choose');
    expect(result.current.options).toHaveLength(2);
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it('a stored outlet that is no longer offered falls back to the picker', async () => {
    // Outlet retired, or the caller's scope changed. Resolving to it anyway
    // would silently show data for somewhere they can no longer act on.
    window.localStorage.setItem('outlet.selectedOutletId', 'gone');
    setLocations([]);
    mockedGet.mockResolvedValue({ rows: [OUTLET_A] });

    const { result } = renderHook(() => useOutletLocation());
    await waitFor(() => expect(result.current.status).toBe('choose'));
  });

  it('a failed outlet fetch is terminal and retryable, never a spinner', async () => {
    setLocations([]);
    mockedGet.mockRejectedValue(new Error('offline'));

    const { result } = renderHook(() => useOutletLocation());
    await waitFor(() => expect(result.current.status).toBe('error'));
    if (result.current.status !== 'error') throw new Error('expected error');

    mockedGet.mockResolvedValue({ rows: [OUTLET_A] });
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.status).toBe('choose'));
  });

  it('does not share the POS storage key', async () => {
    // A supervisor monitoring outlet B in the back office must not re-point a
    // till mid-shift on outlet A.
    setLocations([]);
    mockedGet.mockResolvedValue({ rows: [OUTLET_A, OUTLET_B] });
    const { result } = renderHook(() => useOutletLocation());
    await waitFor(() => expect(result.current.status).toBe('choose'));
    if (result.current.status !== 'choose') throw new Error('expected choose');
    act(() => result.current.select('b'));

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(window.localStorage.getItem('outlet.selectedOutletId')).toBe('b');
    expect(window.localStorage.getItem('pos.selectedOutletId')).toBeNull();
  });
});
