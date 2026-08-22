import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { api } from '@/lib/api';
import { IssueApprovalCodePanel } from './IssueApprovalCodePanel';

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, api: { ...actual.api, post: vi.fn() } };
});

const post = api.post as unknown as ReturnType<typeof vi.fn>;

/**
 * B-15 — the approver's half of the one-time code.
 *
 * These assertions exist because the failure modes here are all about what the
 * screen CLAIMS: a UI that says "approved" before the code is redeemed sends a
 * supervisor away believing a void went through, and a UI that offers to keep
 * the code around quietly rebuilds the standing secret the whole change removed.
 */
describe('IssueApprovalCodePanel', () => {
  beforeEach(() => {
    post.mockReset();
  });

  it('posts to the document-bound code endpoint — never to a generic "verify" route', async () => {
    post.mockResolvedValue({
      code: '481920',
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      redeemableByUserId: 'kasir-1',
    });

    render(<IssueApprovalCodePanel documentType="void_refund" documentId="doc-9" />);
    fireEvent.click(screen.getByRole('button', { name: /Setujui & Buat Kode/ }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/approvals/void_refund/doc-9/code', {}),
    );
  });

  it('shows the six digits, and still says the document is WAITING — not approved', async () => {
    post.mockResolvedValue({
      code: '481920',
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      redeemableByUserId: 'kasir-1',
    });

    render(<IssueApprovalCodePanel documentType="void_refund" documentId="doc-9" />);
    fireEvent.click(screen.getByRole('button', { name: /Setujui & Buat Kode/ }));

    expect(await screen.findByTestId('approval-code')).toHaveTextContent('481920');
    // The honesty assertion. Until the cashier redeems it, the void has not
    // happened, and this panel must not imply otherwise.
    expect(screen.getByText(/masih menunggu/i)).toBeInTheDocument();
  });

  it('offers no way to copy or keep the code — it is meant to be read out once', async () => {
    post.mockResolvedValue({
      code: '481920',
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      redeemableByUserId: 'kasir-1',
    });

    render(<IssueApprovalCodePanel documentType="void_refund" documentId="doc-9" />);
    fireEvent.click(screen.getByRole('button', { name: /Setujui & Buat Kode/ }));
    await screen.findByTestId('approval-code');

    expect(screen.queryByRole('button', { name: /salin/i })).not.toBeInTheDocument();
  });

  it('re-issuing asks the server for a new code rather than re-showing the old one', async () => {
    post
      .mockResolvedValueOnce({
        code: '111111',
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        redeemableByUserId: 'kasir-1',
      })
      .mockResolvedValueOnce({
        code: '222222',
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        redeemableByUserId: 'kasir-1',
      });

    render(<IssueApprovalCodePanel documentType="void_refund" documentId="doc-9" />);
    fireEvent.click(screen.getByRole('button', { name: /Setujui & Buat Kode/ }));
    expect(await screen.findByTestId('approval-code')).toHaveTextContent('111111');

    fireEvent.click(screen.getByRole('button', { name: /Buat Kode Baru/ }));
    await waitFor(() => expect(screen.getByTestId('approval-code')).toHaveTextContent('222222'));
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('surfaces a refusal instead of pretending a code was issued', async () => {
    post.mockRejectedValue(new Error('nope'));

    render(<IssueApprovalCodePanel documentType="void_refund" documentId="doc-9" />);
    fireEvent.click(screen.getByRole('button', { name: /Setujui & Buat Kode/ }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(screen.queryByTestId('approval-code')).not.toBeInTheDocument();
  });
});
