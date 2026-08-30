import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RosterPanel } from './RosterPanel';
import { useSessionStore } from '@/stores/session-store';
import { api } from '@/lib/api';

/**
 * `Jadwal Shift` — specifically the TEMPLATE editor added 2026-08-30
 * (`PATCH /hr/shifts/:id`, which had no UI until then).
 *
 * Three rules, all of which are silent when broken:
 *
 *  - a timing edit NEVER carries `locationId`. The panel lists this outlet's
 *    shifts alongside the company-wide ones, so a stray scope field would
 *    let an outlet annex a template every other location rosters against —
 *    and nothing on screen would say so.
 *  - editing a company-wide template asks first, because its blast radius is
 *    every location rather than the one in the picker.
 *  - a day already rostered onto a DEACTIVATED template stays selectable.
 *    `listShifts` filters `is_active`, `getRoster` does not, so without the
 *    orphan option a native `<select>` renders that cell blank — a schedule
 *    screen quietly claiming nobody is on shift.
 */
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    api: { ...actual.api, get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn() },
  };
});

const LOC = 'l1';

function setPermissions(permissions: string[]) {
  useSessionStore.setState({
    user: {
      id: 'u1',
      username: 'hr1',
      name: 'HR Admin',
      roleKey: 'hr_admin',
      permissions,
      locations: [{ id: LOC, name: 'Gudang Pusat Balikpapan' }],
      employeeId: null,
      mustSetPin: false,
    },
  });
}

const OUTLET_SHIFT = {
  id: 's1',
  name: 'Pagi',
  locationId: LOC,
  startTime: '08:00',
  endTime: '16:00',
  breakMinutes: 60,
};

/** `location_id IS NULL` — the company-wide template. */
const GLOBAL_SHIFT = {
  id: 's2',
  name: 'Malam',
  locationId: null,
  startTime: '16:00',
  endTime: '23:30',
  breakMinutes: 45,
};

function mockApi(shifts: Record<string, unknown>[], rosterDays: Record<string, unknown>[] = []) {
  vi.mocked(api.get).mockImplementation((path: string) => {
    if (path.startsWith('/hr/shifts')) return Promise.resolve(shifts);
    if (path.startsWith('/hr/roster')) {
      return Promise.resolve([
        { employeeId: 'e1', employeeName: 'Budi Santoso', days: rosterDays },
      ]);
    }
    if (path.startsWith('/locations')) {
      return Promise.resolve({ rows: [{ id: LOC, name: 'Gudang Pusat Balikpapan', code: 'BPP' }] });
    }
    return Promise.resolve([]);
  });
  vi.mocked(api.patch).mockResolvedValue({});
}

describe('RosterPanel shift templates', () => {
  beforeEach(() => {
    useSessionStore.setState({ accessToken: null, refreshToken: null, user: null });
    vi.mocked(api.get).mockReset();
    vi.mocked(api.patch).mockReset();
  });

  it('saves a timing edit through PATCH, and never sends locationId with it', async () => {
    setPermissions(['hr.shift.read', 'hr.shift.manage']);
    mockApi([OUTLET_SHIFT]);
    render(<RosterPanel />);

    const end = await screen.findByDisplayValue('16:00');
    fireEvent.change(end, { target: { value: '15:00' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Simpan' })[1]!);

    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    expect(api.patch).toHaveBeenCalledWith('/hr/shifts/s1', {
      name: 'Pagi',
      startTime: '08:00',
      endTime: '15:00',
      breakMinutes: 60,
    });
  });

  it('asks before editing a company-wide template', async () => {
    setPermissions(['hr.shift.read', 'hr.shift.manage']);
    mockApi([GLOBAL_SHIFT]);
    render(<RosterPanel />);

    const end = await screen.findByDisplayValue('23:30');
    fireEvent.change(end, { target: { value: '23:00' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Simpan' })[1]!);

    // Nothing has been sent yet — the confirmation is a gate, not a notice.
    expect(await screen.findByText('Ubah template milik semua lokasi?')).toBeInTheDocument();
    expect(api.patch).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole('button', { name: 'Simpan' }).at(-1)!);
    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    expect(api.patch).toHaveBeenCalledWith(
      '/hr/shifts/s2',
      expect.objectContaining({
        endTime: '23:00',
      }),
    );
    expect(vi.mocked(api.patch).mock.calls[0]![1]).not.toHaveProperty('locationId');
  });

  it('deactivates rather than deletes, after confirming', async () => {
    setPermissions(['hr.shift.read', 'hr.shift.manage']);
    mockApi([OUTLET_SHIFT]);
    render(<RosterPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Nonaktifkan' }));
    expect(await screen.findByText('Nonaktifkan template shift?')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Nonaktifkan' }).at(-1)!);

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/hr/shifts/s1', { isActive: false }),
    );
    // Deactivate is the ONLY write it makes — never a delete, because
    // `shift_assignments` keeps pointing at the row.
    expect(vi.mocked(api.patch)).toHaveBeenCalledTimes(1);
  });

  it('is read-only without hr.shift.manage', async () => {
    setPermissions(['hr.shift.read']);
    mockApi([OUTLET_SHIFT]);
    render(<RosterPanel />);

    await screen.findByDisplayValue('Pagi');
    expect(screen.queryByRole('button', { name: 'Nonaktifkan' })).not.toBeInTheDocument();
    expect(screen.getByDisplayValue('Pagi')).toBeDisabled();
  });

  it('keeps a day rostered onto a deactivated template selectable', async () => {
    setPermissions(['hr.shift.read', 'hr.shift.manage']);
    // `s9` is gone from /hr/shifts (deactivated) but the roster still points
    // at it — exactly what deactivating a template leaves behind.
    mockApi([OUTLET_SHIFT], [{ date: '2026-08-24', workShiftId: 's9', shiftName: 'Sore' }]);
    render(<RosterPanel />);

    // One per day column of the week — the orphan is offered on all of them.
    expect(await screen.findAllByRole('option', { name: 'Sore (Nonaktif)' })).toHaveLength(7);
  });
});
