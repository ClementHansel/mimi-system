import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AddDevicePairingModal } from './AddDevicePairingModal';
import { ApiError } from '@/lib/api';
import { mintDevicePairingToken } from './lib/device-api';

/**
 * Owner: "there is no way to add devices" — `mintDevicePairingToken` (`POST
 * /devices/pairing-tokens`) is the fix, and this modal is its whole UI. The
 * point worth pinning: the submit button stays disabled without a location
 * (minting a token for no location is meaningless — the endpoint 400s), and
 * once minted the raw `token` bearer secret is never rendered, only the
 * human-readable `displayCode` — see the component's own doc comment on why.
 */
vi.mock('./lib/device-api', () => ({
  mintDevicePairingToken: vi.fn(),
}));

const LOCATIONS = [
  { id: 'loc-pusat', name: 'Pusat (Gudang)' },
  { id: 'loc-a', name: 'Outlet Balikpapan Baru' },
];

const MINTED = {
  tokenId: 'tok-1',
  token: 'raw-secret-do-not-render-me',
  displayCode: 'ABCD-EFGH-JKMN',
  qrPayload: 'mimi-pair:device:raw-secret-do-not-render-me',
  expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
};

describe('AddDevicePairingModal', () => {
  beforeEach(() => {
    vi.mocked(mintDevicePairingToken).mockReset();
  });

  it('keeps the submit button disabled until a location is chosen', () => {
    render(<AddDevicePairingModal locations={LOCATIONS} onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Buat Kode Pemasangan/i })).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/Lokasi/i), { target: { value: 'loc-a' } });
    expect(screen.getByRole('button', { name: /Buat Kode Pemasangan/i })).toBeEnabled();
  });

  it('mints a token for the chosen location and shows the display code, never the raw token', async () => {
    vi.mocked(mintDevicePairingToken).mockResolvedValue(MINTED);
    render(<AddDevicePairingModal locations={LOCATIONS} onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/Lokasi/i), { target: { value: 'loc-a' } });
    fireEvent.click(screen.getByRole('button', { name: /Buat Kode Pemasangan/i }));

    await waitFor(() => expect(screen.getByText(MINTED.displayCode)).toBeInTheDocument());

    expect(mintDevicePairingToken).toHaveBeenCalledWith({
      locationId: 'loc-a',
      suggestedCategory: undefined,
    });
    expect(screen.queryByText(MINTED.token)).not.toBeInTheDocument();
  });

  it('shows the server error message and stays on the form when minting fails', async () => {
    vi.mocked(mintDevicePairingToken).mockRejectedValue(
      new ApiError(400, 'ERR_VALIDATION', 'locationId is required'),
    );
    render(<AddDevicePairingModal locations={LOCATIONS} onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/Lokasi/i), { target: { value: 'loc-a' } });
    fireEvent.click(screen.getByRole('button', { name: /Buat Kode Pemasangan/i }));

    await waitFor(() => expect(screen.getByText('locationId is required')).toBeInTheDocument());
    expect(screen.queryByText(MINTED.displayCode)).not.toBeInTheDocument();
  });

  it('pre-selects the location when opened from a specific outlet card', () => {
    render(
      <AddDevicePairingModal locations={LOCATIONS} defaultLocationId="loc-a" onClose={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: /Buat Kode Pemasangan/i })).toBeEnabled();
  });
});
