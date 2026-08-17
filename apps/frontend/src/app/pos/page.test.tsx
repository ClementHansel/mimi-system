import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import PosPage from './page';
import { PosShellProvider } from '@/components/pos/PosShellContext';
import { useSessionStore } from '@/stores/session-store';
import { usePosShiftStore } from '@/components/pos/shift-store';
import { api } from '@/lib/api';
import { getBrowserLocalRuntime } from '@/lib/local/browser';
import type { LocalRuntime } from '@/lib/local/api/local-runtime';

/**
 * F02-FIX — the diagnosed bug: `usePosLocation()` returned `user.locations[0]`,
 * which is `undefined` (-> `null`) for Owner/Manager/Finance (`Me.locations:
 * []`, D-05). `app/pos/page.tsx`'s catalog effect was `if (!location)
 * return;`, so the page rendered "Memuat…" forever with zero API calls and no
 * way out. This is the ticket's point: prove a zero-location user reaches a
 * real, usable screen instead of that indefinite spinner, and that the
 * runtime-bootstrap failure path also terminates rather than spinning.
 *
 * F-POS-2: `PosPage` now reads `actor`/`posLocation` from `usePosShell()`
 * instead of calling `useActorMeta()`/`usePosLocation()` itself — the real
 * app supplies that context from `app/pos/layout.tsx` (POS's own standalone
 * shell, no longer the sidebar app), so every render here wraps `<PosPage/>`
 * in the same `<PosShellProvider>` to match. The hooks underneath, and what
 * they read/mock, are unchanged.
 */
vi.mock('@/lib/local/browser', () => ({ getBrowserLocalRuntime: vi.fn() }));
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, api: { ...actual.api, get: vi.fn() } };
});

const mockedGetRuntime = vi.mocked(getBrowserLocalRuntime);
const mockedGet = vi.mocked(api.get);

function renderPosPage() {
  return render(
    <PosShellProvider>
      <PosPage />
    </PosShellProvider>,
  );
}

function setOwner() {
  useSessionStore.setState({
    user: {
      id: 'u1', username: 'owner1', name: 'Owner Satu', roleKey: 'owner',
      permissions: ['location.read'], locations: [], employeeId: null, mustSetPin: false,
    },
  });
}

describe('PosPage — F02-FIX head-office access', () => {
  beforeEach(() => {
    window.localStorage.clear();
    mockedGetRuntime.mockReset();
    mockedGet.mockReset();
    usePosShiftStore.setState({ current: null });
  });

  it('a user with locations: [] reaches a usable POS (outlet picker -> shift-open), never a bare spinner with zero API calls', async () => {
    setOwner();
    mockedGetRuntime.mockResolvedValue({} as unknown as LocalRuntime);
    mockedGet.mockImplementation((path: string) => {
      if (path.startsWith('/locations')) {
        return Promise.resolve({ rows: [{ id: 'out1', name: 'Outlet Cempaka' }] });
      }
      return Promise.resolve({ products: [], categories: [], version: 'v1' });
    });

    renderPosPage();

    // The old bug: zero API calls, indefinite "Memuat…". The fix must
    // actually call the locations endpoint and show a picker.
    await waitFor(() => expect(mockedGet).toHaveBeenCalledWith('/locations?type=outlet&active=true&pageSize=200'));
    expect(await screen.findByText('Pilih Outlet')).toBeInTheDocument();
    expect(screen.getByText('Outlet Cempaka')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Outlet Cempaka'));
    fireEvent.click(screen.getByText('Lanjutkan'));

    // Reaches the next real screen instead of stalling — proof the choice
    // actually unblocked the rest of the page. ("Buka Kasir" appears twice —
    // heading + submit button — so assert on the heading role.)
    expect(await screen.findByRole('heading', { name: 'Buka Kasir' })).toBeInTheDocument();
  });

  it('gives an explicit, retryable error — never an indefinite spinner — when the outlet list fails to load', async () => {
    setOwner();
    mockedGetRuntime.mockResolvedValue({} as unknown as LocalRuntime);
    mockedGet.mockRejectedValue(new Error('network down'));

    renderPosPage();

    expect(await screen.findByText('Gagal memuat daftar outlet')).toBeInTheDocument();
    expect(screen.getByText('Coba Lagi')).toBeInTheDocument();
  });

  it('gives an explicit, retryable error — never an indefinite spinner — when the local runtime fails to bootstrap', async () => {
    useSessionStore.setState({
      user: {
        id: 'u2', username: 'kasir1', name: 'Kasir Satu', roleKey: 'kasir',
        permissions: [], locations: [{ id: 'loc1', code: 'OUT1', name: 'Outlet Cempaka', type: 'outlet', city: 'Denpasar' }],
        employeeId: null, mustSetPin: false,
      },
    });
    mockedGetRuntime.mockRejectedValue(new Error('IndexedDB unavailable'));
    mockedGet.mockResolvedValue({ products: [], categories: [], version: 'v1' });

    renderPosPage();

    expect(await screen.findByText('Gagal menyiapkan perangkat kasir')).toBeInTheDocument();
    expect(screen.getByText('Coba Lagi')).toBeInTheDocument();
  });
});
