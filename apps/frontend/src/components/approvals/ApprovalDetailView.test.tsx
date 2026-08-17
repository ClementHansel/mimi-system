import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ApprovalDetailView } from './ApprovalDetailView';
import { useSessionStore } from '@/stores/session-store';
import { api } from '@/lib/api';
import type { ApprovalDetail } from './lib/types';

/**
 * `currentStep === null` is the documented "chain finished" signal
 * (`@mimi/shared`'s `ApprovalDetail.currentStep`) — this screen must key its
 * completion rendering off exactly that field, never off scanning `steps`
 * for a pending entry. Also covers the D-17 fraud-control requirement that an
 * offline-authorized step pending re-verification never renders identically
 * to a confirmed one, and that eligibility is honestly per-step/per-role
 * (the document is still shown to a caller who cannot yet act on it).
 */
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, api: { ...actual.api, get: vi.fn(), post: vi.fn() } };
});

function setPermissions(permissions: string[]) {
  useSessionStore.setState({
    user: {
      id: 'u1', username: 'mgr1', name: 'Manajer Satu', roleKey: 'manager',
      permissions, locations: [], employeeId: null, mustSetPin: false,
    },
  });
}

function mockDetail(detail: ApprovalDetail, path = '/approvals/purchase_request/doc-1') {
  vi.mocked(api.get).mockImplementation((p: string) => {
    if (p.startsWith('/approvals/pending')) return Promise.resolve({ rows: [], total: 0, page: 1, pageSize: 200 });
    if (p === path) return Promise.resolve(detail);
    return Promise.reject(new Error(`unexpected path: ${p}`));
  });
}

describe('ApprovalDetailView', () => {
  beforeEach(() => {
    useSessionStore.setState({ accessToken: null, refreshToken: null, user: null });
    vi.mocked(api.get)?.mockReset?.();
    vi.mocked(api.post)?.mockReset?.();
  });

  it('renders the finished banner and NO action panel once currentStep is null, regardless of steps content', async () => {
    setPermissions(['purchasing.pr.approve']); // eligible in principle — must still not show actions once finished
    mockDetail({
      approvalId: 'apr-1',
      state: 'approved',
      amount: '500000.00',
      currentStep: null,
      steps: [
        { stepNo: 1, approverRole: 'manager', state: 'approved', actedBy: 'Manajer Satu', actedAt: '2026-08-10T00:00:00Z', reason: null, offlineAuthorized: false, reverificationStatus: null },
      ],
    });

    render(<ApprovalDetailView documentType="purchase_request" documentId="doc-1" />);

    expect(await screen.findByText(/Proses persetujuan telah selesai/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Setujui' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Tolak' })).not.toBeInTheDocument();
  });

  it('shows the document but withholds the action panel when the caller is not eligible for the current step', async () => {
    setPermissions([]); // no purchasing.pr.approve
    mockDetail({
      approvalId: 'apr-2',
      state: 'pending',
      amount: '750000.00',
      currentStep: 1,
      steps: [
        { stepNo: 1, approverRole: 'manager', state: 'pending', actedBy: null, actedAt: null, reason: null, offlineAuthorized: false, reverificationStatus: null },
      ],
    });

    render(<ApprovalDetailView documentType="purchase_request" documentId="doc-1" />);

    await screen.findByText(/Menunggu langkah 1/);
    expect(screen.queryByRole('button', { name: 'Setujui' })).not.toBeInTheDocument();
    expect(screen.getByText(/menunggu persetujuan pihak lain/)).toBeInTheDocument();
  });

  it('renders the action panel once the caller holds the current step\'s permission', async () => {
    setPermissions(['purchasing.pr.approve']);
    mockDetail({
      approvalId: 'apr-3',
      state: 'pending',
      amount: '750000.00',
      currentStep: 1,
      steps: [
        { stepNo: 1, approverRole: 'manager', state: 'pending', actedBy: null, actedAt: null, reason: null, offlineAuthorized: false, reverificationStatus: null },
      ],
    });

    render(<ApprovalDetailView documentType="purchase_request" documentId="doc-1" />);
    expect(await screen.findByRole('button', { name: 'Setujui' })).toBeInTheDocument();
  });

  it('does NOT show the reject-only panel to a caller without pos.void.approve, for the approve-unsupported document types', async () => {
    // Regression: `document-types.ts` leaves `approvePermission` undefined for
    // void_refund/payment_verification (approve isn't a plain note/reason POST
    // for either — see that file's header comment). `usePermissions().can()`
    // returns `true` for an undefined key ("no permission required"), so
    // gating naively on `can(approvePermission) || can(rejectPermission)`
    // would make this panel visible to EVERY caller for these two types
    // regardless of role. Eligibility must fall back to `rejectPermission`
    // when approve isn't supported here, not silently pass everyone.
    setPermissions([]); // no pos.void.approve
    mockDetail(
      {
        approvalId: 'apr-5',
        state: 'pending',
        amount: '100000.00',
        currentStep: 1,
        steps: [
          { stepNo: 1, approverRole: 'supervisor', state: 'pending', actedBy: null, actedAt: null, reason: null, offlineAuthorized: false, reverificationStatus: null },
        ],
      },
      '/approvals/void_refund/doc-2',
    );

    render(<ApprovalDetailView documentType="void_refund" documentId="doc-2" />);

    await screen.findByText(/Menunggu langkah 1/);
    expect(screen.queryByRole('button', { name: 'Tolak' })).not.toBeInTheDocument();
    expect(screen.getByText(/menunggu persetujuan pihak lain/)).toBeInTheDocument();
  });

  it('shows the reject-only panel (with its unsupported-approve explanation) to a caller who DOES hold pos.void.approve', async () => {
    setPermissions(['pos.void.approve']);
    mockDetail(
      {
        approvalId: 'apr-6',
        state: 'pending',
        amount: '100000.00',
        currentStep: 1,
        steps: [
          { stepNo: 1, approverRole: 'supervisor', state: 'pending', actedBy: null, actedAt: null, reason: null, offlineAuthorized: false, reverificationStatus: null },
        ],
      },
      '/approvals/void_refund/doc-2',
    );

    render(<ApprovalDetailView documentType="void_refund" documentId="doc-2" />);

    expect(await screen.findByRole('button', { name: 'Tolak' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Setujui' })).not.toBeInTheDocument();
    expect(screen.getByText(/verifikasi PIN/)).toBeInTheDocument();
  });

  it('renders an offline-authorized step pending re-verification distinctly from a confirmed one', async () => {
    setPermissions(['purchasing.pr.approve']);
    mockDetail({
      approvalId: 'apr-4',
      state: 'approved',
      amount: '250000.00',
      currentStep: null,
      steps: [
        { stepNo: 1, approverRole: 'supervisor', state: 'approved', actedBy: 'Sari', actedAt: '2026-08-01T00:00:00Z', reason: null, offlineAuthorized: true, reverificationStatus: 'unprovable' },
      ],
    });

    render(<ApprovalDetailView documentType="purchase_request" documentId="doc-1" />);

    expect(await screen.findByText('Diotorisasi offline')).toBeInTheDocument();
    expect(screen.getByText('Tidak dapat diverifikasi — menunggu tinjauan keuangan')).toBeInTheDocument();
    expect(screen.queryByText('Terverifikasi saat sinkron')).not.toBeInTheDocument();
  });
});
