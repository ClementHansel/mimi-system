import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { api } from '@/lib/api';
import { useConnectivityStore } from '@/stores/connectivity-store';
import type { LocalRuntime } from '@/lib/local/api/local-runtime';
import { VoidRefundModal } from './VoidRefundModal';

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, api: { ...actual.api, post: vi.fn() } };
});

const post = api.post as unknown as ReturnType<typeof vi.fn>;
const runtime = {} as unknown as LocalRuntime;

/**
 * A runtime whose `credentials` store holds one cached approver, so the modal
 * can resolve a real `selfieRequiredAboveIdr`. The default `runtime` above is
 * deliberately empty — `listCachedApproverCredentials` catches and yields no
 * approvers, which is what the other tests here want.
 */
function runtimeWithApprover(selfieRequiredAboveIdr: string): LocalRuntime {
  return {
    db: {
      store: () => ({
        getAll: async () => [
          {
            credentialId: 'cred-1',
            claims: { role: 'supervisor', selfieRequiredAboveIdr },
          },
        ],
      }),
    },
  } as unknown as LocalRuntime;
}

function renderModalWith(runtimeOverride: LocalRuntime) {
  return render(
    <VoidRefundModal
      open
      onClose={() => {}}
      runtime={runtimeOverride}
      actor={actor}
      saleId="sale-1"
    />,
  );
}
const actor = { actorUserId: 'u1', actorRole: 'kasir', appVersion: 'test' };

function renderModal() {
  return render(
    <VoidRefundModal open onClose={() => {}} runtime={runtime} actor={actor} saleId="sale-1" />,
  );
}

/**
 * B-15 — the till's half of the one-time approval code (owner Q8, 2026-08-22).
 *
 * The property worth protecting here is that the ONLINE path no longer has a
 * PIN field at all. That field was the visible end of an endpoint any
 * authenticated caller could brute-force, and a UI that still offers to collect
 * a supervisor's standing PIN online is the strongest possible signal that
 * something reintroduced it.
 */
describe('VoidRefundModal — online, one-time code flow', () => {
  beforeEach(() => {
    post.mockReset();
    useConnectivityStore.setState({ tier: 'online' });
  });

  it('never asks for a supervisor PIN while online', () => {
    renderModal();
    expect(screen.queryByLabelText(/PIN Supervisor/)).not.toBeInTheDocument();
  });

  it('step 1 raises the request only — it does not approve anything', async () => {
    post.mockResolvedValue({ voidRefundId: 'vr-1', status: 'pending' });

    renderModal();
    fireEvent.change(screen.getByLabelText(/Alasan/), {
      target: { value: 'Pelanggan salah pesan' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Ajukan' }));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith(
      '/api/pos/sales/sale-1/void-request',
      expect.objectContaining({ reason: 'Pelanggan salah pesan' }),
    );
  });

  it('step 2 appears after the request, and redeems the code the supervisor read out', async () => {
    post.mockResolvedValueOnce({ voidRefundId: 'vr-1', status: 'pending' });
    renderModal();
    fireEvent.change(screen.getByLabelText(/Alasan/), { target: { value: 'Salah input' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ajukan' }));

    const codeInput = await screen.findByLabelText(/Kode Persetujuan/);
    post.mockResolvedValueOnce({ id: 'vr-1', status: 'approved' });
    fireEvent.change(codeInput, { target: { value: '481920' } });
    fireEvent.click(screen.getByRole('button', { name: 'Konfirmasi Kode' }));

    await waitFor(() =>
      expect(post).toHaveBeenLastCalledWith('/api/pos/void-refunds/vr-1/approve', {
        code: '481920',
      }),
    );
  });

  it('a short code is refused locally — a partial guess must not reach the server and burn an attempt', async () => {
    post.mockResolvedValueOnce({ voidRefundId: 'vr-1', status: 'pending' });
    renderModal();
    fireEvent.change(screen.getByLabelText(/Alasan/), { target: { value: 'Salah input' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ajukan' }));

    const codeInput = await screen.findByLabelText(/Kode Persetujuan/);
    fireEvent.change(codeInput, { target: { value: '4819' } });
    fireEvent.click(screen.getByRole('button', { name: 'Konfirmasi Kode' }));

    // Still exactly the one call from step 1. The caller's five attempts are a
    // scarce resource; spending one on a half-typed code would be the UI
    // locking the till out on the user's behalf.
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  });

  it('strips non-digits as they are typed, so a pasted "481-920" still works', async () => {
    post.mockResolvedValueOnce({ voidRefundId: 'vr-1', status: 'pending' });
    renderModal();
    fireEvent.change(screen.getByLabelText(/Alasan/), { target: { value: 'Salah input' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ajukan' }));

    const codeInput = (await screen.findByLabelText(/Kode Persetujuan/)) as HTMLInputElement;
    fireEvent.change(codeInput, { target: { value: '481-920' } });
    expect(codeInput.value).toBe('481920');
  });
});

describe('VoidRefundModal — offline keeps the cached-credential PIN', () => {
  beforeEach(() => {
    post.mockReset();
    useConnectivityStore.setState({ tier: 'isolated' });
  });

  it('shows no unlock panel while the credential is healthy', async () => {
    renderModal();
    await screen.findByLabelText(/PIN Supervisor/);
    expect(screen.queryByTestId('unlock-challenge')).not.toBeInTheDocument();
  });

  /**
   * RISK-S2 — the selfie gate.
   *
   * Both sides of the gate already existed: `authorizeOffline` refuses with
   * `selfie_required`, and the cloud's §7.4 check 7 marks the authorization
   * `degraded`. What did not exist was any way for the supervisor to KNOW
   * before acting. The camera was offered unconditionally and optionally, so a
   * large void could be attempted, the PIN entered, and only then rejected —
   * with a customer waiting. A control that presents as an unexplained refusal
   * after the work is done is one people learn to route around.
   */
  it('RISK-S2: a void at or above the credential threshold cannot be submitted without a selfie', async () => {
    renderModalWith(runtimeWithApprover('200000.00'));
    await screen.findByLabelText(/PIN Supervisor/);

    // Pick the approver, as a supervisor would — the threshold belongs to a
    // specific credential, so nothing can be required until one is chosen.
    fireEvent.change(await screen.findByLabelText(/Supervisor Penyetuju/), {
      target: { value: 'cred-1' },
    });
    // MoneyInput strips non-digits on change and commits on BLUR, so typing
    // alone leaves the parent's `amount` null — the focus/blur is the part that
    // actually sets it.
    const amountField = await screen.findByLabelText(/Jumlah/);
    fireEvent.focus(amountField);
    fireEvent.change(amountField, { target: { value: '250000' } });
    fireEvent.blur(amountField);

    // The label says "wajib" AND a hint names the amount that triggered it — a
    // requirement whose trigger is invisible reads as arbitrary. Asserted
    // separately rather than with one loose matcher, because both carrying the
    // word is the point.
    await screen.findByText('Foto Selfie Supervisor (wajib)');
    expect(screen.getByText(/Void di atas Rp200000\.00/)).toBeInTheDocument();

    // And the button is genuinely blocked, not merely annotated.
    const submit = screen.getByRole('button', { name: 'Ajukan' });
    expect(submit).toBeDisabled();
  });

  it('RISK-S2: a void BELOW the threshold is submittable with no selfie', async () => {
    // The gate has to be a threshold, not a blanket requirement. Demanding a
    // photo for every small void would push staff to void twice under the
    // limit instead — the control has to stay proportionate to stay used.
    renderModalWith(runtimeWithApprover('200000.00'));
    await screen.findByLabelText(/PIN Supervisor/);

    fireEvent.change(await screen.findByLabelText(/Supervisor Penyetuju/), {
      target: { value: 'cred-1' },
    });
    const amountField = await screen.findByLabelText(/Jumlah/);
    fireEvent.focus(amountField);
    fireEvent.change(amountField, { target: { value: '50000' } });
    fireEvent.blur(amountField);

    await waitFor(() => {
      expect(screen.queryByText(/wajib/i)).not.toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Ajukan' })).not.toBeDisabled();
  });

  it('still offers the supervisor PIN field, because no server exists to mint a code', async () => {
    renderModal();
    // Not a regression: offline authorization is the one place a standing PIN
    // is still the mechanism (D-17's cached `pin_verifier`). Removing it here
    // would leave an outage with no way to void at all. The offline recovery
    // story is tracked separately — see B-17 in docs/PROGRESS.md.
    expect(await screen.findByLabelText(/PIN Supervisor/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Kode Persetujuan/)).not.toBeInTheDocument();
  });
});
