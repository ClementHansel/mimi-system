import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const post = vi.fn();
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, api: { ...actual.api, post: (...args: unknown[]) => post(...args) } };
});

const { VoucherEntry } = await import('./VoucherEntry');

/**
 * `checkVoucher`'s own header states the rule these tests enforce: "'tidak
 * berlaku' with no reason is what makes a queue argue". The closed
 * `VoucherRejection` list exists so every refusal has ONE code and ONE
 * sentence a cashier can read out — a customer told "expired" walks away, a
 * customer told "invalid" asks the cashier to try again three times while the
 * queue builds.
 *
 * So the assertion is not "an error is shown" but "THIS error is shown, and
 * the others are not". A mapping that silently collapsed two codes onto one
 * message would pass a laxer test and fail a real Saturday evening.
 */

const CASES: [code: string, message: string][] = [
  ['ERR_VOUCHER_NOT_FOUND', 'Kode voucher tidak ditemukan.'],
  ['ERR_VOUCHER_NOT_ACTIVE', 'Voucher ini sudah pernah dipakai atau sudah dibatalkan.'],
  ['ERR_VOUCHER_NOT_STARTED', 'Voucher ini belum berlaku.'],
  ['ERR_VOUCHER_EXPIRED', 'Masa berlaku voucher ini sudah habis.'],
  ['ERR_VOUCHER_BELOW_MINIMUM', 'Belanja belum mencapai minimum untuk voucher ini.'],
  ['ERR_VOUCHER_WRONG_LOCATION', 'Voucher ini tidak berlaku di outlet ini.'],
  [
    'ERR_VOUCHER_OFFLINE_BLOCKED',
    'Voucher tidak bisa diperiksa saat perangkat offline. Coba lagi setelah tersambung.',
  ],
];

function renderEntry(onApplied = vi.fn()) {
  render(
    <VoucherEntry
      subtotal="150000.00"
      locationId="loc-1"
      applied={null}
      onApplied={onApplied}
    />,
  );
  return onApplied;
}

function typeCode(code = 'MC-7K2P-9XQ4') {
  fireEvent.change(screen.getByLabelText('Kode Voucher'), { target: { value: code } });
  fireEvent.click(screen.getByRole('button', { name: 'Terapkan' }));
}

describe('VoucherEntry — every refusal gets its own sentence', () => {
  beforeEach(() => post.mockReset());

  it.each(CASES)('maps %s to its own message', async (code, message) => {
    // `/vouchers/check` answers 200 in BOTH arms — a refusal is a business
    // answer, not a failed request — so this is the path that actually runs
    // in production.
    post.mockResolvedValue({ ok: false, code });
    renderEntry();
    typeCode();
    expect(await screen.findByText(message)).toBeInTheDocument();
  });

  it('gives every refusal a DISTINCT message', () => {
    const messages = CASES.map(([, message]) => message);
    expect(new Set(messages).size).toBe(messages.length);
  });

  it('still gives a sentence for a refusal code it has never seen', async () => {
    // Forward compatibility, and the reason the mapping has a fallback at all.
    // `VoucherRejection` is a closed list TODAY; the day the server adds an
    // eighth reason and this dictionary has not caught up, the cashier must
    // still get a sentence rather than `voucher.pos.error.ERR_VOUCHER_BLOCKED`
    // printed on the till.
    //
    // The same fallback covers the `catch` arm — a dropped connection on
    // mobile data rejects before `apiFetch` ever sees a status, and the code
    // maps whatever that carries through this identical table.
    post.mockResolvedValue({ ok: false, code: 'ERR_VOUCHER_SOMETHING_NEW' });
    renderEntry();
    typeCode();
    expect(await screen.findByText('Voucher tidak bisa diperiksa. Coba lagi.')).toBeInTheDocument();
  });

  it('rejects a code that cannot be a voucher code without a round trip', async () => {
    // `normalizeVoucherCode` is the SAME function the server normalises with,
    // so a `null` here means no server lookup could ever succeed. Asking
    // anyway would cost a network round trip during a rush to be told
    // "not found" — a worse answer than "that is not a voucher code".
    renderEntry();
    typeCode('12');
    expect(
      await screen.findByText('Format kode tidak dikenali. Kode voucher berbentuk MC-XXXX-XXXX.'),
    ).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });
});

describe('VoucherEntry — applying', () => {
  beforeEach(() => post.mockReset());

  it('sends the CANONICAL code, not what the cashier typed', async () => {
    // A cashier reading a coupon aloud types `mc7k2p9xq4`, or types O for 0.
    // The shared normaliser fixes both; sending the raw input would make the
    // server's own normalisation the only thing standing between a valid
    // coupon and a refusal.
    post.mockResolvedValue({
      ok: true,
      voucherId: 'v-1',
      code: 'MC-7K2P-9XQ4',
      discount: '15000.00',
      batchName: 'Promo Pembukaan',
    });
    const onApplied = renderEntry();
    typeCode('mc7k2p9xq4');

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith('/vouchers/check', {
      code: 'MC-7K2P-9XQ4',
      subtotal: '150000.00',
      locationId: 'loc-1',
    });
    expect(onApplied).toHaveBeenCalledWith({
      voucherId: 'v-1',
      code: 'MC-7K2P-9XQ4',
      discount: '15000.00',
      batchName: 'Promo Pembukaan',
    });
  });

  it('tells the cashier the discount is a preview, not the final figure', () => {
    // The server recomputes when the sale lands and its number is the one that
    // reaches the ledger. The same honesty rule `statusForMethod` follows for
    // a bank transfer: never let the till imply more finality than it has.
    render(
      <VoucherEntry
        subtotal="150000.00"
        locationId="loc-1"
        applied={{
          voucherId: 'v-1',
          code: 'MC-7K2P-9XQ4',
          discount: '15000.00',
          batchName: 'Promo Pembukaan',
        }}
        onApplied={vi.fn()}
      />,
    );
    expect(screen.getByText(/dihitung ulang oleh sistem pusat/i)).toBeInTheDocument();
  });
});
