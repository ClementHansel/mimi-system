import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EffectiveWindowEditor } from './EffectiveWindowEditor';
import { useSessionStore } from '@/stores/session-store';

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
  // The "Tambah Vintage Baru" button is gated behind `payroll.statutory.config`
  // (FIX-LOADS #3 — the tab itself now only requires `.read`, so a session
  // without the write permission must see history but not this button; see
  // the dedicated test below).
  beforeEach(() => {
    useSessionStore.setState({
      user: {
        id: 'u1', username: 'hradmin1', name: 'Test HR Admin', roleKey: 'hr_admin',
        permissions: ['payroll.statutory.config'], locations: [], employeeId: null, mustSetPin: false,
      },
    });
  });

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

  // FIX-LOADS #3 regression: viewing the Statutory tab needs only
  // `payroll.statutory.read` (Owner holds it) — the DTO-write action stays
  // behind `payroll.statutory.config`, matching `StatutoryController`'s own
  // GET-vs-PUT permission split so a read-only session can see history
  // without a hidden 403 waiting behind a visible button.
  it('hides "Tambah Vintage Baru" for a session with only payroll.statutory.read (e.g. Owner)', () => {
    useSessionStore.setState({
      user: {
        id: 'u2', username: 'owner', name: 'Test Owner', roleKey: 'owner',
        permissions: ['payroll.statutory.read'], locations: [], employeeId: null, mustSetPin: false,
      },
    });
    const onSubmit = vi.fn();
    render(
      <EffectiveWindowEditor
        title="Tarif BPJS"
        rows={rows}
        historyColumns={['Program']}
        renderHistoryRow={(row) => <td key="p">{row.effectiveFrom}</td>}
        formFields={<div>form fields</div>}
        effectiveFrom=""
        onEffectiveFromChange={() => {}}
        onSubmit={onSubmit}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Tambah Vintage Baru' })).not.toBeInTheDocument();
    // The read-only history is still visible.
    expect(screen.getByText('Aktif')).toBeInTheDocument();
  });
});
