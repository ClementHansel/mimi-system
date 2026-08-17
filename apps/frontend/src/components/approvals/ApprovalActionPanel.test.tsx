import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ApprovalActionPanel } from './ApprovalActionPanel';

/**
 * FR-LOG-13's mandatory-reason gate for the 10 document types whose decide
 * action is a plain note/reason POST (`replenishment_request`'s per-line
 * amend gate is covered separately by `ReplenishmentApproveForm.test.tsx` —
 * this panel is what every OTHER document type's approve/reject renders).
 */
describe('ApprovalActionPanel — mandatory-reason gates', () => {
  it('requires a reason before "Konfirmasi Tolak" can be clicked, for every document type', () => {
    const onReject = vi.fn();
    render(<ApprovalActionPanel approveSupported onApprove={vi.fn()} onReject={onReject} />);

    fireEvent.click(screen.getByRole('button', { name: 'Tolak' }));
    const confirmBtn = screen.getByRole('button', { name: 'Konfirmasi Tolak' });
    expect(confirmBtn).toBeDisabled();

    fireEvent.click(confirmBtn); // still blocked — no reason yet
    expect(onReject).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/Alasan Penolakan/), { target: { value: 'Dokumen tidak lengkap' } });
    expect(confirmBtn).not.toBeDisabled();
    fireEvent.click(confirmBtn);
    expect(onReject).toHaveBeenCalledWith('Dokumen tidak lengkap');
  });

  it('lets approve fire with an empty note when the document type does not require one', () => {
    const onApprove = vi.fn();
    render(<ApprovalActionPanel approveSupported onApprove={onApprove} onReject={vi.fn()} />);

    const approveBtn = screen.getByRole('button', { name: 'Setujui' });
    expect(approveBtn).not.toBeDisabled();
    fireEvent.click(approveBtn);
    expect(onApprove).toHaveBeenCalledWith(undefined);
  });

  it('blocks approve until a reason is filled when the document type requires one on approve too (cash_variance_proposal, §5.9)', () => {
    const onApprove = vi.fn();
    render(<ApprovalActionPanel approveSupported reasonRequiredOnApprove onApprove={onApprove} onReject={vi.fn()} />);

    const approveBtn = screen.getByRole('button', { name: 'Setujui' });
    expect(approveBtn).toBeDisabled();
    fireEvent.click(approveBtn);
    expect(onApprove).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/Catatan/), { target: { value: 'Selisih dikonfirmasi kasir' } });
    expect(approveBtn).not.toBeDisabled();
    fireEvent.click(approveBtn);
    expect(onApprove).toHaveBeenCalledWith('Selisih dikonfirmasi kasir');
  });

  it('hides the approve button entirely and shows the explanation when approve is not supported from this screen (void_refund/payment_verification)', () => {
    render(
      <ApprovalActionPanel
        approveSupported={false}
        approveUnsupportedMessage="Persetujuan void/refund memerlukan verifikasi PIN dari modul Kasir."
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Setujui' })).not.toBeInTheDocument();
    expect(screen.getByText(/memerlukan verifikasi PIN/)).toBeInTheDocument();
    // Reject stays available even when approve does not.
    expect(screen.getByRole('button', { name: 'Tolak' })).toBeInTheDocument();
  });
});
