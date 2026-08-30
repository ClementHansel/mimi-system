import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CutiPanel } from './CutiPanel';
import { createLeaveRequest, getMyLeaves } from './lib/me-api';
import { uploadLeaveAttachment } from '@/components/hr/lib/attachments';

/**
 * Leave requests can now carry a supporting document — a doctor's note, a
 * wedding invitation. `leave_requests.attachment_id` and the `POST /hr/leaves`
 * DTO have both accepted one all along; there was simply no way to send it,
 * so every row was NULL and an approver had nothing to check a `sick` request
 * against.
 *
 * The behaviour worth pinning is the ORDER. Uploading after creating the
 * request would, on a failed upload, leave a leave request that is approvable,
 * looks complete, and has nothing behind it — the worst of the available
 * outcomes, and invisible to everyone downstream.
 */
vi.mock('./lib/me-api', () => ({
  getMyLeaves: vi.fn(),
  createLeaveRequest: vi.fn(),
  cancelLeaveRequest: vi.fn(),
}));
vi.mock('@/components/hr/lib/attachments', () => ({ uploadLeaveAttachment: vi.fn() }));
// The link resolves an id through the network; this panel's own tests are
// about submitting, and `LeaveAttachmentLink` has its own spec.
vi.mock('@/lib/attachment-url', () => ({ resolveAttachmentUrl: vi.fn().mockResolvedValue(null) }));

const EMPTY = {
  leaves: [],
  quota: { annual: { total: 12, used: 0 }, marriage: { total: 3, used: 0 } },
  quotaUnavailable: false,
};

/** `fireEvent`, not `user-event` — the latter is not a dependency of this app. */
async function openFormAndFillDates() {
  render(<CutiPanel />);
  fireEvent.click(await screen.findByRole('button', { name: /Ajukan Cuti/i }));

  const dates = document.querySelectorAll('input[type="date"]');
  fireEvent.change(dates[0] as HTMLInputElement, { target: { value: '2026-09-01' } });
  fireEvent.change(dates[1] as HTMLInputElement, { target: { value: '2026-09-02' } });
}

function attach(file: File) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  expect(input, 'the form must offer a way to attach a document').toBeTruthy();
  fireEvent.change(input, { target: { files: [file] } });
}

const NOTE = () => new File(['x'], 'surat-dokter.pdf', { type: 'application/pdf' });

describe('CutiPanel — leave request with a supporting document', () => {
  beforeEach(() => {
    vi.mocked(getMyLeaves).mockReset().mockResolvedValue(EMPTY);
    vi.mocked(createLeaveRequest).mockReset().mockResolvedValue({} as never);
    vi.mocked(uploadLeaveAttachment).mockReset();
  });

  it('sends the uploaded attachment id with the request', async () => {
    vi.mocked(uploadLeaveAttachment).mockResolvedValue('att-99');
    await openFormAndFillDates();
    attach(NOTE());

    fireEvent.click(screen.getByRole('button', { name: /Simpan/i }));

    await waitFor(() => expect(createLeaveRequest).toHaveBeenCalled());
    expect(vi.mocked(createLeaveRequest).mock.calls[0]![0]).toMatchObject({
      attachmentId: 'att-99',
    });
  });

  it('creates nothing when the upload fails', async () => {
    vi.mocked(uploadLeaveAttachment).mockRejectedValue(new Error('Upload gagal (500)'));
    await openFormAndFillDates();
    attach(NOTE());

    fireEvent.click(screen.getByRole('button', { name: /Simpan/i }));

    await waitFor(() => expect(uploadLeaveAttachment).toHaveBeenCalled());
    // The whole point of uploading first. A created-then-orphaned request
    // would sail through approval with no evidence behind it.
    expect(createLeaveRequest).not.toHaveBeenCalled();
  });

  it('still submits without a document, since most leave types need none', async () => {
    await openFormAndFillDates();
    fireEvent.click(screen.getByRole('button', { name: /Simpan/i }));

    await waitFor(() => expect(createLeaveRequest).toHaveBeenCalled());
    expect(uploadLeaveAttachment).not.toHaveBeenCalled();
    expect(vi.mocked(createLeaveRequest).mock.calls[0]![0].attachmentId).toBeUndefined();
  });
});
