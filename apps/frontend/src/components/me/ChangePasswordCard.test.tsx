import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ChangePasswordCard } from './ChangePasswordCard';
import { ApiError } from '@/lib/api';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: { ...actual.api, post: vi.fn().mockResolvedValue({ ok: true }) },
  };
});

const { api } = await import('@/lib/api');
const post = api.post as unknown as ReturnType<typeof vi.fn>;

// `window.location.assign` is how the card sends the person back to /login after
// every session has been revoked server-side. jsdom's real one warns and does
// nothing useful, so it is replaced with a spy we can assert on.
const assign = vi.fn();
beforeEach(() => {
  post.mockClear();
  assign.mockClear();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, assign },
  });
});

function fill(current: string, next: string, confirm: string) {
  fireEvent.change(screen.getByLabelText(/Kata Sandi Saat Ini/i), { target: { value: current } });
  fireEvent.change(screen.getByLabelText(/^Kata Sandi Baru/i), { target: { value: next } });
  fireEvent.change(screen.getByLabelText(/Ulangi Kata Sandi Baru/i), {
    target: { value: confirm },
  });
}

/**
 * The capability this covers did not exist at all until 2026-09-15: everyone
 * below owner/manager/superadmin was issued a password by whoever created their
 * account and could never change it.
 */
describe('ChangePasswordCard', () => {
  it('will not submit until the current password, an 8+ char new one, and a matching confirmation are all present', () => {
    render(<ChangePasswordCard />);
    const submit = screen.getByRole('button', { name: 'Simpan Kata Sandi' });
    expect(submit).toBeDisabled();

    fill('old-password', 'short', 'short');
    expect(screen.getByText(/minimal 8 karakter/i)).toBeInTheDocument();
    expect(submit).toBeDisabled();

    fill('old-password', 'a-long-enough-one', 'a-different-one');
    expect(screen.getByText(/tidak cocok/i)).toBeInTheDocument();
    expect(submit).toBeDisabled();

    fill('old-password', 'a-long-enough-one', 'a-long-enough-one');
    expect(submit).not.toBeDisabled();
  });

  it('posts to /auth/password and then sends the person back to /login, because every session was just revoked', async () => {
    render(<ChangePasswordCard />);
    fill('old-password', 'a-long-enough-one', 'a-long-enough-one');
    fireEvent.click(screen.getByRole('button', { name: 'Simpan Kata Sandi' }));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith('/auth/password', {
      currentPassword: 'old-password',
      newPassword: 'a-long-enough-one',
    });
    // Staying put would leave the app holding a token the server has revoked,
    // which fails confusingly on the next request instead of here.
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/login'));
  });

  it('names a wrong CURRENT password specifically, instead of a generic failure', async () => {
    post.mockRejectedValueOnce(
      new ApiError(401, 'ERR_AUTH_INVALID_CREDENTIALS', 'Current password is incorrect'),
    );
    render(<ChangePasswordCard />);
    fill('wrong-password', 'a-long-enough-one', 'a-long-enough-one');
    fireEvent.click(screen.getByRole('button', { name: 'Simpan Kata Sandi' }));

    expect(await screen.findByText('Kata sandi saat ini salah.')).toBeInTheDocument();
    // Still on the page, still able to retry — a redirect here would lose the form.
    expect(assign).not.toHaveBeenCalled();
  });

  it('surfaces the server refusal when the new password is the same as the old one', async () => {
    post.mockRejectedValueOnce(
      new ApiError(
        400,
        'ERR_VALIDATION',
        'The new password must be different from the current one',
      ),
    );
    render(<ChangePasswordCard />);
    fill('old-password', 'a-long-enough-one', 'a-long-enough-one');
    fireEvent.click(screen.getByRole('button', { name: 'Simpan Kata Sandi' }));

    // Whatever `errMsg` resolves ERR_VALIDATION to, something must appear and
    // the person must not be redirected as though it had worked.
    await waitFor(() => expect(assign).not.toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'Simpan Kata Sandi' })).not.toBeDisabled();
  });
});
