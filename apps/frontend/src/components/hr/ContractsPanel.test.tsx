import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ContractsPanel } from './ContractsPanel';
import { useSessionStore } from '@/stores/session-store';
import { api } from '@/lib/api';

/**
 * W7 CRUD/import/export/signature follow-up (owner ask, 2026-08-27).
 *
 * The point of these tests, same idiom as every other master-data panel
 * test in this app: the PERMISSION SPLIT (`hr.contract.read`/`.read.own` see
 * the list, `hr.contract.manage` is what allows create/sign/terminate/
 * delete), and the ONE domain rule that is easy to get backwards in the UI —
 * a contract can only be deleted while it is a `draft` with NO recorded
 * signature yet, matching `ContractsService.remove`'s guard exactly. Getting
 * that wrong in either direction (offering delete on a signed/active
 * contract, or never offering it at all) is the kind of bug a glance at the
 * table would not catch.
 *
 * Those actions live in `ContractDetailModal` as of 2026-08-30, reached by
 * clicking the row — so the guards are now asserted per OPENED contract
 * rather than by counting buttons across the table. That is a stronger
 * assertion, not a weaker one: counting proved "one row somewhere offers
 * delete", while opening proves WHICH one does.
 */
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    api: { ...actual.api, get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  };
});

function setPermissions(permissions: string[]) {
  useSessionStore.setState({
    user: {
      id: 'u1',
      username: 'hr1',
      name: 'HR Admin',
      roleKey: 'hr_admin',
      permissions,
      locations: [],
      employeeId: null,
      mustSetPin: false,
    },
  });
}

const DRAFT_UNSIGNED = {
  id: 'c1',
  contractNumber: 'KONTRAK/202601/0001',
  employeeId: 'e1',
  employeeName: 'Budi Santoso',
  employeeNumber: 'EMP001',
  contractType: 'pkwt',
  position: 'Kasir',
  locationId: null,
  locationName: null,
  baseSalary: '3500000.00',
  startDate: '2026-01-01',
  endDate: '2026-12-31',
  status: 'draft',
  signedAt: null,
  documentAttachmentId: null,
  terminationReason: null,
  notes: null,
  daysUntilExpiry: null,
  employeeSigned: false,
  companySignerCount: 0,
  fullySigned: false,
};

const ACTIVE_FULLY_SIGNED = {
  ...DRAFT_UNSIGNED,
  id: 'c2',
  contractNumber: 'KONTRAK/202601/0002',
  status: 'active',
  employeeSigned: true,
  companySignerCount: 1,
  fullySigned: true,
  daysUntilExpiry: 45,
};

function mockApiGet(rows: Record<string, unknown>[]) {
  vi.mocked(api.get).mockImplementation((path: string) => {
    if (path.startsWith('/hr/contracts?')) {
      return Promise.resolve({ rows, total: rows.length, page: 1, pageSize: 50 });
    }
    if (path.startsWith('/hr/employees')) {
      return Promise.resolve({ rows: [], total: 0, page: 1, pageSize: 50 });
    }
    if (path.startsWith('/locations')) {
      return Promise.resolve({ rows: [] });
    }
    return Promise.resolve([]);
  });
}

describe('ContractsPanel', () => {
  beforeEach(() => {
    useSessionStore.setState({ accessToken: null, refreshToken: null, user: null });
    vi.mocked(api.get).mockReset();
  });

  it('lists contracts and shows the signed/outstanding state per row', async () => {
    setPermissions(['hr.contract.read']);
    mockApiGet([DRAFT_UNSIGNED, ACTIVE_FULLY_SIGNED]);
    render(<ContractsPanel />);

    expect(await screen.findByText('KONTRAK/202601/0001')).toBeInTheDocument();
    expect(screen.getByText('KONTRAK/202601/0002')).toBeInTheDocument();
    // Fully signed vs. still-outstanding read differently.
    expect(screen.getByText('Lengkap')).toBeInTheDocument();
    expect(screen.getByText('Belum lengkap')).toBeInTheDocument();
  });

  it('opens the contract detail on a row click, with the fields the list drops', async () => {
    setPermissions(['hr.contract.read']);
    mockApiGet([DRAFT_UNSIGNED]);
    render(<ContractsPanel />);

    fireEvent.click(await screen.findByText('KONTRAK/202601/0001'));

    expect(await screen.findByText('Kontrak KONTRAK/202601/0001')).toBeInTheDocument();
    // Jabatan and Gaji Pokok are not columns any more — the dialog is the
    // only place they are readable, so their absence here would mean the
    // trimmed table simply lost them.
    expect(screen.getByText('Kasir')).toBeInTheDocument();
    expect(screen.getByText('Rp3.500.000')).toBeInTheDocument();
  });

  it('hides create, sign, terminate and delete without hr.contract.manage', async () => {
    setPermissions(['hr.contract.read']);
    mockApiGet([DRAFT_UNSIGNED]);
    render(<ContractsPanel />);

    // Opened, not just listed: the actions moved into the detail dialog, so
    // asserting against the closed table would pass for the wrong reason.
    fireEvent.click(await screen.findByText('KONTRAK/202601/0001'));
    await screen.findByText('Kontrak KONTRAK/202601/0001');
    expect(screen.queryByRole('button', { name: 'Buat Kontrak' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Catat Tanda Tangan/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Hapus/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Ubah/ })).not.toBeInTheDocument();
  });

  it('shows create with hr.contract.manage', async () => {
    setPermissions(['hr.contract.read', 'hr.contract.manage']);
    mockApiGet([DRAFT_UNSIGNED]);
    render(<ContractsPanel />);

    await screen.findByText('KONTRAK/202601/0001');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Buat Kontrak' })).toBeInTheDocument(),
    );
  });

  it('offers delete for a draft with no signature, never for an active fully-signed one', async () => {
    setPermissions(['hr.contract.read', 'hr.contract.manage']);
    mockApiGet([DRAFT_UNSIGNED, ACTIVE_FULLY_SIGNED]);
    render(<ContractsPanel />);

    fireEvent.click(await screen.findByText('KONTRAK/202601/0001'));
    await screen.findByText('Kontrak KONTRAK/202601/0001');
    expect(screen.getByRole('button', { name: /Hapus/ })).toBeInTheDocument();
    // Two controls share the name: `Modal`'s header X and the footer
    // button. Either closes it; take the first.
    fireEvent.click(screen.getAllByRole('button', { name: 'Tutup' })[0]!);

    // The active, fully-signed contract offers no delete at all.
    // `ContractsService.remove` refuses it server side; this proves the
    // button is never presented for it either.
    fireEvent.click(screen.getByText('KONTRAK/202601/0002'));
    await screen.findByText('Kontrak KONTRAK/202601/0002');
    expect(screen.queryByRole('button', { name: /Hapus/ })).not.toBeInTheDocument();
  });

  it('offers terminate only for an active contract', async () => {
    setPermissions(['hr.contract.read', 'hr.contract.manage']);
    mockApiGet([DRAFT_UNSIGNED, ACTIVE_FULLY_SIGNED]);
    render(<ContractsPanel />);

    fireEvent.click(await screen.findByText('KONTRAK/202601/0001'));
    await screen.findByText('Kontrak KONTRAK/202601/0001');
    expect(screen.queryByRole('button', { name: /Putus Kontrak/ })).not.toBeInTheDocument();
    // Two controls share the name: `Modal`'s header X and the footer
    // button. Either closes it; take the first.
    fireEvent.click(screen.getAllByRole('button', { name: 'Tutup' })[0]!);

    fireEvent.click(screen.getByText('KONTRAK/202601/0002'));
    await screen.findByText('Kontrak KONTRAK/202601/0002');
    expect(screen.getByRole('button', { name: /Putus Kontrak/ })).toBeInTheDocument();
  });
});
