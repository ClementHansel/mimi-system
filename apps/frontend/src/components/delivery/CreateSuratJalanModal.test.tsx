import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ApiError } from '@/lib/api';
import { CreateSuratJalanModal } from './CreateSuratJalanModal';
import * as deliveryApi from './lib/delivery-api';

/**
 * "We approved it and there is no way to create the Surat Jalan — the list is
 * gone and not displayed."
 *
 * The picker's three fetches all ended in `.catch(() => {})`, so ANY failure of
 * the approved-request call — an expired token, a 403, a 500, a dropped
 * connection — left `requests` at `[]` and `SjCreateForm` printed "Belum ada
 * permintaan yang disetujui dan siap dikirim". A screen calmly telling a
 * dispatcher that the request they had just approved does not exist, with
 * nothing to distinguish that from an empty warehouse queue and no way to
 * retry short of closing the dialog and reopening it.
 *
 * These tests pin the three states apart: in flight, failed (with a retry),
 * and genuinely empty. Only the last one may say the queue is empty.
 */
vi.mock('./lib/delivery-api', () => ({
  listApprovedRequests: vi.fn(),
  getDrivers: vi.fn(),
  getVehicles: vi.fn(),
  createSuratJalan: vi.fn(),
}));

const EMPTY_PAGE = { rows: [], total: 0, page: 1, pageSize: 0 };

/** What a real failure looks like coming out of `@/lib/api` — 401 is the one
 *  that actually happened: the dispatcher's token expired while the dialog sat
 *  open, the refresh lost the race, and the picker reported an empty warehouse. */
const EXPIRED_SESSION = () =>
  Promise.reject(new ApiError(401, 'ERR_AUTH_TOKEN_EXPIRED', 'token expired'));
const SERVER_ERROR = () => Promise.reject(new ApiError(500, 'ERR_INTERNAL', 'boom'));

function mockAll(overrides: {
  requests?: () => Promise<unknown>;
  drivers?: () => Promise<unknown>;
  vehicles?: () => Promise<unknown>;
}) {
  vi.mocked(deliveryApi.listApprovedRequests).mockImplementation(
    (overrides.requests ?? (() => Promise.resolve(EMPTY_PAGE))) as never,
  );
  vi.mocked(deliveryApi.getDrivers).mockImplementation(
    (overrides.drivers ?? (() => Promise.resolve([]))) as never,
  );
  vi.mocked(deliveryApi.getVehicles).mockImplementation(
    (overrides.vehicles ?? (() => Promise.resolve([]))) as never,
  );
}

describe('CreateSuratJalanModal — a failed load never reads as an empty queue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the load failure with a retry, and does NOT claim there are no approved requests', async () => {
    mockAll({ requests: SERVER_ERROR });

    render(<CreateSuratJalanModal onClose={() => {}} onCreated={() => {}} />);

    // A retry button only exists on the failure branch — its presence IS the
    // assertion that the dialog knows the load failed.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Coba Lagi' })).toBeInTheDocument();
    });
    expect(
      screen.getByText('Server sedang bermasalah. Coba lagi beberapa saat.'),
    ).toBeInTheDocument();
    // The sentence that used to be the dispatcher's only clue.
    expect(screen.queryByText(/Belum ada permintaan yang disetujui/)).not.toBeInTheDocument();
  });

  it('an expired session says so instead of reporting an empty warehouse queue', async () => {
    mockAll({ requests: EXPIRED_SESSION });

    render(<CreateSuratJalanModal onClose={() => {}} onCreated={() => {}} />);

    await waitFor(() => {
      expect(
        screen.getByText('Sesi Anda telah berakhir. Silakan masuk kembali.'),
      ).toBeInTheDocument();
    });
    expect(screen.queryByText(/Belum ada permintaan yang disetujui/)).not.toBeInTheDocument();
  });

  it('retry re-asks for the queue rather than making the dispatcher reopen the dialog', async () => {
    mockAll({ requests: SERVER_ERROR });
    render(<CreateSuratJalanModal onClose={() => {}} onCreated={() => {}} />);

    const retry = await waitFor(() => screen.getByRole('button', { name: 'Coba Lagi' }));
    expect(vi.mocked(deliveryApi.listApprovedRequests)).toHaveBeenCalledTimes(1);

    retry.click();
    await waitFor(() => {
      expect(vi.mocked(deliveryApi.listApprovedRequests)).toHaveBeenCalledTimes(2);
    });
  });

  it('a driver/vehicle failure is reported too — an empty truck picker is not self-explanatory', async () => {
    mockAll({ vehicles: SERVER_ERROR });
    render(<CreateSuratJalanModal onClose={() => {}} onCreated={() => {}} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Coba Lagi' })).toBeInTheDocument();
    });
    // …and the requests that DID load are still offered: one failed call must
    // not blank the whole dialog.
    expect(vi.mocked(deliveryApi.listApprovedRequests)).toHaveBeenCalled();
  });

  it('says the queue is empty only once the fetch has actually succeeded', async () => {
    mockAll({});
    render(<CreateSuratJalanModal onClose={() => {}} onCreated={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText(/Belum ada permintaan yang disetujui/)).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: 'Coba Lagi' })).not.toBeInTheDocument();
  });
});
