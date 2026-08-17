import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useManualConnectivityCheck } from './useManualConnectivityCheck';
import { useConnectivityStore } from '@/stores/connectivity-store';
import { getBrowserLocalRuntime } from '@/lib/local/browser';
import type { LocalRuntime } from '@/lib/local/api/local-runtime';

vi.mock('@/lib/local/browser', () => ({
  getBrowserLocalRuntime: vi.fn(),
}));

const mockedGetBrowserLocalRuntime = vi.mocked(getBrowserLocalRuntime);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/**
 * The D-25b manual action, exercised against LocalRuntime's real public
 * surface (`stop`/`start`/`syncNow`) with a fake runtime — this hook has no
 * dedicated "re-probe now" method to call (see the hook's own docblock for
 * why `stop()`+`start()` stands in for one), so these tests pin down exactly
 * what it does with what the API actually returns.
 */
describe('useManualConnectivityCheck', () => {
  beforeEach(() => {
    useConnectivityStore.setState({
      tier: 'online',
      queueDepth: 0,
      isSyncing: false,
      lastSyncAt: null,
      cloudReachable: true,
      manualCheckStatus: 'idle',
      manualCheckErrorKey: null,
    });
    mockedGetBrowserLocalRuntime.mockReset();
  });

  it('reports success when the re-probe finds an upstream and the sync cycle completes cleanly', async () => {
    const runtime = {
      stop: vi.fn(),
      start: vi.fn(async () => {
        useConnectivityStore.getState().setTier('online');
      }),
      syncNow: vi.fn(async () => ({ offline: false, drain: {}, pull: {} })),
    };
    mockedGetBrowserLocalRuntime.mockResolvedValue(runtime as unknown as LocalRuntime);

    const { result } = renderHook(() => useManualConnectivityCheck());
    await act(async () => {
      await result.current.run();
    });

    expect(runtime.stop).toHaveBeenCalledTimes(1);
    expect(runtime.start).toHaveBeenCalledTimes(1);
    expect(runtime.syncNow).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('success');
    expect(result.current.errorKey).toBeNull();
  });

  it('shows the in-progress state while the check is running', async () => {
    const gate = deferred<void>();
    const runtime = {
      stop: vi.fn(),
      start: vi.fn(async () => {
        await gate.promise;
        useConnectivityStore.getState().setTier('online');
      }),
      syncNow: vi.fn(async () => ({ offline: false })),
    };
    mockedGetBrowserLocalRuntime.mockResolvedValue(runtime as unknown as LocalRuntime);

    const { result } = renderHook(() => useManualConnectivityCheck());
    act(() => {
      void result.current.run();
    });

    await waitFor(() => expect(result.current.status).toBe('checking'));

    await act(async () => {
      gate.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.status).toBe('success'));
  });

  it('reports the "still offline" reason when the re-probe finds no reachable upstream at all, without pretending a sync ran', async () => {
    const runtime = {
      stop: vi.fn(),
      start: vi.fn(async () => {
        useConnectivityStore.getState().setTier('isolated');
      }),
      syncNow: vi.fn(),
    };
    mockedGetBrowserLocalRuntime.mockResolvedValue(runtime as unknown as LocalRuntime);

    const { result } = renderHook(() => useManualConnectivityCheck());
    await act(async () => {
      await result.current.run();
    });

    expect(result.current.status).toBe('error');
    expect(result.current.errorKey).toBe('offline');
    // Never claim a sync attempt happened when there was nothing to sync against.
    expect(runtime.syncNow).not.toHaveBeenCalled();
  });

  it('reports "syncFailed" when connectivity is fine but the push/pull cycle itself failed', async () => {
    const runtime = {
      stop: vi.fn(),
      start: vi.fn(async () => {
        useConnectivityStore.getState().setTier('online');
      }),
      syncNow: vi.fn(async () => ({ offline: true, drain: {}, pull: {} })),
    };
    mockedGetBrowserLocalRuntime.mockResolvedValue(runtime as unknown as LocalRuntime);

    const { result } = renderHook(() => useManualConnectivityCheck());
    await act(async () => {
      await result.current.run();
    });

    expect(result.current.status).toBe('error');
    expect(result.current.errorKey).toBe('syncFailed');
  });

  it('never claims success when the runtime is unreachable entirely', async () => {
    mockedGetBrowserLocalRuntime.mockRejectedValue(new Error('IndexedDB unavailable'));

    const { result } = renderHook(() => useManualConnectivityCheck());
    await act(async () => {
      await result.current.run();
    });

    expect(result.current.status).toBe('error');
    expect(result.current.errorKey).toBe('unknown');
  });
});
