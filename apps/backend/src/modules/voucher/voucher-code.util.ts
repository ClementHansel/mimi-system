import { randomBytes } from 'node:crypto';
import {
  VOUCHER_CODE_ALPHABET,
  VOUCHER_CODE_BODY_LENGTH,
  formatVoucherCode,
} from '@mimi/shared';

/**
 * Minting the random half of a voucher code.
 *
 * WHY `crypto.randomBytes` AND NEVER `Math.random`
 * ------------------------------------------------
 * A voucher code IS a bearer instrument: whoever can produce a valid,
 * unredeemed code gets money off. `Math.random` in V8 is xorshift128+, which
 * is not a CSPRNG and is not trying to be — it is seeded from a small amount
 * of entropy and its internal state is recoverable from a modest number of
 * consecutive outputs. Someone holding a handful of legitimately-issued
 * coupons from one print run would be holding consecutive outputs. That turns
 * "guess a code" from a 32^8 search into arithmetic.
 *
 * 32^8 is 2^40 ≈ 1.1e12 possible codes. That is a large space, but it is the
 * ONLY thing standing between a stranger and a discount, so it must be
 * genuinely uniform and genuinely unpredictable, not merely large.
 *
 * WHY `byte % 32` IS UNBIASED HERE, WHICH IS NOT USUALLY TRUE
 * -----------------------------------------------------------
 * Reducing a random byte modulo N is the classic modulo-bias mistake: for a
 * general N the low residues get one extra representative each and come up
 * slightly more often. It is safe here for one specific reason —
 * `VOUCHER_CODE_ALPHABET` has EXACTLY 32 symbols and 256 = 8 × 32 with no
 * remainder, so every symbol has exactly 8 of the 256 byte values mapping to
 * it. The distribution is exactly uniform, with no rejection sampling needed.
 *
 * That is not a coincidence: the shared alphabet was chosen as 32 symbols
 * precisely so a code carries 5 bits per character drawn from bytes with no
 * bias (see `packages/shared/src/voucher/index.ts`). This assertion below is
 * what keeps that true — if anybody ever adds or removes a symbol, this
 * throws at module load rather than silently making some codes more likely
 * than others.
 *
 * The formatting itself (dashes, the `MC-` prefix, the index→symbol map) stays
 * in `@mimi/shared`'s `formatVoucherCode`, which is pure and takes INDICES
 * exactly so each runtime can supply its own entropy source. This file is the
 * backend's entropy source and nothing more.
 */

if (VOUCHER_CODE_ALPHABET.length !== 32) {
  throw new Error(
    `VOUCHER_CODE_ALPHABET must be exactly 32 symbols for unbiased byte→symbol mapping, got ${VOUCHER_CODE_ALPHABET.length}. ` +
      'Either restore a 32-symbol alphabet or replace the modulo reduction in voucher-code.util.ts with rejection sampling.',
  );
}

/** One cryptographically-random `MC-XXXX-XXXX` code. */
export function mintVoucherCode(): string {
  const bytes = randomBytes(VOUCHER_CODE_BODY_LENGTH);
  // `formatVoucherCode` applies `% alphabet.length` itself; passing raw byte
  // values through is deliberate and, per the header, exactly uniform.
  return formatVoucherCode(Array.from(bytes));
}
