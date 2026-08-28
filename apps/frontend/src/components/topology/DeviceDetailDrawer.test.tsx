import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DeviceDetailDrawer } from './DeviceDetailDrawer';
import { useSessionStore } from '@/stores/session-store';
import { updateDevice, unpairDevice, retireDevice } from './lib/device-api';
import type { TopologyDevice, TopologyLocation } from './lib/types';

/**
 * Owner: "there is no way to add devices and settings network etc." — this
 * covers the OTHER half, device management (rename/recategorise/move/unpair/
 * retire) surfaced from `DeviceDetailDrawer`. All four write actions are
 * gated on `device.manage`, matching `devices.controller.ts`'s own
 * `@RequirePermission('device.manage')` — the point of these tests is that
 * gate (a role without it never sees the section, not just disabled
 * buttons) and that the two destructive actions (unpair/retire) require an
 * explicit confirm before calling the API.
 */
vi.mock('./lib/device-api', () => ({
  updateDevice: vi.fn(),
  unpairDevice: vi.fn(),
  retireDevice: vi.fn(),
}));

function setPermissions(permissions: string[]) {
  useSessionStore.setState({
    user: {
      id: 'u1',
      username: 'owner1',
      name: 'Owner',
      roleKey: 'owner',
      permissions,
      locations: [],
      employeeId: null,
      mustSetPin: false,
    },
  });
}

const LOCATIONS = [
  { id: 'loc-a', name: 'Outlet Balikpapan Baru' },
  { id: 'loc-b', name: 'Outlet Samarinda' },
];

function device(overrides: Partial<TopologyDevice> = {}): TopologyDevice {
  return {
    id: 'd1',
    name: 'Tablet Kasir 1',
    category: 'tablet',
    status: 'online',
    appVersion: '1.4.0',
    queueDepth: 0,
    lastSeenAt: new Date().toISOString(),
    ipAddress: '10.0.0.5',
    ...overrides,
  };
}

function location(overrides: Partial<TopologyLocation> = {}): TopologyLocation {
  return {
    location: {
      id: 'loc-a',
      code: 'OUT1',
      name: 'Outlet Balikpapan Baru',
      type: 'outlet',
      city: 'X',
    },
    nodeEnabled: false,
    node: null,
    devices: [],
    counts: { online: 1, stale: 0, offline: 0, total: 1 },
    syncHealth: {
      queueDepth: 0,
      quarantineDepth: 0,
      lastSyncAt: null,
      conflictsOpen: 0,
      exceptionsOpen: 0,
      offlineAuthPending: 0,
    },
    outletStatus: 'online',
    ...overrides,
  };
}

describe('DeviceDetailDrawer — management gating', () => {
  beforeEach(() => {
    useSessionStore.setState({ accessToken: null, refreshToken: null, user: null });
    vi.mocked(updateDevice).mockReset();
    vi.mocked(unpairDevice).mockReset();
    vi.mocked(retireDevice).mockReset();
  });

  it('does not render the management section for a role without device.manage', () => {
    setPermissions(['device.read']);
    render(
      <DeviceDetailDrawer
        device={device()}
        location={location()}
        locations={LOCATIONS}
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.queryByText('Kelola Perangkat')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Lepas Pasangan' })).not.toBeInTheDocument();
  });

  it('renders rename/recategorise/move with device.manage, disables Save until dirty, and saves via updateDevice', async () => {
    setPermissions(['device.read', 'device.manage']);
    const onChanged = vi.fn();
    vi.mocked(updateDevice).mockResolvedValue({
      ...device(),
      name: 'Tablet Kasir 1 (renamed)',
    } as never);

    render(
      <DeviceDetailDrawer
        device={device()}
        location={location()}
        locations={LOCATIONS}
        onClose={vi.fn()}
        onChanged={onChanged}
      />,
    );

    expect(screen.getByText('Kelola Perangkat')).toBeInTheDocument();
    const saveButton = screen.getByRole('button', { name: 'Simpan Perubahan' });
    expect(saveButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Nama Perangkat'), {
      target: { value: 'Tablet Kasir 1 (renamed)' },
    });
    expect(saveButton).toBeEnabled();

    fireEvent.click(saveButton);

    await waitFor(() =>
      expect(updateDevice).toHaveBeenCalledWith('d1', {
        name: 'Tablet Kasir 1 (renamed)',
        category: 'tablet',
        locationId: 'loc-a',
      }),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('requires an explicit confirm before unpairing, and closes the drawer on success', async () => {
    setPermissions(['device.read', 'device.manage']);
    const onChanged = vi.fn();
    const onClose = vi.fn();
    vi.mocked(unpairDevice).mockResolvedValue(device({ status: 'unpaired' }) as never);

    render(
      <DeviceDetailDrawer
        device={device()}
        location={location()}
        locations={LOCATIONS}
        onClose={onClose}
        onChanged={onChanged}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Lepas Pasangan' }));
    // Confirm dialog now open — the API must not have been called yet.
    expect(unpairDevice).not.toHaveBeenCalled();
    expect(screen.getByText('Lepas pasangan perangkat ini?')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Ya, Lepas Pasangan' }));

    await waitFor(() => expect(unpairDevice).toHaveBeenCalledWith('d1', undefined));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('hides every management action but shows why for a retired device', () => {
    setPermissions(['device.read', 'device.manage']);
    render(
      <DeviceDetailDrawer
        device={device({ status: 'retired' })}
        location={location()}
        locations={LOCATIONS}
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );

    expect(screen.getByText('Kelola Perangkat')).toBeInTheDocument();
    expect(screen.queryByLabelText('Nama Perangkat')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Lepas Pasangan' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pensiunkan' })).not.toBeInTheDocument();
  });
});
