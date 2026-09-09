import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import PosPage from './page';
import PosLayout from './layout';
import { useSessionStore } from '@/stores/session-store';
import { usePosShiftStore, shiftBelongsTo, type OpenShift } from '@/components/pos/shift-store';
import { api } from '@/lib/api';
import { getBrowserLocalRuntime } from '@/lib/local/browser';
import type { LocalRuntime } from '@/lib/local/api/local-runtime';

/**
 * A TILL NEVER HANDS ONE CASHIER ANOTHER CASHIER'S OPEN SHIFT.
 *
 * MA-191, reported from production: "Shift kasir sudah dibuka ketika karyawan
 * (kasir) yang baru ditambahkan login ke POS dan nama kasir nya tidak sesuai
 * dengan kasir yang sedang login."
 *
 * `usePosShiftStore` persists to localStorage under `mimi-pos-shift`, and
 * `logout()` clears `mimi-session` and nothing else — so the open-shift record
 * outlives every session that wrote it. An outlet till is one shared browser
 * that the pagi/siang/malam crews log into in turn, and the POS surface gated
 * purely on that slot being truthy. The morning cashier's shift was therefore
 * adopted, silently, by whoever logged in next: their sales went onto that
 * `shiftId`, the Shift tab showed the morning cashier's name, and closing it
 * counted the afternoon drawer against the morning opening cash.
 *
 * The record had no owner to check — that is the actual defect, and it is why
 * these tests assert on the SCREEN a second cashier reaches rather than on the
 * store: `shiftBelongsTo` returning false is only useful if all three gates
 * (this page, `PosTopBar`, `ShiftOpenForm`) act on it.
 */
vi.mock('@/lib/local/browser', () => ({ getBrowserLocalRuntime: vi.fn() }));
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, api: { ...actual.api, get: vi.fn() } };
});

const OUTLET = { id: 'out1', name: 'Outlet Cempaka', code: 'OUT1' };

/** The morning cashier's shift, as this browser persisted it. */
function morningShift(kasirUserId: string): OpenShift {
  return {
    shiftId: 'shift-pagi',
    locationId: OUTLET.id,
    kasirUserId,
    openingCash: '200000.00',
    openedAt: '2026-09-08T00:15:00Z',
    kasirName: 'Ayu Pagi',
    cashCollected: '450000.00',
    grossSales: '450000.00',
    salesCount: 9,
    voidCount: 0,
  };
}

function setKasir(id: string, name: string) {
  useSessionStore.setState({
    user: {
      id,
      username: name.toLowerCase().replace(/\s+/g, '_'),
      name,
      roleKey: 'kasir',
      permissions: ['pos.shift.open'],
      locations: [OUTLET],
      employeeId: null,
      mustSetPin: false,
    },
  } as never);
}

/**
 * The real chrome, not just the page — `app/pos/layout.tsx` supplies the
 * `<Tabs>` context, `PosShellProvider` and `PosTopBar`. Two of the three
 * ownership gates live out here (the tab row's `operational` flag is one of
 * them), so a harness that rendered `<PosPage/>` alone would leave the header
 * free to disagree with the page about whose shift is on screen — which is
 * half of what the client actually saw.
 */
function renderPosPage() {
  return render(
    <PosLayout>
      <PosPage />
    </PosLayout>,
  );
}

describe('POS shift ownership — a shared till between two cashiers', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.mocked(getBrowserLocalRuntime).mockResolvedValue({} as unknown as LocalRuntime);
    vi.mocked(api.get).mockResolvedValue({
      products: [],
      categories: [],
      version: 'v1',
    } as never);
    usePosShiftStore.setState({ current: null });
  });

  it('does not put the afternoon cashier into the morning cashier’s shift', async () => {
    usePosShiftStore.setState({ current: morningShift('kasir-pagi') });
    setKasir('kasir-siang', 'Budi Siang');

    renderPosPage();

    // The handover screen, naming the cashier whose shift is actually open.
    await waitFor(() =>
      expect(screen.getByText(/Shift Sebelumnya Belum Ditutup/i)).toBeInTheDocument(),
    );
    expect(
      screen.getByText('Shift atas nama Ayu Pagi masih terbuka di perangkat ini.'),
    ).toBeInTheDocument();

    // NOT the till. Before MA-191 this rendered the full kasir surface, and
    // every sale rung here landed on `shift-pagi`.
    expect(
      screen.queryByRole('button', { name: /Lanjut ke Pembayaran/i }),
      'the afternoon cashier was dropped into a shift that was not theirs',
    ).not.toBeInTheDocument();
    // …and the header agrees: no tab row over a handover screen.
    expect(screen.queryByRole('tab', { name: /Shift/i })).not.toBeInTheDocument();
  });

  it('offers to close that shift rather than leaving it stranded', async () => {
    usePosShiftStore.setState({ current: morningShift('kasir-pagi') });
    setKasir('kasir-siang', 'Budi Siang');

    renderPosPage();

    // One drawer, one open shift — the same rule the backend's own interactive
    // `PosShiftService.open` enforces (ERR_CONFLICT, "A shift is already open
    // for this location/device"). So the way forward is the handover, not a
    // second concurrent shift: count the drawer and close the one that is open.
    // Without this the fix would trade a wrong name for an orphan, because
    // there is no supervisor shift-list screen anywhere in the app — the till
    // is the only place a shift can be closed.
    const closeButton = await waitFor(() =>
      screen.getByRole('button', { name: /Tutup Shift Ayu Pagi/i }),
    );
    expect(closeButton).toBeEnabled();

    // And no way to skip past it into a fresh shift on top of the open one.
    expect(screen.queryByRole('button', { name: /^Buka Kasir$/i })).not.toBeInTheDocument();
  });

  it('still resumes the SAME cashier’s own shift across a reload', async () => {
    // The reason the record is persisted at all: a refresh mid-shift must not
    // re-prompt "buka kasir" over an already-open shift. Scoping it by owner
    // must not cost that.
    usePosShiftStore.setState({ current: morningShift('kasir-pagi') });
    setKasir('kasir-pagi', 'Ayu Pagi');

    renderPosPage();

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Lanjut ke Pembayaran/i })).toBeInTheDocument(),
    );
    expect(screen.queryByText(/Shift Sebelumnya Belum Ditutup/i)).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Shift/i })).toBeInTheDocument();
  });

  it('shows a plain Buka Kasir form when nothing is open', async () => {
    setKasir('kasir-siang', 'Budi Siang');

    renderPosPage();

    await waitFor(() => expect(screen.getByLabelText(/Modal Awal Kas/i)).toBeInTheDocument());
    expect(screen.queryByText(/Shift Sebelumnya Belum Ditutup/i)).not.toBeInTheDocument();
  });

  it('treats a record written before shifts had an owner as somebody else’s', async () => {
    // The upgrade path. A blob persisted by the build that shipped this bug
    // has no `kasirUserId`, so its owner cannot be established — and the safe
    // reading of that is "not mine", not "mine". The client's currently-stuck
    // till lands on the handover screen instead of adopting the shift again.
    const legacy = morningShift('kasir-pagi') as Partial<OpenShift>;
    delete legacy.kasirUserId;
    usePosShiftStore.setState({ current: legacy as OpenShift });
    setKasir('kasir-siang', 'Budi Siang');

    expect(shiftBelongsTo(legacy as OpenShift, 'kasir-siang')).toBe(false);

    renderPosPage();

    await waitFor(() =>
      expect(screen.getByText(/Shift Sebelumnya Belum Ditutup/i)).toBeInTheDocument(),
    );
  });

  it('never claims an anonymous shift for an anonymous viewer', () => {
    // Two `undefined`s are not a match. Guards the one way a `===` on ids can
    // accidentally return true for a viewer who is not signed in at all.
    const legacy = morningShift('kasir-pagi') as Partial<OpenShift>;
    delete legacy.kasirUserId;
    expect(shiftBelongsTo(legacy as OpenShift, undefined)).toBe(false);
    expect(shiftBelongsTo(null, 'kasir-siang')).toBe(false);
  });
});
