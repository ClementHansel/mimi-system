import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PurchaseRequestsPanel } from './PurchaseRequestsPanel';
import { useSessionStore } from '@/stores/session-store';
import { api } from '@/lib/api';
import type { PurchaseRequestDetail, PurchaseRequestListRow } from './lib/types';

/**
 * F-PUR-01 — the draft -> submitted -> approved/rejected ladder that feeds
 * FR-PO-01's "create PO from an approved PR" step. Mirrors
 * `PaymentsPanel.test.tsx`'s drive-the-real-tree style: row click -> drawer,
 * asserting on rendered actions rather than internal state.
 */
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, api: { ...actual.api, get: vi.fn(), post: vi.fn() } };
});

function setPermissions(permissions: string[]) {
  useSessionStore.setState({
    user: {
      id: 'u1',
      username: 'spv1',
      name: 'Supervisor Satu',
      roleKey: 'supervisor',
      permissions,
      locations: [],
      employeeId: null,
      mustSetPin: false,
    },
  });
}

function prRow(overrides: Partial<PurchaseRequestListRow> = {}): PurchaseRequestListRow {
  return {
    id: 'pr-1',
    prNumber: 'PR-202608-00001',
    locationName: 'Outlet Sanur',
    status: 'draft',
    requestedBy: 'Supervisor Satu',
    neededBy: '2026-08-20',
    lineCount: 1,
    ...overrides,
  };
}

function prDetail(overrides: Partial<PurchaseRequestDetail> = {}): PurchaseRequestDetail {
  return {
    id: 'pr-1',
    prNumber: 'PR-202608-00001',
    locationId: 'loc-1',
    locationName: 'Outlet Sanur',
    status: 'draft',
    requestedBy: 'Supervisor Satu',
    neededBy: '2026-08-20',
    rejectionReason: null,
    notes: null,
    approval: null,
    lines: [
      {
        id: 'l1',
        itemId: 'i1',
        itemName: 'Ayam Potong',
        unitId: 'u1',
        unitCode: 'kg',
        qty: '50.000',
        estPrice: '50000.00',
        suggestedSupplierId: null,
      },
    ],
    ...overrides,
  };
}

describe('PurchaseRequestsPanel — F-PUR-01 status ladder', () => {
  beforeEach(() => {
    useSessionStore.setState({ accessToken: null, refreshToken: null, user: null });
    vi.mocked(api.get).mockReset();
    vi.mocked(api.post).mockReset();
  });

  it('a draft PR shows Ajukan for a holder of purchasing.pr.create, and calls submit', async () => {
    setPermissions(['purchasing.read', 'purchasing.pr.create']);
    vi.mocked(api.get).mockImplementation((path: string) => {
      if (path.startsWith('/purchasing/requests/pr-1')) return Promise.resolve(prDetail());
      if (path.startsWith('/purchasing/requests?'))
        return Promise.resolve({ rows: [prRow()], total: 1, page: 1, pageSize: 25 });
      if (path.startsWith('/locations'))
        return Promise.resolve({ rows: [], total: 0, page: 1, pageSize: 25 });
      return Promise.resolve({ rows: [], total: 0, page: 1, pageSize: 25 });
    });
    vi.mocked(api.post).mockResolvedValue(prDetail({ status: 'submitted' }));

    render(<PurchaseRequestsPanel />);
    fireEvent.click(await screen.findByText('PR-202608-00001'));

    const submitButton = await screen.findByRole('button', { name: 'Ajukan' });
    fireEvent.click(submitButton);

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/purchasing/requests/pr-1/submit'));
  });

  it('a submitted PR shows Setujui/Tolak only for purchasing.pr.approve, and approve calls the approve endpoint', async () => {
    setPermissions(['purchasing.read', 'purchasing.pr.approve']);
    vi.mocked(api.get).mockImplementation((path: string) => {
      if (path.startsWith('/purchasing/requests/pr-1'))
        return Promise.resolve(prDetail({ status: 'submitted' }));
      if (path.startsWith('/purchasing/requests?'))
        return Promise.resolve({
          rows: [prRow({ status: 'submitted' })],
          total: 1,
          page: 1,
          pageSize: 25,
        });
      return Promise.resolve({ rows: [], total: 0, page: 1, pageSize: 25 });
    });
    vi.mocked(api.post).mockResolvedValue(prDetail({ status: 'approved' }));

    render(<PurchaseRequestsPanel />);
    fireEvent.click(await screen.findByText('PR-202608-00001'));

    const approveButton = await screen.findByRole('button', { name: 'Setujui' });
    fireEvent.click(approveButton);

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/purchasing/requests/pr-1/approve', {
        note: undefined,
      }),
    );
  });

  it('never renders Ajukan/Setujui/Tolak without the matching permission', async () => {
    setPermissions(['purchasing.read']);
    vi.mocked(api.get).mockImplementation((path: string) => {
      if (path.startsWith('/purchasing/requests/pr-1'))
        return Promise.resolve(prDetail({ status: 'submitted' }));
      if (path.startsWith('/purchasing/requests?'))
        return Promise.resolve({
          rows: [prRow({ status: 'submitted' })],
          total: 1,
          page: 1,
          pageSize: 25,
        });
      return Promise.resolve({ rows: [], total: 0, page: 1, pageSize: 25 });
    });

    render(<PurchaseRequestsPanel />);
    fireEvent.click(await screen.findByText('PR-202608-00001'));

    await waitFor(() => expect(screen.getAllByText('PR-202608-00001').length).toBeGreaterThan(1));
    expect(screen.queryByRole('button', { name: 'Ajukan' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Setujui' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Tolak' })).not.toBeInTheDocument();
  });

  it('renders the approval chain timeline when the PR detail carries one, with currentStep null meaning the chain is complete', async () => {
    setPermissions(['purchasing.read']);
    vi.mocked(api.get).mockImplementation((path: string) => {
      if (path.startsWith('/purchasing/requests/pr-1')) {
        return Promise.resolve(
          prDetail({
            status: 'approved',
            approval: {
              approvalId: 'appr-1',
              state: 'approved',
              amount: null,
              currentStep: null, // finalized — the documented completion signal, not an error.
              steps: [
                {
                  stepNo: 1,
                  approverRole: 'manager',
                  state: 'approved',
                  // `actedBy` is the approver's user ID; `actedByName` is the
                  // person the timeline shows. This fixture put the name in the
                  // ID field, which the API never does.
                  actedBy: '640218f4-cdbd-4d65-80ae-8b1c31ececc0',
                  actedByName: 'Manager Satu',
                  actedAt: '2026-08-21T00:00:00.000Z',
                  reason: null,
                  offlineAuthorized: false,
                  reverificationStatus: null,
                },
              ],
            },
          }),
        );
      }
      if (path.startsWith('/purchasing/requests?'))
        return Promise.resolve({
          rows: [prRow({ status: 'approved' })],
          total: 1,
          page: 1,
          pageSize: 25,
        });
      return Promise.resolve({ rows: [], total: 0, page: 1, pageSize: 25 });
    });

    render(<PurchaseRequestsPanel />);
    fireEvent.click(await screen.findByText('PR-202608-00001'));

    expect(await screen.findByText('Riwayat Persetujuan')).toBeInTheDocument();
    expect(screen.getByText('Manager Satu', { exact: false })).toBeInTheDocument();
  });

  it('a rejected PR renders its rejection reason', async () => {
    setPermissions(['purchasing.read']);
    vi.mocked(api.get).mockImplementation((path: string) => {
      if (path.startsWith('/purchasing/requests/pr-1'))
        return Promise.resolve(
          prDetail({ status: 'rejected', rejectionReason: 'Stok masih cukup' }),
        );
      if (path.startsWith('/purchasing/requests?'))
        return Promise.resolve({
          rows: [prRow({ status: 'rejected' })],
          total: 1,
          page: 1,
          pageSize: 25,
        });
      return Promise.resolve({ rows: [], total: 0, page: 1, pageSize: 25 });
    });

    render(<PurchaseRequestsPanel />);
    fireEvent.click(await screen.findByText('PR-202608-00001'));

    expect(await screen.findByText('Stok masih cukup')).toBeInTheDocument();
  });
});
