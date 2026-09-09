import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AbsenPanel } from './AbsenPanel';
import { useSessionStore } from '@/stores/session-store';
import { useMeAttendanceStore, myLocalAttendance } from './lib/attendance-store';
import { toDateInput } from '@/lib/dates';

/**
 * ONE PERSON'S ATTENDANCE DAY IS NOT ANOTHER PERSON'S.
 *
 * The same defect as MA-191's till, in the other store that persists a
 * per-user fact per BROWSER PROFILE: `mimi-me-attendance` holds "have I
 * already clocked in today, and under which `attendanceId`", `logout()`
 * clears only `mimi-session`, and an outlet shares one machine between the
 * pagi/siang/malam crews.
 *
 * It is the worse of the two, because `attendanceId` is the row a CHECK-OUT
 * writes to. `submit()` falls back to `localToday.attendanceId` whenever the
 * server read has not got the check-in yet — offline, or simply not synced,
 * which on this deployment is the normal case — so the next person to log in
 * on that browser was shown "Absen Pulang" for a day they had not started and
 * would have clocked OUT of the previous person's attendance row, leaving
 * their own day never closed and the other person's shift ended by someone
 * else's phone.
 *
 * Unlike a shift there is no handover reading of this: an attendance row is
 * personal. A record belonging to somebody else is simply not shown, which
 * falls the panel back on `getMyAttendance` — a read the server already
 * scopes to the caller.
 */
vi.mock('./lib/me-api', () => ({
  getMyAttendance: vi.fn().mockResolvedValue([]),
  getLocationGeo: vi.fn().mockResolvedValue(null),
}));

vi.mock('./lib/me-runtime', () => ({
  useActorMeta: () => ({ actorUserId: 'u1', actorRole: 'kasir', appVersion: 'test' }),
  getMeRuntime: vi.fn().mockResolvedValue(null),
  mintId: () => 'id-1',
}));

const OUTLET = { id: 'loc-1', name: 'Mimi Chicken Balikpapan Kota', code: 'BPP01' };

function setUser(id: string, name: string) {
  useSessionStore.setState({
    user: {
      id,
      username: name.toLowerCase().replace(/\s+/g, '_'),
      name,
      roleKey: 'kasir',
      permissions: [],
      locations: [OUTLET],
    },
  } as never);
}

function allowGeolocation() {
  Object.defineProperty(globalThis.navigator, 'geolocation', {
    configurable: true,
    value: {
      getCurrentPosition: (ok: (p: unknown) => void) =>
        ok({ coords: { latitude: -1.2, longitude: 116.8, accuracy: 12 } }),
    },
  });
}

/**
 * The morning crew member, checked in and not yet out — dated TODAY, because
 * `resetIfStale` drops anything older and the panel would then never read it.
 * Computed rather than written down: a literal date would quietly stop
 * exercising the leak the day after it was authored.
 */
const OTHERS_DAY = {
  date: toDateInput(new Date()),
  userId: 'kasir-pagi',
  attendanceId: 'att-pagi',
  checkedInAt: new Date().toISOString(),
  checkedOutAt: null,
};

describe('AbsenPanel — the local record belongs to whoever wrote it', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    allowGeolocation();
  });
  afterEach(() => {
    useSessionStore.setState({ user: null } as never);
    useMeAttendanceStore.setState({ today: null });
  });

  it('does not show the next employee as already clocked in', async () => {
    useMeAttendanceStore.setState({ today: OTHERS_DAY });
    setUser('kasir-siang', 'Budi Siang');

    render(<AbsenPanel />);

    // Their own day has not started, so this is a check-IN.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Absen Masuk/i })).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole('button', { name: /Absen Pulang/i }),
      'the afternoon crew was offered a check-out against the morning crew’s attendance row',
    ).not.toBeInTheDocument();
    // …and none of the previous person's day is presented as theirs. This
    // badge renders exactly when a LOCAL check-in exists with no server row
    // behind it, which is the leak's own signature.
    expect(screen.queryByText(/Tersimpan di perangkat/i)).not.toBeInTheDocument();
  });

  it('still shows the employee their OWN queued check-in', async () => {
    // The reason this record is persisted at all: a check-in queued offline is
    // absent from the server read, and without it the employee is shown the
    // check-in button again and can double-submit. Scoping by owner must not
    // cost that.
    useMeAttendanceStore.setState({ today: OTHERS_DAY });
    setUser('kasir-pagi', 'Ayu Pagi');

    render(<AbsenPanel />);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Absen Pulang/i })).toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: /Absen Masuk/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Tersimpan di perangkat/i)).toBeInTheDocument();
  });

  it('reads a record written before attendance had an owner as somebody else’s', () => {
    const legacy = { ...OTHERS_DAY } as Partial<typeof OTHERS_DAY>;
    delete legacy.userId;

    // A blob whose owner cannot be established is not adopted — the same
    // upgrade-path stance as `shiftBelongsTo`.
    expect(myLocalAttendance(legacy as typeof OTHERS_DAY, 'kasir-pagi')).toBeNull();
    expect(myLocalAttendance(OTHERS_DAY, 'kasir-pagi')).toBe(OTHERS_DAY);
    expect(myLocalAttendance(OTHERS_DAY, 'kasir-siang')).toBeNull();
    // Two unknowns are not a match.
    expect(myLocalAttendance(legacy as typeof OTHERS_DAY, undefined)).toBeNull();
    expect(myLocalAttendance(null, 'kasir-pagi')).toBeNull();
  });
});
