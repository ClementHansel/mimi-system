import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MaintenanceDuePanel } from './MaintenanceDuePanel';
import { MaintenanceJobsPanel } from './MaintenanceJobsPanel';
import { useSessionStore } from '@/stores/session-store';
import * as api from './lib/assets-api';

/**
 * A PREVENTIVE SCHEDULE MUST NOT PRODUCE A REPAIR JOB.
 *
 * MA-189, item 1: "Saat menambahkan Jadwal Perawatan, akan masuk ke sub menu
 * jatuh tempo. Ketika klik mulai kerjakan di sub menu jatuh tempo akan masuk ke
 * sub menu tugas maintenance. Tapi di sub menu Tugas Maintenance ini Jenis nya
 * perbaikan dan tidak tau mana yang Jadwal Perawatan."
 *
 * That was a data defect, not a labelling one. `MaintenanceDueSweepService`
 * creates a schedule's job as `type='scheduled'` with `schedule_id` set — but
 * only inside `reminder_days_before`, and only when its 6-hour timer has
 * fired. `GET maintenance/due` lists everything due within the chosen window
 * and never creates a job itself, so a schedule legitimately appears there
 * with `jobId: null`.
 *
 * The panel filled that gap with `createJob`, whose DTO is
 * `@IsIn(['corrective'])` on purpose ("scheduled jobs are scheduler-born, only
 * corrective is client-created"). So starting work on a preventive schedule
 * minted a CORRECTIVE job with `schedule_id` NULL: wrong type, and no link
 * back to the schedule. In Tugas Maintenance it was then indistinguishable
 * from a genuine breakdown repair — which is precisely what was reported.
 *
 * The regression these pin is that the fallback goes through the endpoint
 * where the SCHEDULE is the argument, so the type and the link follow from the
 * data instead of being asserted by the client.
 */
vi.mock('./lib/assets-api', () => ({
  getMaintenanceDue: vi.fn(),
  startJob: vi.fn(),
  ensureScheduleJob: vi.fn(),
  createJob: vi.fn(),
  getJobs: vi.fn(),
  verifyJob: vi.fn(),
}));

vi.mock('./CompleteJobModal', () => ({
  CompleteJobModal: () => <div data-testid="complete-job-modal" />,
}));

vi.mock('@/lib/permissions', () => ({
  usePermissions: () => ({ can: () => true }),
  PermissionGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const DUE_NO_JOB = {
  jobId: null,
  scheduleId: 'sched-1',
  assetId: 'asset-1',
  assetName: 'Freezer Chest 500L',
  locationName: 'Outlet Satu',
  name: 'Ganti Oli Kompresor',
  dueDate: '2026-09-05',
  overdue: true,
};

function setUser() {
  useSessionStore.setState({
    user: {
      id: 'u1',
      username: 'kg1',
      name: 'Kepala Gudang',
      roleKey: 'kepala_gudang',
      permissions: ['asset.read', 'asset.job.execute'],
      locations: [{ id: 'loc-1', name: 'Outlet Satu', code: 'OUT1' }],
    },
  } as never);
}

describe('MaintenanceDuePanel — starting a due schedule', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setUser();
    vi.mocked(api.startJob).mockResolvedValue({ id: 'job-1' } as never);
    vi.mocked(api.ensureScheduleJob).mockResolvedValue({ jobId: 'job-1', created: true } as never);
  });
  afterEach(() => useSessionStore.setState({ user: null } as never));

  it('materialises the SCHEDULE’s own job, never a corrective one', async () => {
    vi.mocked(api.getMaintenanceDue).mockResolvedValue([DUE_NO_JOB] as never);

    render(<MaintenanceDuePanel />);
    fireEvent.click(await screen.findByRole('button', { name: /Mulai Kerjakan/i }));

    await waitFor(() => expect(api.ensureScheduleJob).toHaveBeenCalledWith('sched-1'));
    // The whole defect in one assertion: `createJob` can only ever produce a
    // repair, and a maintenance schedule is not a repair.
    expect(
      api.createJob,
      'a preventive schedule was turned into a corrective repair job',
    ).not.toHaveBeenCalled();
    expect(api.startJob).toHaveBeenCalledWith('job-1');
  });

  it('starts the existing job directly when the sweep already made one', async () => {
    vi.mocked(api.getMaintenanceDue).mockResolvedValue([
      { ...DUE_NO_JOB, jobId: 'job-existing' },
    ] as never);

    render(<MaintenanceDuePanel />);
    fireEvent.click(await screen.findByRole('button', { name: /Mulai Kerjakan/i }));

    await waitFor(() => expect(api.startJob).toHaveBeenCalledWith('job-existing'));
    // Nothing to materialise — the sweep's row is the one to work on, and
    // minting a second would open two jobs for one cycle.
    expect(api.ensureScheduleJob).not.toHaveBeenCalled();
    expect(api.createJob).not.toHaveBeenCalled();
  });
});

describe('MaintenanceJobsPanel — telling the two kinds apart', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setUser();
    vi.mocked(api.getJobs).mockResolvedValue({
      rows: [
        {
          id: 'job-1',
          jobNumber: 'MJ/202609/0001',
          assetName: 'Freezer Chest 500L',
          type: 'scheduled',
          scheduleName: 'Ganti Oli Kompresor',
          status: 'due',
          dueDate: '2026-09-05',
          assignedToName: null,
          completedAt: null,
          cost: null,
          proofUrls: [],
        },
        {
          id: 'job-2',
          jobNumber: 'MJ/202609/0002',
          assetName: 'Motor Kirim',
          type: 'corrective',
          scheduleName: null,
          status: 'due',
          dueDate: '2026-09-06',
          assignedToName: null,
          completedAt: null,
          cost: null,
          proofUrls: [],
        },
      ],
      total: 2,
      page: 1,
      pageSize: 50,
    } as never);
  });
  afterEach(() => useSessionStore.setState({ user: null } as never));

  it('names the kind AND the schedule behind a preventive job', async () => {
    render(<MaintenanceJobsPanel />);

    // Scoped to the TABLE: both labels are also `<option>`s in the new type
    // filter, so an unscoped query matches twice and proves nothing about the
    // rows.
    const table = within(await screen.findByRole('table'));

    // MA-189, item 2: "Jenis: perbaikan" on every row was the whole problem.
    expect(table.getByText('Perawatan Terjadwal')).toBeInTheDocument();
    expect(table.getByText('Perbaikan')).toBeInTheDocument();
    // …and WHICH Jadwal Perawatan, which is the actual question asked.
    expect(table.getByText('Ganti Oli Kompresor')).toBeInTheDocument();
  });

  it('can filter down to one kind', async () => {
    render(<MaintenanceJobsPanel />);
    await waitFor(() => expect(api.getJobs).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText(/^Jenis$/i), { target: { value: 'scheduled' } });

    await waitFor(() =>
      expect(vi.mocked(api.getJobs).mock.calls.at(-1)![0]).toMatchObject({ type: 'scheduled' }),
    );
  });
});
