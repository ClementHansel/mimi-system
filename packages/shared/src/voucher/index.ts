/**
 * Vouchers — the discount coupon a customer hands over at the till.
 *
 * WHY THE RULES LIVE HERE AND NOT IN THE POS OR THE BACKEND
 * ---------------------------------------------------------
 * A voucher is redeemed at a till that may be OFFLINE (FR-POS-01, D-13: the
 * outlet keeps selling through a WAN cut). So the same three questions —
 * "is this code well-formed", "may it be used on this basket", "how much is
 * it worth" — are answered twice: once on the device, to tell the cashier
 * yes/no in front of the customer, and once on the server when the sale
 * eventually syncs. If those two answers can differ, the outcome is a receipt
 * that says Rp 10.000 off and a ledger that says Rp 0 — a cash variance the
 * supervisor gets blamed for. So the calculators are pure, shared, and used
 * by both sides, exactly like `recipe/explosion.ts` and
 * `offline/unlock-code.ts`.
 *
 * WHAT IS *NOT* SHARED, DELIBERATELY: "has this specific code already been
 * redeemed?" A device cannot answer that — it holds a snapshot, and two tills
 * can take the same coupon in the same minute. Single-use enforcement is a
 * server-side unique constraint (`voucher_redemptions.voucher_id`), and the
 * offline path is explicit about accepting that risk (see
 * `VoucherOfflinePolicy` below) rather than pretending a cached list is
 * authoritative.
 */

import { ZERO_MONEY, clampMoneyToZero, compareMoney, minMoney, mulMoneyByRate } from '../money';
import type { ISODate, Money, UUID } from '../types';

/** How a voucher's benefit is computed. */
export enum VoucherType {
  /** A flat rupiah amount off the basket. */
  Fixed = 'fixed',
  /** A percentage of the pre-discount subtotal, optionally capped. */
  Percentage = 'percentage',
}

/** Lifecycle of a single issued voucher. */
export enum VoucherStatus {
  /** Issued and usable (subject to its batch's date window). */
  Active = 'active',
  /** Used on a sale. Terminal. */
  Redeemed = 'redeemed',
  /** Cancelled before use — a misprint, a recalled batch. Terminal. */
  Void = 'void',
}

/** Lifecycle of a batch (a print run). */
export enum VoucherBatchStatus {
  Draft = 'draft',
  Issued = 'issued',
  Closed = 'closed',
}

/**
 * Every reason a redemption can be refused. This is a CLOSED list because
 * each value maps to one `ERR_VOUCHER_*` code and one i18n string the cashier
 * reads out to a customer — "tidak berlaku" with no reason is what makes a
 * queue argue.
 */
export type VoucherRejection =
  'not_found' | 'not_active' | 'not_started' | 'expired' | 'below_minimum' | 'wrong_location';

/** The batch fields the redemption rules actually need — a narrow view, so the device can cache it. */
export interface VoucherRules {
  type: VoucherType;
  /** Fixed: a Money string. Percentage: a decimal percent, e.g. `'10.00'`. */
  value: string;
  /** Basket must reach this before the voucher applies. `'0.00'` = no floor. */
  minSubtotal: Money;
  /** Percentage only: the most it may ever take off. `null` = uncapped. */
  maxDiscount: Money | null;
  validFrom: ISODate;
  validUntil: ISODate;
  /** `null` = usable at every outlet; otherwise the locations that accept it. */
  locationIds: UUID[] | null;
}

export interface VoucherCheckInput {
  rules: VoucherRules;
  status: VoucherStatus;
  /** Pre-voucher basket subtotal (after line and sale discounts). */
  subtotal: Money;
  /** WITA business date of the sale, `YYYY-MM-DD`. */
  businessDate: ISODate;
  locationId: UUID;
}

export type VoucherCheckResult =
  { ok: true; discount: Money } | { ok: false; reason: VoucherRejection };

/**
 * What a voucher is worth against this basket, or why it is refused.
 *
 * ORDER OF CHECKS IS PART OF THE CONTRACT: status → window → location →
 * minimum. The cashier is told the most fundamental reason first, so a
 * customer with an expired coupon hears "expired" rather than "spend more" and
 * then "expired" after they add an item.
 *
 * The discount NEVER exceeds the subtotal — a voucher cannot make the till owe
 * the customer money. That clamp is here, not at the call site, because both
 * the device and the server would otherwise have to remember it.
 */
export function checkVoucher(input: VoucherCheckInput): VoucherCheckResult {
  const { rules, status, subtotal, businessDate, locationId } = input;

  if (status !== VoucherStatus.Active) return { ok: false, reason: 'not_active' };
  // Plain string comparison is correct and intentional for `YYYY-MM-DD`: ISO
  // dates sort lexicographically, and both sides are already the WITA business
  // date (D-11), so no timezone maths can creep in here.
  if (businessDate < rules.validFrom) return { ok: false, reason: 'not_started' };
  if (businessDate > rules.validUntil) return { ok: false, reason: 'expired' };
  if (rules.locationIds !== null && !rules.locationIds.includes(locationId)) {
    return { ok: false, reason: 'wrong_location' };
  }
  if (compareMoney(subtotal, rules.minSubtotal) < 0) {
    return { ok: false, reason: 'below_minimum' };
  }

  const raw =
    rules.type === VoucherType.Fixed
      ? rules.value
      : mulMoneyByRate(subtotal, divideByHundred(rules.value));

  const capped =
    rules.type === VoucherType.Percentage && rules.maxDiscount !== null
      ? minMoney(raw, rules.maxDiscount)
      : raw;

  return { ok: true, discount: clampMoneyToZero(minMoney(capped, subtotal)) };
}

/**
 * `'10.00'` percent → the `'0.1000'` rate `mulMoneyByRate` wants at its
 * default `rateScale` of 4.
 *
 * Done as a STRING SHIFT rather than `Number(percent) / 100` so a percent
 * never round-trips through a float (D-10) — the whole reason this codebase
 * carries decimals as strings. `voucher_batches.value` is `NUMERIC(5,2)`, so
 * two fractional digits in gives exactly four out; anything finer than that
 * is not a percentage anyone printed on a coupon, and is rejected rather
 * than silently truncated to a discount that differs from what the cashier
 * was shown.
 */
const RATE_SCALE = 4;

function divideByHundred(percent: string): string {
  const negative = percent.startsWith('-');
  const magnitude = negative ? percent.slice(1) : percent;
  const [whole = '0', fraction = ''] = magnitude.split('.');
  if (fraction.length > RATE_SCALE - 2) {
    throw new Error(`voucher percentage '${percent}' has more than ${RATE_SCALE - 2} decimals`);
  }
  const digits = `${whole}${fraction.padEnd(RATE_SCALE - 2, '0')}`.padStart(RATE_SCALE + 1, '0');
  const cut = digits.length - RATE_SCALE;
  const result = `${digits.slice(0, cut)}.${digits.slice(cut)}`;
  return negative ? `-${result}` : result;
}

// ── Codes ─────────────────────────────────────────────────────────────────────

/**
 * The alphabet a printed voucher code is drawn from: Crockford base32 minus
 * the letters a human confuses with a digit when reading a coupon over a
 * counter. No `I`/`L` (vs `1`), no `O` (vs `0`), no `U` (so no accidental
 * profanity in a 8-character block). 32 symbols exactly, so a code carries 5
 * bits per character with no modulo bias when drawn from bytes.
 */
export const VOUCHER_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const VOUCHER_CODE_BODY_LENGTH = 8;

/** `MC-XXXX-XXXX`. The prefix makes a code recognisable on a receipt and in a support chat. */
export const VOUCHER_CODE_PREFIX = 'MC';

const CODE_PATTERN = new RegExp(
  `^${VOUCHER_CODE_PREFIX}-[${VOUCHER_CODE_ALPHABET}]{4}-[${VOUCHER_CODE_ALPHABET}]{4}$`,
);

/**
 * Format 8 alphabet indices as a printed code. Taking INDICES rather than
 * generating randomness here is what keeps this function pure and testable
 * and lets each caller supply the right entropy source — `crypto.randomUUID`
 * is not available in every runtime this package is loaded into, and a
 * `Math.random` voucher code would be forgeable.
 */
export function formatVoucherCode(indices: readonly number[]): string {
  if (indices.length !== VOUCHER_CODE_BODY_LENGTH) {
    throw new Error(`voucher code needs exactly ${VOUCHER_CODE_BODY_LENGTH} symbols`);
  }
  const chars = indices.map((i) => {
    const symbol = VOUCHER_CODE_ALPHABET[i % VOUCHER_CODE_ALPHABET.length];
    return symbol as string;
  });
  return `${VOUCHER_CODE_PREFIX}-${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}

/**
 * Accepts what a cashier actually types: lower case, missing dashes, and the
 * three characters the alphabet excludes precisely because they get confused
 * (`O`→`0`, `I`/`L`→`1`). Returns the canonical form, or `null` if it cannot
 * be one. Normalising here rather than in the POS means the server accepts
 * the same sloppiness the till does.
 */
export function normalizeVoucherCode(input: string): string | null {
  const cleaned = input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  const body = cleaned.startsWith(VOUCHER_CODE_PREFIX)
    ? cleaned.slice(VOUCHER_CODE_PREFIX.length)
    : cleaned;
  if (body.length !== VOUCHER_CODE_BODY_LENGTH) return null;
  const candidate = `${VOUCHER_CODE_PREFIX}-${body.slice(0, 4)}-${body.slice(4)}`;
  return CODE_PATTERN.test(candidate) ? candidate : null;
}

export function isVoucherCode(value: string): boolean {
  return CODE_PATTERN.test(value);
}

/**
 * Whether a till that cannot reach the cloud may still take a voucher.
 *
 * `'reject'` is the default and the safe answer: an offline till has no way to
 * know the coupon was not spent at the next outlet an hour ago. `'accept'`
 * trades that for not turning a customer away during a WAN cut, and the sale
 * carries the code so the server marks it redeemed on sync — a double-spend
 * then lands as a reconciliation exception rather than as silent lost margin.
 * Settings key `pos.voucher_offline`.
 */
export type VoucherOfflinePolicy = 'reject' | 'accept';

export const DEFAULT_VOUCHER_OFFLINE_POLICY: VoucherOfflinePolicy = 'reject';

/** What a redeemed voucher contributes to a sale, carried in the sync payload. */
export interface VoucherRedemptionDraft {
  code: string;
  discount: Money;
  /** True when the till was offline and `pos.voucher_offline` allowed it anyway. */
  offlineAccepted: boolean;
}

export const NO_VOUCHER_DISCOUNT: Money = ZERO_MONEY;
