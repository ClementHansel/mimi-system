import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { DriverJobsPanel } from './DriverJobsPanel';
import { useSessionStore } from '@/stores/session-store';
import { getDrivers, getMyJobs } from './lib/driver-api';

/**
 * `/driver` is not a driver-only screen: owner and superadmin open it to see
 * any driver's run through the fleet picker (`myJobs`'s `viewDriverId`, which
 * the SERVICE gates on those two roles).
 *
 * These tests cover the way that supervisor view could get STUCK. `reload`
 * must not fetch before the picker has a driver — firing without one returns
 * the owner's own (empty) run — but the early return it used for that never
 * cleared `loading`, so any owner whose fleet call failed, or whose `drivers`
 * table was empty, sat on "Memuat data…" forever with no error and no way
 * forward. The fix distinguishes "the fleet has not answered yet" from "the
 * fleet answered with nobody".
 */
vi.mock('./lib/driver-api', () => ({
  getDrivers: vi.fn(),
  getMyJobs: vi.fn(),
}));
vi.mock('./lib/job-cache', () => ({
  loadJobs: vi.fn().mockResolvedValue(null),
  saveJobs: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./SjJobCard', () => ({ SjJobCard: () => <div data-testid="sj-card" /> }));
vi.mock('./DaySummary', () => ({ DaySummary: () => <div data-testid="day-summary" /> }));

function signInAs(roleKey: string, permissions: string[]) {
  useSessionStore.setState({
    user: {
      id: 'u1',
      username: roleKey,
      name: 'Test User',
      roleKey,
      permissions,
      locations: [],
      employeeId: null,
      mustSetPin: false,
    },
  });
}

describe('DriverJobsPanel — supervisor view', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSessionStore.setState({ accessToken: null, refreshToken: null, user: null });
  });

  it('stops loading and explains itself when no driver is registered', async () => {
    signInAs('owner', ['delivery.drop.execute', 'delivery.read']);
    vi.mocked(getDrivers).mockResolvedValue([]);
    vi.mocked(getMyJobs).mockResolvedValue([]);

    render(<DriverJobsPanel />);

    expect(await screen.findByText(/Belum ada driver aktif/i)).toBeInTheDocument();
    expect(screen.queryByText(/Memuat data/i)).not.toBeInTheDocument();
    // Nothing to ask for: firing `my-jobs` with no driverId would return the
    // owner's own empty run and mislabel it as the fleet's day.
    expect(getMyJobs).not.toHaveBeenCalled();
  });

  it('stops loading when the fleet request itself fails', async () => {
    signInAs('superadmin', ['delivery.drop.execute', 'delivery.read']);
    vi.mocked(getDrivers).mockRejectedValue(new Error('offline'));
    vi.mocked(getMyJobs).mockResolvedValue([]);

    render(<DriverJobsPanel />);

    await waitFor(() => expect(screen.queryByText(/Memuat data/i)).not.toBeInTheDocument());
  });

  it('defaults the picker to the first driver and fetches that driver’s run', async () => {
    signInAs('owner', ['delivery.drop.execute', 'delivery.read']);
    vi.mocked(getDrivers).mockResolvedValue([
      { id: 'd1', name: 'Dian Santoso', isActive: true },
      { id: 'd2', name: 'Budi', isActive: true },
    ]);
    vi.mocked(getMyJobs).mockResolvedValue([]);

    render(<DriverJobsPanel />);

    await waitFor(() => expect(getMyJobs).toHaveBeenCalled());
    expect(vi.mocked(getMyJobs).mock.calls[0]?.[1]).toBe('d1');
    expect(await screen.findByLabelText(/Lihat rute driver/i)).toHaveValue('d1');
  });

  it('never sends a driverId for a plain driver — the server would ignore it anyway', async () => {
    signInAs('driver', ['delivery.drop.execute']);
    vi.mocked(getMyJobs).mockResolvedValue([]);

    render(<DriverJobsPanel />);

    await waitFor(() => expect(getMyJobs).toHaveBeenCalled());
    expect(vi.mocked(getMyJobs).mock.calls[0]?.[1]).toBeUndefined();
    expect(getDrivers).not.toHaveBeenCalled();
  });
});
