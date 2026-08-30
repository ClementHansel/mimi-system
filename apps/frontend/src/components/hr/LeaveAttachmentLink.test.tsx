import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { LeaveAttachmentLink } from './LeaveAttachmentLink';
import { resolveAttachmentUrl } from '@/lib/attachment-url';

/**
 * A leave request's supporting document is the thing that makes a `sick`
 * request checkable instead of taken on trust, so the interesting cases are
 * the ones where it CANNOT be shown — those are where an approver is most
 * likely to be misled.
 *
 * The API hands over an attachment ID, never a URL. That distinction is the
 * whole reason this component exists, and getting it wrong is not theoretical:
 * the finance selfie and payment-proof surfaces both put a raw S3 object key
 * straight into the DOM, which the browser resolved against the current page
 * and 404'd, and nobody noticed because a broken image and a dead link both
 * look like "there was nothing here".
 */
vi.mock('@/lib/attachment-url', () => ({ resolveAttachmentUrl: vi.fn() }));

describe('LeaveAttachmentLink', () => {
  beforeEach(() => {
    vi.mocked(resolveAttachmentUrl).mockReset();
  });

  it('renders a real link once the id is presigned', async () => {
    vi.mocked(resolveAttachmentUrl).mockResolvedValue('https://storage.example/signed?sig=abc');
    render(<LeaveAttachmentLink attachmentId="att-1" />);

    const link = await screen.findByRole('link');
    expect(link).toHaveAttribute('href', 'https://storage.example/signed?sig=abc');
    // Opening evidence must not navigate the approver away from the queue they
    // are working through.
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('presigns the id rather than rendering it, which is the bug this replaces', async () => {
    vi.mocked(resolveAttachmentUrl).mockResolvedValue('https://storage.example/signed');
    render(<LeaveAttachmentLink attachmentId="att-1" />);

    await screen.findByRole('link');
    expect(resolveAttachmentUrl).toHaveBeenCalledWith('att-1');
    // The raw id must never reach an href. Asserting on the DOM rather than
    // only on the call, because "we called the helper AND still rendered the
    // id" is a real way to half-fix this.
    expect(screen.getByRole('link')).not.toHaveAttribute('href', 'att-1');
  });

  it('says a document exists even when it cannot be opened', async () => {
    // `resolveAttachmentUrl` returns null on any failure rather than throwing.
    // Rendering an em dash here would tell the approver there is NO document,
    // which is the opposite of the truth and worse than showing nothing at
    // all — they would approve believing none was ever attached.
    vi.mocked(resolveAttachmentUrl).mockResolvedValue(null);
    render(<LeaveAttachmentLink attachmentId="att-1" />);

    await waitFor(() => expect(resolveAttachmentUrl).toHaveBeenCalled());
    expect(screen.getByText('Lihat Lampiran')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('shows nothing to open when there genuinely is no document', () => {
    render(<LeaveAttachmentLink attachmentId={null} />);

    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    // No id means no reason to ask the server anything.
    expect(resolveAttachmentUrl).not.toHaveBeenCalled();
  });

  it('does not show one request’s document against another', async () => {
    // Table rows get recycled as the approver pages or filters. Without the
    // effect's `cancelled` guard, a presign still in flight for the previous
    // row resolves after the new one has mounted and lands the wrong
    // employee's medical note under the wrong name.
    let releaseFirst: (url: string | null) => void = () => {};
    vi.mocked(resolveAttachmentUrl).mockImplementationOnce(
      () => new Promise((resolve) => (releaseFirst = resolve)),
    );
    const { rerender } = render(<LeaveAttachmentLink attachmentId="att-slow" />);

    vi.mocked(resolveAttachmentUrl).mockResolvedValueOnce('https://storage.example/second');
    rerender(<LeaveAttachmentLink attachmentId="att-second" />);
    await screen.findByRole('link');

    // `act` so the stale promise's `.then` runs AND React flushes whatever it
    // schedules. A bare `await Promise.resolve()` here let the assertion run
    // before the stale update landed, so this test passed even with the
    // `cancelled` guard deleted — it proved nothing until this line.
    await act(async () => {
      releaseFirst('https://storage.example/FIRST-should-never-appear');
    });

    expect(screen.getByRole('link')).toHaveAttribute('href', 'https://storage.example/second');
  });
});
