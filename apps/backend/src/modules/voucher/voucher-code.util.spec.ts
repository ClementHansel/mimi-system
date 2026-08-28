/**
 * Code minting — the only thing standing between a stranger and a discount.
 *
 * These assertions are about SHAPE and DISTRIBUTION, not about randomness in
 * the cryptographic sense (you cannot unit-test a CSPRNG, and trying to
 * produces a flaky test that fails once a quarter for no reason). What CAN be
 * pinned down is everything that would silently break if somebody swapped the
 * entropy source or edited the alphabet: the printed format, the alphabet
 * membership, the absence of confusable characters, and that consecutive
 * mints do not repeat.
 */
import { describe, expect, it } from 'vitest';
import {
  VOUCHER_CODE_ALPHABET,
  VOUCHER_CODE_PREFIX,
  isVoucherCode,
  normalizeVoucherCode,
} from '@mimi/shared';
import { mintVoucherCode } from './voucher-code.util';

describe('mintVoucherCode', () => {
  it('produces the canonical MC-XXXX-XXXX form', () => {
    for (let i = 0; i < 200; i++) {
      const code = mintVoucherCode();
      expect(code).toMatch(/^MC-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
      expect(isVoucherCode(code)).toBe(true);
    }
  });

  it('draws every character from the shared alphabet, never from outside it', () => {
    // The alphabet deliberately excludes I, L, O and U — the characters a
    // human misreads over a counter, and the one that makes accidental
    // profanity possible in an 8-character block. A code containing one would
    // mean the minter is no longer using `formatVoucherCode`.
    const alphabet = new Set(VOUCHER_CODE_ALPHABET.split(''));
    for (let i = 0; i < 200; i++) {
      const body = mintVoucherCode()
        .slice(VOUCHER_CODE_PREFIX.length + 1)
        .replace('-', '');
      expect(body).toHaveLength(8);
      for (const char of body) expect(alphabet.has(char)).toBe(true);
    }
    for (const excluded of ['I', 'L', 'O', 'U']) {
      expect(alphabet.has(excluded)).toBe(false);
    }
  });

  it('round-trips through normalizeVoucherCode unchanged', () => {
    // A minted code is already canonical, so normalising it must be identity.
    // If it were not, the till would look up a different string from the one
    // printed on the card.
    for (let i = 0; i < 100; i++) {
      const code = mintVoucherCode();
      expect(normalizeVoucherCode(code)).toBe(code);
    }
  });

  it('does not repeat across a large batch', () => {
    /**
     * 5000 is `IssueVouchersDto`'s own ceiling — one maximal print run. Over a
     * 32^8 (~1.1e12) space the birthday probability of ANY collision in 5000
     * draws is about 1.1e-5, so this assertion is not meaningfully flaky; but
     * it fails INSTANTLY and every time if the entropy source is broken (a
     * constant seed, a stubbed `randomBytes`), which is the failure it exists
     * to catch. `VoucherService.issue`'s retry loop is what handles a genuine
     * collision in production — this is about detecting an absent one.
     */
    const codes = new Set<string>();
    for (let i = 0; i < 5000; i++) codes.add(mintVoucherCode());
    expect(codes.size).toBe(5000);
  });

  it('spreads across the alphabet rather than favouring a slice of it', () => {
    /**
     * Guards the modulo-bias trap `voucher-code.util.ts`'s header documents.
     * `byte % 32` is exactly uniform only because 256 is a multiple of 32 — a
     * 33-symbol alphabet would quietly make the first 31 symbols ~3% more
     * likely. That skew is far too small for this test to detect directly, so
     * this asserts the coarser property that actually breaks first: every
     * symbol shows up. A biased-but-still-broad source passes here and is
     * caught by the length assertion in the util itself, which throws at
     * import time.
     */
    const seen = new Set<string>();
    for (let i = 0; i < 4000; i++) {
      for (const char of mintVoucherCode().replace(/[-]/g, '').slice(2)) seen.add(char);
    }
    expect(seen.size).toBe(VOUCHER_CODE_ALPHABET.length);
  });
});
