import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ReceiveDropForm } from './ReceiveDropForm';
import type { Drop, StorageArea } from './lib/types';

const drop: Drop = {
  id: 'drop-1',
  dropSeq: 1,
  locationId: 'loc-1',
  locationName: 'Outlet Kemang',
  city: 'Jakarta',
  replenishmentRequestId: null,
  status: 'arrived',
  departedAt: null,
  arrivedAt: null,
  receivedBy: null,
  receivedAt: null,
  signatureUrl: null,
  photoUrls: [],
  discrepancyNotes: null,
  lines: [
    {
      id: 'line-1',
      itemId: 'item-1',
      itemName: 'Ayam Fillet',
      unitCode: 'kg',
      storageType: 'frozen',
      qty: '10.000',
      qtyReceived: null,
      receivedStorageAreaId: null,
      discrepancyReason: null,
    },
  ],
};

const areas: StorageArea[] = [
  {
    id: 'area-1',
    locationId: 'loc-1',
    code: 'FRZ',
    name: 'Freezer',
    type: 'freezer',
    tempMin: null,
    tempMax: null,
    sortOrder: 1,
    isActive: true,
  },
];

beforeAll(() => {
  // jsdom has no createObjectURL
  if (!URL.createObjectURL) URL.createObjectURL = vi.fn(() => 'blob:mock');
});

describe('ReceiveDropForm — wajib-foto / wajib-signature gate (FR-LOG-14/15)', () => {
  it('keeps the confirm button disabled until a photo AND a signature are present, even with valid lines', () => {
    const onSubmit = vi.fn();
    render(
      <ReceiveDropForm
        drop={drop}
        storageAreas={areas}
        photoFile={null}
        onPhotoChange={vi.fn()}
        signatureDataUrl={null}
        onSignatureChange={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    const confirmBtn = screen.getByRole('button', { name: /Konfirmasi/i });
    expect(confirmBtn).toBeDisabled();
  });

  it('stays disabled with a photo but no signature', () => {
    const file = new File(['x'], 'a.jpg', { type: 'image/jpeg' });
    render(
      <ReceiveDropForm
        drop={drop}
        storageAreas={areas}
        photoFile={file}
        onPhotoChange={vi.fn()}
        signatureDataUrl={null}
        onSignatureChange={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /Konfirmasi/i })).toBeDisabled();
  });

  it('enables the confirm button once photo + signature + every line (qty, area, and reason-if-discrepant) is filled', () => {
    const file = new File(['x'], 'a.jpg', { type: 'image/jpeg' });
    const onSubmit = vi.fn();
    render(
      <ReceiveDropForm
        drop={drop}
        storageAreas={areas}
        photoFile={file}
        onPhotoChange={vi.fn()}
        signatureDataUrl="data:image/png;base64,abc"
        onSignatureChange={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    // qtyReceived defaults to qty sent (10.000) — no discrepancy — just needs a storage area.
    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: 'area-1' } });

    const confirmBtn = screen.getByRole('button', { name: /Konfirmasi/i });
    expect(confirmBtn).not.toBeDisabled();
    fireEvent.click(confirmBtn);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('demands a discrepancy reason once received qty differs from sent qty, blocking submit until filled', () => {
    const file = new File(['x'], 'a.jpg', { type: 'image/jpeg' });
    render(
      <ReceiveDropForm
        drop={drop}
        storageAreas={areas}
        photoFile={file}
        onPhotoChange={vi.fn()}
        signatureDataUrl="data:image/png;base64,abc"
        onSignatureChange={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'area-1' } });
    // Change received qty to create a discrepancy (10.000 sent -> 8 received).
    const qtyInputs = screen.getAllByRole('textbox');
    const qtyInput = qtyInputs.find((el) => (el as HTMLInputElement).value.includes('10'))!;
    fireEvent.focus(qtyInput);
    fireEvent.change(qtyInput, { target: { value: '8' } });
    fireEvent.blur(qtyInput);

    expect(screen.getByRole('button', { name: /Konfirmasi/i })).toBeDisabled();
    expect(screen.getByText('Alasan wajib diisi')).toBeInTheDocument();
  });
});
