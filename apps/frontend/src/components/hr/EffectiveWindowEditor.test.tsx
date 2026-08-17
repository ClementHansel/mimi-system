import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EffectiveWindowEditor } from './EffectiveWindowEditor';

/**
 * The effective-dated rate editors (BPJS/TER/PTKP/Article-17, CONTRACTS §4.15
 * Amendment 1) share one failure mode the ticket calls out explicitly:
 * picking the wrong vintage silently mis-computes everyone's tax. So the
 * non-trivial behavior to lock down here is the submit guard — a duplicate
 * or backdated `effectiveFrom` must never be submittable, regardless of what
 * row-specific form fields a caller plugs in.
 */
const rows = [
  { effectiveFrom: '2024-01-01', effectiveTo: '2024-12-31' },
  { effectiveFrom: '2025-01-01', effectiveTo: null },
];

function setup(effectiveFromInitial: string) {
  const onSubmit = vi.fn();
  const Wrapper = () => {
    const [value, setValue] = useState(effectiveFromInitial);
    return (
      <EffectiveWindowEditor
        title="Tarif BPJS"
        rows={rows}
        historyColumns={['Program']}
        renderHistoryRow={(row) => <td key="p">{row.effectiveFrom}</td>}
        formFields={<div>form fields</div>}
        effectiveFrom={value}
        onEffectiveFromChange={setValue}
        onSubmit={onSubmit}
      />
    );
  };
  render(<Wrapper />);
  fireEvent.click(screen.getByRole('button', { name: 'Tambah Vintage Baru' }));
  return { onSubmit };
}

describe('EffectiveWindowEditor', () => {
  it('disables save and shows a warning for a duplicate effectiveFrom date', () => {
    setup('');
    const dateInput = screen.getByLabelText('Berlaku Sejak') as HTMLInputElement;
    fireEvent.change(dateInput, { target: { value: '2025-01-01' } });
    expect(screen.getByText('Tanggal ini sudah punya tarif — pilih tanggal lain atau ubah baris yang ada.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Simpan Vintage' })).toBeDisabled();
  });

  it('disables save and shows a warning for a date before the latest existing vintage', () => {
    setup('');
    const dateInput = screen.getByLabelText('Berlaku Sejak');
    fireEvent.change(dateInput, { target: { value: '2024-06-01' } });
    expect(screen.getByText('Tanggal ini sebelum tarif terbaru yang sudah ada — periksa kembali.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Simpan Vintage' })).toBeDisabled();
  });

  it('enables save for a valid future effectiveFrom date', () => {
    setup('');
    const dateInput = screen.getByLabelText('Berlaku Sejak');
    fireEvent.change(dateInput, { target: { value: '2027-01-01' } });
    expect(screen.getByRole('button', { name: 'Simpan Vintage' })).not.toBeDisabled();
  });

  it('labels each history row with its window state (active/future/past)', () => {
    setup('');
    expect(screen.getByText('Aktif')).toBeInTheDocument();
    expect(screen.getByText('Kedaluwarsa')).toBeInTheDocument();
  });
});
