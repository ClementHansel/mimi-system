import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PermissionGate } from './PermissionGate';
import { useSessionStore } from '@/stores/session-store';

function setPermissions(permissions: string[]) {
  useSessionStore.setState({
    user: {
      id: 'u1',
      username: 'kasir01',
      name: 'Kasir Satu',
      roleKey: 'kasir',
      permissions,
      locations: [],
      employeeId: null,
      mustSetPin: false,
    },
  });
}

describe('PermissionGate', () => {
  beforeEach(() => {
    useSessionStore.setState({ accessToken: null, refreshToken: null, user: null });
  });

  it('renders children when the user holds the required permission', () => {
    setPermissions(['pos.sale.create']);
    render(
      <PermissionGate permission="pos.sale.create">
        <button>Bayar</button>
      </PermissionGate>,
    );
    expect(screen.getByText('Bayar')).toBeInTheDocument();
  });

  it('renders nothing by default when the permission is missing', () => {
    setPermissions(['pos.sale.create']);
    render(
      <PermissionGate permission="payment.verify">
        <button>Verifikasi Pembayaran</button>
      </PermissionGate>,
    );
    expect(screen.queryByText('Verifikasi Pembayaran')).not.toBeInTheDocument();
  });

  it('renders the fallback when provided and the permission is missing', () => {
    setPermissions([]);
    render(
      <PermissionGate permission="payment.verify" fallback={<span>Tidak tersedia</span>}>
        <button>Verifikasi Pembayaran</button>
      </PermissionGate>,
    );
    expect(screen.getByText('Tidak tersedia')).toBeInTheDocument();
  });

  it('renders the standard "no access" message when showMessage is set', () => {
    setPermissions([]);
    render(
      <PermissionGate permission="payment.verify" showMessage>
        <button>Verifikasi Pembayaran</button>
      </PermissionGate>,
    );
    expect(screen.getByText('Anda tidak memiliki akses ke bagian ini.')).toBeInTheDocument();
  });

  it('treats an array permission as ANY-of', () => {
    setPermissions(['dashboard.outlet.view']);
    render(
      <PermissionGate permission={['dashboard.view', 'dashboard.outlet.view']}>
        <span>Dasbor</span>
      </PermissionGate>,
    );
    expect(screen.getByText('Dasbor')).toBeInTheDocument();
  });

  it('has no permissions with no session user — access denied by default', () => {
    render(
      <PermissionGate permission="user.read">
        <span>Daftar Pengguna</span>
      </PermissionGate>,
    );
    expect(screen.queryByText('Daftar Pengguna')).not.toBeInTheDocument();
  });
});
