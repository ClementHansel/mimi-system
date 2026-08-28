import type {
  ISODate,
  ISODateTime,
  Money,
  UUID,
  VoucherBatchStatus,
  VoucherStatus,
  VoucherType,
} from '@/lib/shared-types';

/**
 * Wire shapes for the Vouchers UI — a print run ("batch") and the individual
 * printed codes it mints.
 *
 * DECLARED HERE, NOT IN `@mimi/shared`, ON PURPOSE. `packages/shared/src/voucher/index.ts`
 * exports `VoucherRules` (and the enums/checker built on it): the narrow set
 * of fields the OFFLINE REDEMPTION CALCULATOR needs, chosen so a till can
 * cache it and so the shared package — frozen after G1 per the collision
 * rule — never has to change shape for a screen it doesn't run on. `VoucherBatch`
 * and `Voucher` below are the wider, list-shaped view this admin screen
 * renders (issued/redeemed counts, a batch code, a per-code redemption
 * pointer) — a UI-facing read model, not a cross-runtime calculator input.
 * Folding the two together would mean either starving the till's cache with
 * fields it never uses, or growing the frozen package for a shape only this
 * page needs. `VoucherRules`'s own fields (`type`, `value`, `minSubtotal`,
 * `maxDiscount`, `validFrom`, `validUntil`, `locationIds`) are carried over
 * verbatim below so the two shapes cannot drift on the fields they DO share.
 */
export interface VoucherBatch {
  id: UUID;
  /** The printed batch code, e.g. what appears on the coupon stock before individual codes are issued. */
  code: string;
  name: string;
  type: VoucherType;
  /**
   * Fixed: a Money decimal string. Percentage: a `'10.00'`-style percent
   * (at most 2 decimals — see `divideByHundred` in the shared voucher
   * module). Deliberately `string`, not `Money`, mirroring `VoucherRules.value`:
   * typing it `Money` would claim a percentage is a rupiah amount.
   */
  value: string;
  minSubtotal: Money;
  maxDiscount: Money | null;
  validFrom: ISODate;
  validUntil: ISODate;
  /** `null` = usable at every outlet; otherwise the locations that accept it. */
  locationIds: UUID[] | null;
  terms: string | null;
  status: VoucherBatchStatus;
  issuedCount: number;
  redeemedCount: number;
  createdAt: ISODateTime;
}

/** One printed/issued code out of a batch. */
export interface Voucher {
  id: UUID;
  batchId: UUID;
  code: string;
  status: VoucherStatus;
  redeemedAt: ISODateTime | null;
  redeemedSaleId: UUID | null;
}

/**
 * Create/edit form payload. Every field the batch modal collects; `PATCH`
 * reuses the same shape as a `Partial` since a draft batch can be edited
 * field-by-field before it is issued.
 */
export interface VoucherBatchInput {
  name: string;
  type: VoucherType;
  value: string;
  minSubtotal: Money;
  maxDiscount: Money | null;
  validFrom: ISODate;
  validUntil: ISODate;
  locationIds: UUID[] | null;
  terms: string | null;
}
