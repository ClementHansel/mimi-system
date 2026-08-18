import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ReplenishmentApproveForm } from './ReplenishmentApproveForm';
import type { Replenishment } from './lib/types';

const replenishment: Replenishment = {
  id: 'req-1',
  requestNumber: 'REQ-010',
  locationId: 'loc-1',
  locationName: 'Outlet Kemang',
  status: 'awaiting_approval',
  source: 'manual',
  requestedBy: 'Budi',
  submittedAt: '2026-08-01T00:00:00Z',
  neededBy: '2026-08-05',
  sjId: null,
  sjNumber: null,
  approval: {
    approvalId: 'apr-1',
    state: 'pending',
    amount: null,
    steps: [
      {
        stepNo: 1,
        approverRole: 'supervisor',
        state: 'approved',
        actedBy: 'Sari',
        actedAt: '2026-08-01T01:00:00Z',
        reason: null,
        offlineAuthorized: false,
        reverificationStatus: null,
      },
      {
        stepNo: 2,
        approverRole: 'kepala_gudang',
        state: 'pending',
        actedBy: null,
        actedAt: null,
        reason: null,
        offlineAuthorized: false,
        reverificationStatus: null,
      },
    ],
  },
  lines: [
    {
      id: 'line-1',
      itemId: 'item-1',
      itemName: 'Ayam Fillet',
      unitCode: 'kg',
      storageType: 'frozen',
      qtyRequested: '10.000',
      qtyApproved: null,
      qtyShipped: null,
      qtyReceived: null,
      amendReason: null,
    },
    {
      id: 'line-2',
      itemId: 'item-2',
      itemName: 'Beras',
      unitCode: 'kg',
      storageType: 'dry',
      qtyRequested: '20.000',
      qtyApproved: null,
      qtyShipped: null,
      qtyReceived: null,
      amendReason: null,
    },
  ],
};

describe('ReplenishmentApproveForm — FR-LOG-13 mandatory amend-reason gate', () => {
  it('approves with no amendments at all when nothing is changed', () => {
    const onApprove = vi.fn();
    render(
      <ReplenishmentApproveForm
        replenishment={replenishment}
        onApprove={onApprove}
        onReject={vi.fn()}
      />,
    );
    const approveBtn = screen.getByRole('button', { name: 'Setujui' });
    expect(approveBtn).not.toBeDisabled();
    fireEvent.click(approveBtn);
    expect(onApprove).toHaveBeenCalledWith([], undefined);
  });

  it('blocks approval the instant a line is marked amended but has no reason yet', () => {
    const onApprove = vi.fn();
    render(
      <ReplenishmentApproveForm
        replenishment={replenishment}
        onApprove={onApprove}
        onReject={vi.fn()}
      />,
    );

    const amendToggle = screen.getAllByLabelText('Ubah baris ini')[0]!;
    fireEvent.click(amendToggle);

    expect(screen.getByText('Alasan wajib diisi')).toBeInTheDocument();
    const approveBtn = screen.getByRole('button', { name: 'Setujui' });
    expect(approveBtn).toBeDisabled();
    fireEvent.click(approveBtn);
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('surfaces a visible warning callout once any line is amended, and unblocks only once the reason is filled', () => {
    const onApprove = vi.fn();
    render(
      <ReplenishmentApproveForm
        replenishment={replenishment}
        onApprove={onApprove}
        onReject={vi.fn()}
      />,
    );

    fireEvent.click(screen.getAllByLabelText('Ubah baris ini')[0]!);
    expect(screen.getByText(/jumlahnya diubah — alasan wajib diisi/i)).toBeInTheDocument();

    const reasonBox = screen.getByPlaceholderText('Tuliskan alasan…');
    fireEvent.change(reasonBox, { target: { value: 'Stok gudang menipis' } });

    const approveBtn = screen.getByRole('button', { name: 'Setujui' });
    expect(approveBtn).not.toBeDisabled();
    fireEvent.click(approveBtn);
    expect(onApprove).toHaveBeenCalledTimes(1);
    const [amendments] = onApprove.mock.calls[0]!;
    expect(amendments).toEqual([
      { lineId: 'line-1', qtyApproved: '10.000', reason: 'Stok gudang menipis' },
    ]);
  });

  it('un-amending a line clears its requirement and restores the requested quantity', () => {
    const onApprove = vi.fn();
    render(
      <ReplenishmentApproveForm
        replenishment={replenishment}
        onApprove={onApprove}
        onReject={vi.fn()}
      />,
    );

    const toggle = screen.getAllByLabelText('Ubah baris ini')[0]!;
    fireEvent.click(toggle); // amend on -> reason required
    expect(screen.getByRole('button', { name: 'Setujui' })).toBeDisabled();
    fireEvent.click(toggle); // amend off -> requirement lifted
    expect(screen.getByRole('button', { name: 'Setujui' })).not.toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Setujui' }));
    expect(onApprove).toHaveBeenCalledWith([], undefined);
  });

  it('requires a reason before the reject action can be confirmed', () => {
    const onReject = vi.fn();
    render(
      <ReplenishmentApproveForm
        replenishment={replenishment}
        onApprove={vi.fn()}
        onReject={onReject}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Tolak' }));
    const confirmBtn = screen.getByRole('button', { name: 'Konfirmasi Tolak' });
    expect(confirmBtn).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Alasan Penolakan/), {
      target: { value: 'Barang tidak tersedia' },
    });
    expect(confirmBtn).not.toBeDisabled();
    fireEvent.click(confirmBtn);
    expect(onReject).toHaveBeenCalledWith('Barang tidak tersedia');
  });
});
