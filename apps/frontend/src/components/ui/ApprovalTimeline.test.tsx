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
        // `actedBy` is the user ID and `actedByName` is the person. This test
        // used to pass 'Budi Santoso' as `actedBy`, which is not a shape the
        // API can produce and hid the defect below.
        actedBy: '640218f4-cdbd-4d65-80ae-8b1c31ececc0',
        actedByName: 'Budi Santoso',
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

  /**
   * WHO APPROVED IT IS A NAME, NEVER AN ID.
   *
   * The timeline rendered `actedBy` — the approver's user ID — where the person
   * belongs: "1 Sep 2026, 14.28 WITA oleh 640218f4-cdbd-4d65-80ae-8b1c31ececc0".
   * Found 2026-09-02 driving a warehouse approval as owner. The same class of
   * defect had already shipped twice (a UUID in the Gudang request queue, a
   * payee ID in Finance), so this asserts the ID is ABSENT, not merely that the
   * name is present — rendering both would read as fixed and still leak it.
   */
  it('names the approver and never prints their id', () => {
    const actorId = '640218f4-cdbd-4d65-80ae-8b1c31ececc0';
    const steps: ApprovalStepView[] = [
      {
        stepNo: 1,
        approverRole: 'supervisor',
        state: 'approved',
        actedBy: actorId,
        actedByName: 'Budi Santoso',
        actedAt: '2026-08-15T02:00:00.000Z',
      },
    ];
    const { container } = render(<ApprovalTimeline steps={steps} />);

    expect(screen.getByText(/Budi Santoso/)).toBeInTheDocument();
    expect(container.textContent, 'the approver user id is on screen').not.toContain(actorId);
  });

  it('falls back to the timestamp alone when the name is unavailable', () => {
    // A step can be recorded with an actor whose user row is gone (or an
    // auto-approval). Better to show only when it happened than to fill the gap
    // with an id.
    const actorId = '640218f4-cdbd-4d65-80ae-8b1c31ececc0';
    const steps: ApprovalStepView[] = [
      {
        stepNo: 1,
        approverRole: 'supervisor',
        state: 'approved',
        actedBy: actorId,
        actedByName: null,
        actedAt: '2026-08-15T02:00:00.000Z',
      },
    ];
    const { container } = render(<ApprovalTimeline steps={steps} />);

    expect(container.textContent).not.toContain(actorId);
    expect(screen.getByText(/Langkah 1/)).toBeInTheDocument();
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
