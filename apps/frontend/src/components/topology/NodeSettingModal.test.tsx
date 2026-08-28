import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NodeSettingModal } from './NodeSettingModal';
import { useSessionStore } from '@/stores/session-store';
import { ApiError } from '@/lib/api';
import {
  setOutletNodeEnabled,
  mintNodePairingToken,
  getNodeDetail,
  setNodeNetworkConfig,
  sendNodeCommand,
  type NodeDetail,
} from './lib/node-api';
import type { TopologyLocation } from './lib/types';

/**
 * D-26: the branch-node ON/OFF toggle (`PUT /nodes/outlet-setting/:id`) is
 * Owner-only server-side — `OutletNodeSettingController.setEnabled` checks
 * `req.user.roleKey === 'owner'` ON TOP OF the `node.manage` permission
 * decorator, which Manager/Superadmin also hold. The point of these tests
 * is that split: a Manager can OPEN this modal (`node.manage` gates the
 * trigger in `OutletCard`) and see the current state, but never gets the
 * toggle controls — only an Owner does.
 */
vi.mock('./lib/node-api', () => ({
  setOutletNodeEnabled: vi.fn(),
  mintNodePairingToken: vi.fn(),
  getNodeDetail: vi.fn(),
  setNodeNetworkConfig: vi.fn(),
  sendNodeCommand: vi.fn(),
}));

function nodeDetail(overrides: Partial<NodeDetail> = {}): NodeDetail {
  return {
    id: 'n1',
    locationId: 'loc-a',
    locationName: 'Outlet Balikpapan Baru',
    name: 'Node 1',
    status: 'online',
    version: '1.0.0',
    ipAddress: null,
    lastSeenAt: null,
    deviceCount: 0,
    relayQueueDepth: 0,
    networkConfig: { healthPort: 4010, scanSubnet: null },
    networkConfigStatus: 'none',
    networkConfigResult: {},
    discoveredNewCount: 0,
    isConnected: true,
    events: [],
    ...overrides,
  };
}

function setUser(roleKey: string, permissions: string[]) {
  useSessionStore.setState({
    user: {
      id: 'u1',
      username: roleKey,
      name: roleKey,
      roleKey,
      permissions,
      locations: [],
      employeeId: null,
      mustSetPin: false,
    },
  });
}

function loc(overrides: Partial<TopologyLocation> = {}): TopologyLocation {
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
    counts: { online: 0, stale: 0, offline: 0, total: 0 },
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

describe('NodeSettingModal', () => {
  beforeEach(() => {
    useSessionStore.setState({ accessToken: null, refreshToken: null, user: null });
    vi.mocked(setOutletNodeEnabled).mockReset();
    vi.mocked(mintNodePairingToken).mockReset();
    vi.mocked(getNodeDetail).mockReset().mockResolvedValue(nodeDetail());
    vi.mocked(setNodeNetworkConfig).mockReset();
    vi.mocked(sendNodeCommand).mockReset();
  });

  it('shows the current state but no toggle controls for a Manager (has node.manage, not Owner)', () => {
    setUser('manager', ['node.manage']);
    render(<NodeSettingModal location={loc()} onClose={vi.fn()} onChanged={vi.fn()} />);

    expect(screen.getByText(/Hanya Owner yang dapat mengubah/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Aktifkan Node' })).not.toBeInTheDocument();
  });

  it('lets an Owner turn the node on, calling the setting endpoint and notifying the parent', async () => {
    setUser('owner', ['node.manage']);
    const onChanged = vi.fn();
    vi.mocked(setOutletNodeEnabled).mockResolvedValue({
      locationId: 'loc-a',
      locationCode: 'OUT1',
      locationName: 'Outlet Balikpapan Baru',
      nodeEnabled: true,
      node: null,
    });

    render(<NodeSettingModal location={loc()} onClose={vi.fn()} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: 'Aktifkan Node' }));

    await waitFor(() => expect(setOutletNodeEnabled).toHaveBeenCalledWith('loc-a', true));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('surfaces the server drain-before-off message verbatim when turning a node off fails', async () => {
    setUser('owner', ['node.manage']);
    vi.mocked(setOutletNodeEnabled).mockRejectedValue(
      new ApiError(400, 'ERR_NODE_QUEUE_PENDING', '3 event(s) are still queued on this node.'),
    );

    render(
      <NodeSettingModal
        location={loc({
          nodeEnabled: true,
          node: {
            id: 'n1',
            name: 'Node 1',
            status: 'online',
            version: '1.0.0',
            lastSeenAt: null,
            relayQueueDepth: 3,
            discoveredNewCount: 0,
          },
        })}
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Nonaktifkan Node' }));

    await waitFor(() =>
      expect(screen.getByText('3 event(s) are still queued on this node.')).toBeInTheDocument(),
    );
  });

  it('offers minting a node pairing code once enabled with no node paired yet, and shows the display code', async () => {
    setUser('owner', ['node.manage']);
    vi.mocked(mintNodePairingToken).mockResolvedValue({
      tokenId: 'tok-1',
      token: 'raw-secret',
      displayCode: 'PQRS-TUVW-XYZA',
      qrPayload: 'mimi-pair:node:raw-secret',
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    });

    render(
      <NodeSettingModal
        location={loc({ nodeEnabled: true, node: null })}
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Buat Kode Pemasangan Node' }));

    await waitFor(() => expect(screen.getByText('PQRS-TUVW-XYZA')).toBeInTheDocument());
    expect(mintNodePairingToken).toHaveBeenCalledWith('loc-a');
  });

  const pairedLocation = () =>
    loc({
      nodeEnabled: true,
      node: {
        id: 'n1',
        name: 'Node 1',
        status: 'online',
        version: '1.0.0',
        lastSeenAt: null,
        relayQueueDepth: 0,
        discoveredNewCount: 0,
      },
    });

  it(
    'only offers the two network fields this node build genuinely applies (healthPort/scanSubnet), ' +
      'and saves a healthPort change through the real endpoint',
    async () => {
      setUser('owner', ['node.manage']);
      vi.mocked(setNodeNetworkConfig).mockResolvedValue({
        configId: 'cfg-1',
        networkConfig: { healthPort: 4222 },
        networkConfigStatus: 'pending',
      });

      render(
        <NodeSettingModal location={pairedLocation()} onClose={vi.fn()} onChanged={vi.fn()} />,
      );
      await waitFor(() => expect(getNodeDetail).toHaveBeenCalledWith('n1'));

      // Never a WiFi/static-IP field — those are accepted server-side but not genuinely applied by
      // this node build (see `lib/node-api.ts`'s doc comment).
      expect(screen.queryByLabelText(/WiFi/i)).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/IP Statis/i)).not.toBeInTheDocument();

      fireEvent.change(screen.getByLabelText('Port LAN'), { target: { value: '4222' } });
      fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));

      await waitFor(() =>
        expect(setNodeNetworkConfig).toHaveBeenCalledWith('n1', { healthPort: 4222 }),
      );
    },
  );

  it('shows the shift-open override flow when restart is refused, and retries with override:true', async () => {
    setUser('owner', ['node.manage']);
    vi.mocked(sendNodeCommand).mockRejectedValueOnce(
      new ApiError(400, 'ERR_NODE_SHIFT_OPEN', 'This outlet has an open POS shift.'),
    );
    vi.mocked(sendNodeCommand).mockResolvedValueOnce({ commandId: 'cmd-1', status: 'sent' });

    render(<NodeSettingModal location={pairedLocation()} onClose={vi.fn()} onChanged={vi.fn()} />);
    await waitFor(() => expect(getNodeDetail).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: 'Mulai Ulang Node' }));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Mulai Ulang Meski Shift Terbuka' }),
      ).toBeInTheDocument(),
    );
    expect(sendNodeCommand).toHaveBeenCalledWith('n1', 'restart', undefined);

    fireEvent.click(screen.getByRole('button', { name: 'Mulai Ulang Meski Shift Terbuka' }));
    await waitFor(() =>
      expect(sendNodeCommand).toHaveBeenCalledWith('n1', 'restart', { override: true }),
    );
  });

  it('pulls real logs and renders them once the node reports the result via device_events', async () => {
    setUser('owner', ['node.manage']);
    vi.mocked(sendNodeCommand).mockResolvedValue({ commandId: 'cmd-log-1', status: 'sent' });
    vi.mocked(getNodeDetail)
      .mockResolvedValueOnce(nodeDetail())
      .mockResolvedValue(
        nodeDetail({
          events: [
            {
              type: 'command_result',
              detail: {
                commandId: 'cmd-log-1',
                kind: 'log_pull',
                lines: ['[log] hello', '[log] world'],
              },
              created_at: new Date().toISOString(),
            },
          ],
        }),
      );

    render(<NodeSettingModal location={pairedLocation()} onClose={vi.fn()} onChanged={vi.fn()} />);
    await waitFor(() => expect(getNodeDetail).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: 'Ambil Log Terbaru' }));
    await waitFor(() =>
      expect(sendNodeCommand).toHaveBeenCalledWith('n1', 'log_pull', { lines: 200 }),
    );

    await waitFor(() => expect(screen.getByText(/hello/)).toBeInTheDocument(), { timeout: 4000 });
    expect(screen.getByText(/world/)).toBeInTheDocument();
  });
});
