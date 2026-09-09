import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { NoShowWorklist } from './NoShowWorklist';
import { useSessionStore } from '@/stores/session-store';
import * as hrApi from './lib/hr-api';
import { toDateInput } from '@/lib/dates';

/**
 * THE ONLY WAY TO RECORD A NO-SHOW — AND THE FRICTION IT HAS TO CARRY.
 *
 * MA-200 ("hasil dari proses payroll tidak menampilkan angka untuk potongan
 * gaji di SDM > Payroll"). The payroll run counts absence as
 * `attendance.status = 'absent'` and nothing in the product ever wrote it: an
 * `attendance` row exists only because somebody checked in, and the correction
 * endpoint updates a row by id, so an employee who never turned up left
 * nothing to correct. `deduction_absence` (POUT-03) was unreachable for
 * everybody.
 *
 * What is asserted here is mostly the RESTRAINT, because that is the part most
 * likely to be quietly loosened later. This screen spends real wages: every
 * day marked here becomes a deduction on the next run. So the tests pin that
 * the reason is mandatory, that select-all cannot reach beyond the rows on
 * screen, and that one refusal does not silently swallow the rest of a batch.
 */
vi.mock('./lib/hr-api', () => ({
  listNoShows: vi.fn(),
  markAbsent: vi.fn(),
}));

vi.mock('@/lib/permissions', () => ({
  usePermissions: () => ({ can: () => true }),
}));

const ROWS = [
  {
    employeeId: 'emp-1',
    employeeNumber: 'EMP0001',
    employeeName: 'Ayu Rahayu',
    locationId: 'loc-1',
    locationName: 'Outlet Satu',
    date: '2026-09-01',
    shiftName: 'Pagi',
    shiftAssignmentId: 'sa-1',
  },
  {
    employeeId: 'emp-2',
    employeeNumber: 'EMP0002',
    employeeName: 'Budi Santoso',
    locationId: 'loc-1',
    locationName: 'Outlet Satu',
    date: '2026-09-02',
    shiftName: 'Siang',
    shiftAssignmentId: 'sa-2',
  },
];

function pageOf(rows: typeof ROWS, total = rows.length) {
  return { rows, total, page: 1, pageSize: 25 };
}

describe('NoShowWorklist', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(hrApi.markAbsent).mockResolvedValue({} as never);
    useSessionStore.setState({
      user: {
        id: 'u1',
        username: 'hr1',
        name: 'HR Admin',
        roleKey: 'hr_admin',
        permissions: ['hr.attendance.read', 'hr.attendance.correct'],
        locations: [{ id: 'loc-1', name: 'Outlet Satu', code: 'OUT1' }],
      },
    } as never);
  });
  afterEach(() => useSessionStore.setState({ user: null } as never));

  it('states how many rostered days have no attendance, and warns that a sync gap looks the same', async () => {
    vi.mocked(hrApi.listNoShows).mockResolvedValue(pageOf(ROWS, 283) as never);

    render(<NoShowWorklist />);

    // The count is the answer to "why is my deduction column zero".
    expect(await screen.findByText(/283 hari kerja tanpa catatan absensi/)).toBeVisible();
    // …and it must not read as "283 people were absent". On this deployment the
    // usual cause is an outbox that has not drained.
    expect(screen.getByText(/belum tersinkron dari perangkat/)).toBeInTheDocument();
  });

  it('asks for the range ending YESTERDAY, never today', async () => {
    vi.mocked(hrApi.listNoShows).mockResolvedValue(pageOf([]) as never);

    render(<NoShowWorklist />);

    await waitFor(() => expect(hrApi.listNoShows).toHaveBeenCalled());
    const { from, to } = vi.mocked(hrApi.listNoShows).mock.calls[0]![0];
    // `toDateInput`, not `toISOString()`. The component works in WITA
    // (Asia/Makassar) and so must this comparison — a UTC "today" agrees with
    // a WITA one only during WITA daytime, and this assertion duly failed the
    // moment the suite ran just after local midnight.
    const today = toDateInput(new Date());
    // A shift still in progress is not a missed one — and the server refuses
    // `>= CURRENT_DATE`, so asking for today could only ever return nothing.
    expect(to < today, `to=${to} must be before today=${today}`).toBe(true);
    expect(from < to).toBe(true);
  });

  it('will not mark anything without a reason', async () => {
    vi.mocked(hrApi.listNoShows).mockResolvedValue(pageOf(ROWS) as never);

    render(<NoShowWorklist />);
    fireEvent.click(await screen.findByLabelText(/Pilih semua di halaman ini/));
    fireEvent.click(screen.getByRole('button', { name: /Tandai Alpha/ }));

    // FR-AUDIT-02, and plain fairness: a deduction from someone's pay is
    // recorded against a named person with a stated reason.
    const confirm = await waitFor(() =>
      screen.getAllByRole('button', { name: /Tandai Alpha/ }).at(-1)!,
    );
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(hrApi.markAbsent).not.toHaveBeenCalled();
  });

  it('names the consequence before marking, then posts one day at a time with the reason', async () => {
    vi.mocked(hrApi.listNoShows).mockResolvedValue(pageOf(ROWS) as never);

    render(<NoShowWorklist />);
    fireEvent.click(await screen.findByLabelText(/Pilih semua di halaman ini/));
    fireEvent.click(screen.getByRole('button', { name: /Tandai Alpha/ }));

    // The confirmation says what this costs, in money terms, not just "are you sure".
    expect(await screen.findByText(/akan memotong gaji/)).toBeInTheDocument();
    // …and lists exactly whose days they are, inside the dialog itself — the
    // names are also in the table behind it, so this has to be scoped.
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText(/Ayu Rahayu/)).toBeInTheDocument();
    expect(dialog.getByText(/Budi Santoso/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/^Alasan/), {
      target: { value: 'Tidak hadir tanpa keterangan' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: /Tandai Alpha/ }).at(-1)!);

    await waitFor(() => expect(hrApi.markAbsent).toHaveBeenCalledTimes(2));
    expect(vi.mocked(hrApi.markAbsent).mock.calls.map(([b]) => b)).toEqual([
      {
        employeeId: 'emp-1',
        date: '2026-09-01',
        correctionReason: 'Tidak hadir tanpa keterangan',
      },
      {
        employeeId: 'emp-2',
        date: '2026-09-02',
        correctionReason: 'Tidak hadir tanpa keterangan',
      },
    ]);
  });

  it('keeps going when the server refuses one day, and reports how many failed', async () => {
    vi.mocked(hrApi.listNoShows).mockResolvedValue(pageOf(ROWS) as never);
    // Each day has its own server-side guard (already recorded, approved leave,
    // not rostered), so a refusal is an ordinary outcome for one row — it must
    // not abandon the rest of a reviewed batch.
    vi.mocked(hrApi.markAbsent)
      .mockRejectedValueOnce(new Error('already recorded'))
      .mockResolvedValueOnce({} as never);

    render(<NoShowWorklist />);
    fireEvent.click(await screen.findByLabelText(/Pilih semua di halaman ini/));
    fireEvent.click(screen.getByRole('button', { name: /Tandai Alpha/ }));
    fireEvent.change(await screen.findByLabelText(/^Alasan/), {
      target: { value: 'Alpha' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: /Tandai Alpha/ }).at(-1)!);

    await waitFor(() => expect(hrApi.markAbsent).toHaveBeenCalledTimes(2));
    // And the list is re-read, so the days that did land leave the worklist.
    await waitFor(() => expect(hrApi.listNoShows).toHaveBeenCalledTimes(2));
  });

  it('select-all covers only the rows on screen, never the whole unseen total', async () => {
    // 283 matching days, 2 rendered. A control that selected all 283 would let
    // one click deduct a day's pay from people the user never looked at.
    vi.mocked(hrApi.listNoShows).mockResolvedValue(pageOf(ROWS, 283) as never);

    render(<NoShowWorklist />);
    const selectAll = await screen.findByLabelText(/Pilih semua di halaman ini \(2\)/);
    fireEvent.click(selectAll);

    expect(screen.getByText(/^2 dipilih$/)).toBeInTheDocument();

    // And it toggles back off rather than only ever selecting.
    fireEvent.click(selectAll);
    expect(screen.getByText(/^0 dipilih$/)).toBeInTheDocument();
  });

  it('drops the selection when the filter changes, so it cannot mark rows that scrolled away', async () => {
    vi.mocked(hrApi.listNoShows).mockResolvedValue(pageOf(ROWS, 283) as never);

    render(<NoShowWorklist />);
    fireEvent.click(await screen.findByLabelText(/Pilih semua di halaman ini/));
    expect(screen.getByText(/^2 dipilih$/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Dari Tanggal/), {
      target: { value: '2026-08-01' },
    });

    await waitFor(() => expect(screen.getByText(/^0 dipilih$/)).toBeInTheDocument());
  });
});
