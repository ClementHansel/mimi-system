import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { AssetRegisterPanel } from './AssetRegisterPanel';
import { useSessionStore } from '@/stores/session-store';
import * as api from './lib/assets-api';

/**
 * THE ASSET DETAIL DIALOG NEVER LISTED ITS MAINTENANCE JOBS.
 *
 * MA-188: "Ketika Buat Tugas Perbaikan di halaman Aset & Maintenance > Daftar
 * Aset > Detail Aset, data tugas perbaikan tidak tampil di popup detail aset
 * tersebut."
 *
 * Not a refresh bug — there was nothing to refresh. That section of the dialog
 * was a heading and a button and then `</div>`: no list, no fetch, ever. The
 * heading also reused `assets.jobs.newCorrective` — the label of the button
 * beside it — so the section rendered as the words "Buat Tugas Perbaikan"
 * twice with empty space under them.
 *
 * `getJobs({ assetId })` had existed all along and the backend had always
 * honoured the filter (`jobs.service.ts`); nothing called it. And
 * `CreateJobModal.onCreated` only called `onChanged()`, which reloads the asset
 * TABLE behind the dialog — so even with a list, creating a job would not have
 * updated it.
 */
vi.mock('./lib/assets-api', () => ({
  getAssets: vi.fn(),
  getSchedules: vi.fn(),
  getAssetHistory: vi.fn(),
  getJobs: vi.fn(),
  createJob: vi.fn(),
  createAsset: vi.fn(),
  updateAsset: vi.fn(),
  createSchedule: vi.fn(),
  listLocationCodesByName: vi.fn(),
  listEmployeeNumbersByName: vi.fn(),
}));

vi.mock('@/components/admin/MasterDataIo', () => ({
  MasterDataIo: () => <div data-testid="master-data-io" />,
}));

vi.mock('@/lib/permissions', () => ({
  usePermissions: () => ({ can: () => true }),
  PermissionGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const ASSET = {
  id: 'asset-1',
  assetNumber: 'AST-0001',
  name: 'Freezer Chest 500L',
  category: 'equipment',
  locationName: 'Outlet Satu',
  locationId: 'loc-1',
  serialNumber: null,
  brand: null,
  model: null,
  condition: 'good',
  status: 'active',
  purchaseDate: null,
  purchasePrice: null,
  assignedToName: null,
  photoUrl: null,
};

const JOB = {
  id: 'job-1',
  jobNumber: 'MJ/202609/0007',
  assetName: 'Freezer Chest 500L',
  type: 'corrective',
  scheduleName: null,
  status: 'due',
  dueDate: '2026-09-08',
  assignedToName: 'Ayu Rahayu',
  completedAt: null,
  cost: null,
  proofUrls: [],
};

function jobsPage(rows: (typeof JOB)[]) {
  return { rows, total: rows.length, page: 1, pageSize: 100 };
}

describe('AssetRegisterPanel — the maintenance jobs on an asset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSessionStore.setState({
      user: {
        id: 'u1',
        username: 'kg1',
        name: 'Kepala Gudang',
        roleKey: 'kepala_gudang',
        permissions: ['asset.read', 'asset.manage', 'asset.job.execute'],
        locations: [{ id: 'loc-1', name: 'Outlet Satu', code: 'OUT1' }],
      },
    } as never);
    vi.mocked(api.getAssets).mockResolvedValue({
      rows: [ASSET],
      total: 1,
      page: 1,
      pageSize: 100,
    } as never);
    vi.mocked(api.getSchedules).mockResolvedValue([] as never);
    vi.mocked(api.getAssetHistory).mockResolvedValue({ rows: [] } as never);
    vi.mocked(api.getJobs).mockResolvedValue(jobsPage([JOB]) as never);
    vi.mocked(api.listLocationCodesByName).mockResolvedValue(new Map() as never);
    vi.mocked(api.listEmployeeNumbersByName).mockResolvedValue(new Map() as never);
    vi.mocked(api.createJob).mockResolvedValue({ id: 'job-2' } as never);
  });
  afterEach(() => useSessionStore.setState({ user: null } as never));

  async function openDetail() {
    render(<AssetRegisterPanel />);
    fireEvent.click(await screen.findByText('Freezer Chest 500L'));
    return within(await screen.findByRole('dialog'));
  }

  it('asks the server for this asset’s jobs and shows them', async () => {
    const dialog = await openDetail();

    await waitFor(() => expect(api.getJobs).toHaveBeenCalledWith({ assetId: 'asset-1' }));
    // The reported symptom: this row simply did not exist on screen.
    expect(await dialog.findByText('MJ/202609/0007')).toBeInTheDocument();
    expect(dialog.getByText(/Ayu Rahayu/)).toBeInTheDocument();
  });

  it('heads the section for the LIST, not with the button beside it', async () => {
    const dialog = await openDetail();

    // The old heading was `newCorrective`, identical to the button's own
    // label, which is why the section read as a duplicated button.
    expect(await dialog.findByText('Tugas Maintenance & Perbaikan')).toBeInTheDocument();
    expect(dialog.getAllByText('Buat Tugas Perbaikan')).toHaveLength(1);
  });

  it('says so plainly when the asset has no jobs', async () => {
    vi.mocked(api.getJobs).mockResolvedValue(jobsPage([]) as never);
    const dialog = await openDetail();

    expect(
      await dialog.findByText(/Belum ada tugas maintenance atau perbaikan untuk aset ini/),
    ).toBeInTheDocument();
  });

  it('re-reads the list after a job is created, not just the table behind it', async () => {
    const dialog = await openDetail();
    await waitFor(() => expect(api.getJobs).toHaveBeenCalledTimes(1));

    fireEvent.click(dialog.getByRole('button', { name: 'Buat Tugas Perbaikan' }));

    // The create form nests INSIDE the detail dialog, so both carry role
    // "dialog" — query its own unique field instead of the role.
    const description = await screen.findByLabelText(/Deskripsi Kerusakan/i);
    fireEvent.change(description, { target: { value: 'Kompresor tidak dingin' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ajukan' }));

    await waitFor(() => expect(api.createJob).toHaveBeenCalled());
    // `onChanged()` alone reloaded the asset TABLE. The dialog's own list has
    // to be re-read too, or the job the user just created stays invisible —
    // which is the bug as reported.
    await waitFor(() => expect(api.getJobs).toHaveBeenCalledTimes(2));
  });
});
