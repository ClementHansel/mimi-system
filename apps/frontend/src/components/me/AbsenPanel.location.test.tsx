import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { AbsenPanel } from './AbsenPanel';
import { useSessionStore } from '@/stores/session-store';

/**
 * WHERE a clock-in is recorded, and getting back from a denied location.
 *
 * Two client reports about the same screen:
 *
 *  - MA-201: attendance read `user.locations[0]` — the first of however many
 *    branches the person covers, taken silently. A Supervisor Cabang assigned to
 *    three outlets clocked in against whichever sorted first, with nothing on
 *    screen naming it and no way to change it. An attendance row is the record
 *    of where someone actually worked; guessing it is not a defensible default.
 *
 *  - MA-202: the "Perbarui Lokasi" retry button rendered only `{coords && …}` —
 *    once a position had ALREADY been obtained, which is exactly when nobody
 *    needs it. When permission was denied the user got an error message, a
 *    disabled clock-in button, and no way back at all.
 *
 * Both are asserted here against the real component rather than the helpers,
 * because in both cases the defect was the CONDITION on a piece of UI, and a
 * unit test of the geofence maths would have passed throughout.
 */
vi.mock('./lib/me-api', () => ({
  getMyAttendance: vi.fn().mockResolvedValue([]),
  getLocationGeo: vi.fn().mockResolvedValue(null),
}));

vi.mock('./lib/me-runtime', () => ({
  useActorMeta: () => ({ userId: 'u1', roleKey: 'supervisor', deviceId: 'd1' }),
  getMeRuntime: vi.fn().mockResolvedValue(null),
  mintId: () => 'id-1',
}));

const THREE_OUTLETS = [
  { id: 'loc-1', name: 'Mimi Chicken Balikpapan Kota', code: 'BPP01' },
  { id: 'loc-2', name: 'Mimi Chicken Banjarmasin Barat', code: 'BJM05' },
  { id: 'loc-3', name: 'Mimi Chicken Samarinda Ulu', code: 'SMD01' },
];

function setUser(locations: { id: string; name: string; code: string }[]) {
  useSessionStore.setState({
    user: {
      id: 'u1',
      username: 'spv_multi',
      name: 'Testing 0002',
      roleKey: 'supervisor',
      permissions: [],
      locations,
    },
  } as never);
}

/** A geolocation that denies permission, which is the MA-202 condition. */
function denyGeolocation() {
  Object.defineProperty(globalThis.navigator, 'geolocation', {
    configurable: true,
    value: {
      getCurrentPosition: (_ok: unknown, fail: (e: unknown) => void) =>
        fail({ code: 1, message: 'denied' }),
    },
  });
}

/** A geolocation that succeeds, so the happy path can be compared against. */
function allowGeolocation() {
  Object.defineProperty(globalThis.navigator, 'geolocation', {
    configurable: true,
    value: {
      getCurrentPosition: (ok: (p: unknown) => void) =>
        ok({ coords: { latitude: -1.2, longitude: 116.8, accuracy: 12 } }),
    },
  });
}

describe('AbsenPanel — which location, and recovering from a denied one', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => useSessionStore.setState({ user: null } as never));

  it('makes someone assigned to several branches choose, instead of silently using the first', async () => {
    allowGeolocation();
    setUser(THREE_OUTLETS);

    render(<AbsenPanel />);

    const picker = await waitFor(() => screen.getByLabelText(/Lokasi Absen/i));
    expect(picker).toBeInTheDocument();
    // Nothing preselected — the whole point is that the branch is stated, not assumed.
    expect((picker as HTMLSelectElement).value).toBe('');
    expect(screen.getByText(/ditugaskan di lebih dari satu lokasi/i)).toBeInTheDocument();

    // …and every assigned branch is offered, not just the first.
    const values = Array.from((picker as HTMLSelectElement).querySelectorAll('option'))
      .map((o) => (o as HTMLOptionElement).value)
      .filter(Boolean);
    expect(values).toEqual(['loc-1', 'loc-2', 'loc-3']);
  });

  it('shows the single branch as a plain label, with no choice to make', async () => {
    allowGeolocation();
    setUser([THREE_OUTLETS[0]!]);

    render(<AbsenPanel />);

    await waitFor(() =>
      expect(screen.getByText(/Mimi Chicken Balikpapan Kota/)).toBeInTheDocument(),
    );
    // No dropdown for a person with one posting — that would be friction with
    // nothing behind it.
    expect(screen.queryByLabelText(/Lokasi Absen/i)).not.toBeInTheDocument();
  });

  it('offers a retry when the location was DENIED — the case the button used to hide from', async () => {
    denyGeolocation();
    setUser([THREE_OUTLETS[0]!]);

    render(<AbsenPanel />);

    // A way out of the denial. Before MA-202 this button did not render at all
    // without coords, leaving the user with an error, a disabled clock-in and
    // nothing to click.
    const retry = await waitFor(() => screen.getByRole('button', { name: /Coba Ambil Lokasi/i }));
    expect(retry).toBeEnabled();

    // Clicking it really re-asks: permission is granted the second time.
    allowGeolocation();
    fireEvent.click(retry);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Perbarui Lokasi/i })).toBeInTheDocument(),
    );
  });
});
