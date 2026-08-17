import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PayrollStatutoryCard } from './PayrollStatutoryCard';
import { useSessionStore } from '@/stores/session-store';
import { api } from '@/lib/api';

/**
 * The wizard's gating logic (D-18/Amendment 1) is the non-trivial piece here:
 * the "Aktifkan" action must stay disabled until the backend's own
 * completeness check (`GET /api/payroll/statutory/status` → `ready`) says so,
 * and the action itself must not render at all for a caller who lacks
 * `payroll.statutory.enable` (Owner/Manager only per the RBAC matrix — this
 * card is UI convenience, the server is the real gate on the POST).
 */
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, api: { ...actual.api, get: vi.fn(), post: vi.fn() } };
});

function setPermissions(permissions: string[]) {
  useSessionStore.setState({
    user: {
      id: 'u1', username: 'owner1', name: 'Owner Satu', roleKey: 'owner',
      permissions, locations: [], employeeId: null, mustSetPin: false,
    },
  });
}

describe('PayrollStatutoryCard', () => {
  beforeEach(() => {
    useSessionStore.setState({ accessToken: null, refreshToken: null, user: null });
    vi.mocked(api.get).mockReset();
    vi.mocked(api.post).mockReset();
  });

  it('disables the enable action while the wizard reports not ready, and lists what is missing', async () => {
    setPermissions(['payroll.statutory.read', 'payroll.statutory.enable']);
    vi.mocked(api.get).mockResolvedValue({
      enabled: false, ready: false, enabledAt: null, enabledBy: null,
      missing: ['bpjs_configs', 'employee_tax_profiles'],
      profileCoverage: { withProfile: 2, total: 10 },
    });

    render(<PayrollStatutoryCard />);

    const button = await screen.findByRole('button', { name: 'Aktifkan Mode Statutori' });
    expect(button).toBeDisabled();
    expect(screen.getByText('Belum Lengkap')).toBeInTheDocument();
    expect(screen.getByText('Tarif BPJS belum diatur')).toBeInTheDocument();
    expect(screen.getByText('Profil pajak pegawai belum lengkap')).toBeInTheDocument();
  });

  it('enables the action once the wizard reports ready', async () => {
    setPermissions(['payroll.statutory.read', 'payroll.statutory.enable']);
    vi.mocked(api.get).mockResolvedValue({
      enabled: false, ready: true, enabledAt: null, enabledBy: null,
      missing: [], profileCoverage: { withProfile: 10, total: 10 },
    });

    render(<PayrollStatutoryCard />);

    const button = await screen.findByRole('button', { name: 'Aktifkan Mode Statutori' });
    expect(button).not.toBeDisabled();
    expect(screen.getByText('Siap Diaktifkan')).toBeInTheDocument();
  });

  it('renders no enable/disable action at all without payroll.statutory.enable', async () => {
    setPermissions(['payroll.statutory.read']);
    vi.mocked(api.get).mockResolvedValue({
      enabled: false, ready: true, enabledAt: null, enabledBy: null,
      missing: [], profileCoverage: { withProfile: 10, total: 10 },
    });

    render(<PayrollStatutoryCard />);

    await screen.findByText('Siap Diaktifkan');
    expect(screen.queryByRole('button', { name: 'Aktifkan Mode Statutori' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Nonaktifkan' })).not.toBeInTheDocument();
  });

  it('shows the disable action, not enable, once statutory mode is already enabled', async () => {
    setPermissions(['payroll.statutory.read', 'payroll.statutory.enable']);
    vi.mocked(api.get).mockResolvedValue({
      enabled: true, ready: true, enabledAt: '2026-01-01T00:00:00Z', enabledBy: 'Owner Satu',
      missing: [], profileCoverage: { withProfile: 10, total: 10 },
    });

    render(<PayrollStatutoryCard />);

    expect(await screen.findByRole('button', { name: 'Nonaktifkan' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Aktifkan Mode Statutori' })).not.toBeInTheDocument();
  });
});
