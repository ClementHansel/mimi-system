import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ApiError, api } from '@/lib/api';
import { translate } from '@/lib/i18n';
import { DevicePairingModal } from './DevicePairingModal';
import type { LocalRuntime } from '@/lib/local/api/local-runtime';

/**
 * The pairing screen is the ONLY way an unpaired tablet obtains a device
 * credential (CONTRACTS §4.21). Before it existed nothing in the client ever
 * called `/devices/register`, so `devices` stayed empty and the sync engine's
 * `hasDeviceCredential` gate silently short-circuited forever. These tests pin
 * the two behaviours that make it work: the human display code is normalized
 * before it leaves the browser, and a rejected code stores nothing.
 */
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, api: { ...actual.api, get: vi.fn(), post: vi.fn() } };
});

const post = api.post as unknown as ReturnType<typeof vi.fn>;

const RELOAD = vi.fn();
const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? 'dev';
const originalLocation = window.location;

/** The runtime surface the modal actually uses — a fake, not the browser one. */
function runtimeWith() {
  return {
    getIdentity: vi.fn().mockResolvedValue({ fingerprint: 'fp-1', deviceToken: null }),
    completeRegistration: vi.fn().mockResolvedValue(undefined),
  } as unknown as LocalRuntime;
}

function renderModal(runtime: LocalRuntime) {
  return render(<DevicePairingModal open runtime={runtime} onClose={() => {}} />);
}

async function enterCode(code: string) {
  const input = await screen.findByLabelText('Kode 12 karakter');
  fireEvent.change(input, { target: { value: code } });
  fireEvent.click(screen.getByRole('button', { name: 'Sambungkan' }));
}

describe('DevicePairingModal — pair a POS tablet', () => {
  beforeEach(() => {
    post.mockReset();
    RELOAD.mockReset();
    // jsdom's real `location.reload` throws "Not implemented"; a spy keeps the
    // post-pairing refresh observable instead of noisy.
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, reload: RELOAD },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
    });
  });

  it('submits the normalized display code and forwards the credential', async () => {
    const runtime = runtimeWith();
    const response = {
      deviceId: 'dev-1',
      deviceToken: 'tok-1',
      location: { id: 'loc-1', code: 'OUT1', name: 'Outlet Cempaka' },
      nodeLanUrl: null,
      syncConfig: { cloudUrl: 'https://mimi.example.com', protocolV: 1 },
    };
    post.mockResolvedValue(response);

    renderModal(runtime);

    // Typed the way an admin reads it out: lowercase, with separators. The
    // backend matches `display_code` exactly, so the browser owns normalization.
    await enterCode('abc-def-ghi-jkl');

    await waitFor(() => {
      expect(post).toHaveBeenCalledWith('/devices/register', {
        displayCode: 'ABCDEFGHIJKL',
        fingerprint: 'fp-1',
        category: 'tablet',
        appVersion: APP_VERSION,
      });
    });
    await waitFor(() => {
      expect(runtime.completeRegistration).toHaveBeenCalledWith(response);
    });
    expect(RELOAD).toHaveBeenCalled();
  });

  it('shows the inline danger message and stores nothing when the code is rejected', async () => {
    const runtime = runtimeWith();
    post.mockRejectedValue(
      new ApiError(401, 'ERR_AUTH_TOKEN_INVALID', 'Invalid or expired pairing token'),
    );

    renderModal(runtime);

    await enterCode('zzz-zzz-zzz-zzz');

    // The danger paragraph is the only user-visible feedback (no toast here).
    const inline = await waitFor(() => {
      const el = document.querySelector('p.text-danger-600');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(inline).toHaveTextContent(translate('pos.pairing.invalid'));
    // The backend's message is deliberately opaque and developer-facing; it must
    // never be what the cashier reads.
    expect(screen.queryByText(/Invalid or expired pairing token/)).not.toBeInTheDocument();
    expect(runtime.completeRegistration).not.toHaveBeenCalled();
    expect(RELOAD).not.toHaveBeenCalled();
  });

  it('shows the length hint for an 11-character code and never calls the API', async () => {
    const runtime = runtimeWith();

    renderModal(runtime);

    await enterCode('abc-def-ghi-jk'); // 11 characters after normalization.

    const inline = await waitFor(() => {
      const el = document.querySelector('p.text-danger-600');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(inline).toHaveTextContent(translate('pos.pairing.lengthHint'));
    expect(post).not.toHaveBeenCalled();
    expect(runtime.completeRegistration).not.toHaveBeenCalled();
  });

  it('shows the session-expired copy when the rejection is about the access token', async () => {
    const runtime = runtimeWith();
    post.mockRejectedValue(
      new ApiError(401, 'ERR_AUTH_TOKEN_INVALID', 'Invalid or expired access token'),
    );

    renderModal(runtime);

    await enterCode('abc-def-ghi-jkl');

    const inline = await waitFor(() => {
      const el = document.querySelector('p.text-danger-600');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(inline).toHaveTextContent(translate('pos.pairing.sessionExpired'));
    expect(runtime.completeRegistration).not.toHaveBeenCalled();
    expect(RELOAD).not.toHaveBeenCalled();
  });
});
