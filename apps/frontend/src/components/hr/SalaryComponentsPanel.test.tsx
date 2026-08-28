import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { SalaryComponentsPanel } from './SalaryComponentsPanel';
import { useSessionStore } from '@/stores/session-store';
import { api } from '@/lib/api';

/**
 * The salary component MASTER (`payroll.component.manage`) plus per-employee
 * assignment (PIN-03..06). The point of these tests is the two rules the
 * server enforces and the UI must never let someone attempt anyway
 * (`ComponentsService.update`, `UpdateComponentDto`):
 *
 *  - `type`/`calcMethod` cannot change after a component is created — the
 *    edit form shows them as read-only text, and the update request never
 *    carries either key.
 *  - a system component's `name` cannot change at all — the edit form shows
 *    it as read-only text for those rows, and the update request omits
 *    `name` entirely (not just "unchanged") for a system row.
 *
 * Plus the ordinary permission split every other master-data panel in this
 * app is tested for: `payroll.read` sees the list, `payroll.component.manage`
 * is what allows creating/editing/assigning.
 */
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    api: { ...actual.api, get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn() },
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

const SYSTEM_COMPONENT = {
  id: 'c1',
  code: 'base_salary',
  name: 'Gaji Pokok',
  type: 'earning',
  calcMethod: 'fixed',
  formulaKey: null,
  defaultAmount: '5000000.00',
  isSystem: true,
  isActive: true,
};

const CUSTOM_COMPONENT = {
  id: 'c2',
  code: 'tunjangan_transport',
  name: 'Tunjangan Transport',
  type: 'earning',
  calcMethod: 'fixed',
  formulaKey: null,
  defaultAmount: null,
  isSystem: false,
  isActive: true,
};

const EMPLOYEE = {
  id: 'e1',
  employeeNumber: 'EMP-001',
  userId: null,
  name: 'Budi Santoso',
  position: 'Kasir',
  locationId: 'l1',
  locationName: 'Outlet A',
  employmentStatus: 'active',
  joinDate: '2024-01-01',
  phone: null,
  nik: null,
  email: null,
};

function mockGetDefault() {
  vi.mocked(api.get).mockImplementation((path: string) => {
    if (path === '/payroll/components') {
      return Promise.resolve([SYSTEM_COMPONENT, CUSTOM_COMPONENT]);
    }
    if (path.startsWith('/hr/employees')) {
      return Promise.resolve({ rows: [EMPLOYEE], total: 1, page: 1, pageSize: 50 });
    }
    if (path.startsWith('/payroll/employees/')) {
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  });
}

describe('SalaryComponentsPanel', () => {
  beforeEach(() => {
    useSessionStore.setState({ accessToken: null, refreshToken: null, user: null });
    vi.mocked(api.get).mockReset();
    vi.mocked(api.post).mockReset();
    vi.mocked(api.patch).mockReset();
    vi.mocked(api.put).mockReset();
    mockGetDefault();
  });

  it('lists salary components with their type, calc method and status', async () => {
    setPermissions(['payroll.read']);
    render(<SalaryComponentsPanel />);

    expect(await screen.findByText('Gaji Pokok')).toBeInTheDocument();
    expect(screen.getByText('Tunjangan Transport')).toBeInTheDocument();
    // The seeded system component is badged; the custom one is not.
    expect(screen.getByText('Sistem')).toBeInTheDocument();
    expect(screen.getAllByText('Pendapatan').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Tetap').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Aktif').length).toBeGreaterThan(0);
  });

  it('hides create and edit access without payroll.component.manage', async () => {
    setPermissions(['payroll.read']);
    render(<SalaryComponentsPanel />);

    await screen.findByText('Gaji Pokok');
    expect(screen.queryByRole('button', { name: 'Tambah Komponen' })).not.toBeInTheDocument();

    // A row click is a no-op — no edit modal opens.
    fireEvent.click(screen.getByText('Tunjangan Transport'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows create with payroll.component.manage, and create only ever offers earning/deduction', async () => {
    setPermissions(['payroll.read', 'payroll.component.manage']);
    render(<SalaryComponentsPanel />);

    await screen.findByText('Gaji Pokok');
    fireEvent.click(screen.getByRole('button', { name: 'Tambah Komponen' }));

    const dialog = await screen.findByRole('dialog');
    // Create mode: type/calcMethod ARE editable selects, and the type select
    // never offers 'employer_cost' — `CreateComponentDto` cannot create one.
    const typeSelect = within(dialog).getByLabelText('Jenis') as HTMLSelectElement;
    const typeOptionValues = Array.from(typeSelect.options).map((o) => o.value);
    expect(typeOptionValues).toEqual(expect.arrayContaining(['earning', 'deduction']));
    expect(typeOptionValues).not.toContain('employer_cost');
  });

  it('editing a non-system component never submits type or calcMethod, and lets the name change', async () => {
    setPermissions(['payroll.read', 'payroll.component.manage']);
    render(<SalaryComponentsPanel />);

    await screen.findByText('Gaji Pokok');
    fireEvent.click(screen.getByText('Tunjangan Transport'));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Ubah Komponen — Tunjangan Transport')).toBeInTheDocument();

    // type/calcMethod are read-only text in edit mode — no combobox at all.
    expect(within(dialog).queryAllByRole('combobox')).toHaveLength(0);
    expect(within(dialog).getByText('Pendapatan')).toBeInTheDocument();
    expect(within(dialog).getByText('Tetap')).toBeInTheDocument();

    // name IS an editable field for a non-system component.
    const nameInput = within(dialog).getByLabelText(/^Nama/) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'Tunjangan Transport Baru' } });

    vi.mocked(api.patch).mockResolvedValue({
      ...CUSTOM_COMPONENT,
      name: 'Tunjangan Transport Baru',
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Simpan' }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    const [path, body] = vi.mocked(api.patch).mock.calls[0]!;
    expect(path).toBe('/payroll/components/c2');
    expect(body).not.toHaveProperty('type');
    expect(body).not.toHaveProperty('calcMethod');
    expect(body).toMatchObject({ name: 'Tunjangan Transport Baru' });
  });

  it('a system component shows its name as read-only and never submits name at all', async () => {
    setPermissions(['payroll.read', 'payroll.component.manage']);
    render(<SalaryComponentsPanel />);

    await screen.findByText('Gaji Pokok');
    fireEvent.click(screen.getByText('Gaji Pokok'));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Ubah Komponen — Gaji Pokok')).toBeInTheDocument();
    // No editable "Nama" field for a system row.
    expect(within(dialog).queryByLabelText(/^Nama/)).not.toBeInTheDocument();

    vi.mocked(api.patch).mockResolvedValue(SYSTEM_COMPONENT);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Simpan' }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    const [path, body] = vi.mocked(api.patch).mock.calls[0]!;
    expect(path).toBe('/payroll/components/c1');
    expect(body).not.toHaveProperty('name');
    expect(body).not.toHaveProperty('type');
    expect(body).not.toHaveProperty('calcMethod');
  });

  it('lets an employee be selected and their assigned components loaded', async () => {
    setPermissions(['payroll.read', 'payroll.component.manage']);
    vi.mocked(api.get).mockImplementation((path: string) => {
      if (path === '/payroll/components') {
        return Promise.resolve([SYSTEM_COMPONENT, CUSTOM_COMPONENT]);
      }
      if (path.startsWith('/hr/employees')) {
        return Promise.resolve({ rows: [EMPLOYEE], total: 1, page: 1, pageSize: 50 });
      }
      if (path.startsWith('/payroll/employees/e1/components')) {
        return Promise.resolve([
          {
            componentId: 'c2',
            code: 'tunjangan_transport',
            amount: '250000.00',
            effectiveFrom: '2026-01-01',
            effectiveTo: null,
          },
        ]);
      }
      return Promise.resolve([]);
    });
    render(<SalaryComponentsPanel />);

    await screen.findByText('Gaji Pokok');
    fireEvent.click(screen.getByLabelText('Pilih Pegawai'));
    fireEvent.click(await screen.findByText('Budi Santoso'));

    expect(
      await screen.findByText('Tunjangan Transport (tunjangan_transport)'),
    ).toBeInTheDocument();
    expect(screen.getByText('Rp250.000')).toBeInTheDocument();
  });
});
