import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ApprovalTimeline, type ApprovalStepView } from './ApprovalTimeline';

describe('ApprovalTimeline', () => {
  it('renders the empty state when there are no steps', () => {
    render(<ApprovalTimeline steps={[]} />);
    expect(screen.getByText('Belum ada riwayat persetujuan')).toBeInTheDocument();
  });

  it('renders each step with its role label and status', () => {
    const steps: ApprovalStepView[] = [
      {
        stepNo: 1,
        approverRole: 'supervisor',
        state: 'approved',
        actedBy: 'Budi Santoso',
        actedAt: '2026-08-15T02:00:00.000Z',
      },
      { stepNo: 2, approverRole: 'kepala_gudang', state: 'pending' },
    ];
    render(<ApprovalTimeline steps={steps} />);
    expect(screen.getByText(/Langkah 1/)).toBeInTheDocument();
    expect(screen.getByText(/Supervisor Cabang/)).toBeInTheDocument();
    expect(screen.getByText(/Budi Santoso/)).toBeInTheDocument();
    expect(screen.getByText(/Langkah 2/)).toBeInTheDocument();
    // "Kepala Gudang" appears twice for a pending step (the header label and
    // the "Menunggu persetujuan ..." line below it) — assert both, not just one.
    expect(screen.getAllByText(/Kepala Gudang/).length).toBe(2);
    expect(screen.getByText('Menunggu persetujuan Kepala Gudang')).toBeInTheDocument();
  });

  it('surfaces the offline-authorization and reverification provenance (D-17)', () => {
    const steps: ApprovalStepView[] = [
      {
        stepNo: 1,
        approverRole: 'supervisor',
        state: 'approved',
        offlineAuthorized: true,
        reverificationStatus: 'unprovable',
        reason: 'Disetujui saat outlet offline',
      },
    ];
    render(<ApprovalTimeline steps={steps} />);
    expect(screen.getByText('Diotorisasi offline')).toBeInTheDocument();
    expect(
      screen.getByText('Tidak dapat diverifikasi — menunggu tinjauan keuangan'),
    ).toBeInTheDocument();
    expect(screen.getByText('“Disetujui saat outlet offline”')).toBeInTheDocument();
  });
});
