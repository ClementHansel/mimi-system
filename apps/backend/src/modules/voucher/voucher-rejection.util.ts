import {
  ERR_VOUCHER_BELOW_MINIMUM,
  ERR_VOUCHER_EXPIRED,
  ERR_VOUCHER_NOT_ACTIVE,
  ERR_VOUCHER_NOT_FOUND,
  ERR_VOUCHER_NOT_STARTED,
  ERR_VOUCHER_WRONG_LOCATION,
  type ErrorCode,
  type VoucherRejection,
} from '@mimi/shared';

/**
 * `VoucherRejection` → the `ERR_VOUCHER_*` code the cashier's screen keys its
 * message off.
 *
 * WHY THIS IS ONE EXHAUSTIVE SWITCH AND NOT A LOOKUP OBJECT
 * ---------------------------------------------------------
 * A `Record<VoucherRejection, ErrorCode>` would also be exhaustive at compile
 * time, so the choice is not about safety — it is about what happens at the
 * moment somebody adds a seventh rejection reason to the shared union (say
 * `'batch_closed'`). With a `Record`, TypeScript reports a missing property on
 * an object literal, which is easy to satisfy by pointing the new reason at
 * whichever existing code looks closest. With a switch whose default arm
 * assigns to `never`, the error names the unhandled VALUE and sits at the
 * exact line where a human has to decide what the cashier is told. That is a
 * decision worth forcing: `VoucherRejection`'s own doc comment says the list
 * is closed precisely because "tidak berlaku with no reason is what makes a
 * queue argue".
 *
 * The one mapping that is not one-to-one is worth calling out. Both a VOID
 * coupon and an ALREADY-REDEEMED one arrive here as `'not_active'`, because
 * `checkVoucher` only sees `VoucherStatus` and both are terminal. The cashier
 * gets one message for both, deliberately: "this coupon cannot be used" is
 * the actionable part, and telling a stranger at the counter whether a code
 * was *spent* (and therefore that it was once real) or *voided* is a small
 * enumeration oracle for no operational benefit.
 *
 * There is no arm for `ERR_VOUCHER_OFFLINE_BLOCKED`: that is not a
 * `VoucherRejection` at all — the coupon may be perfectly good and the
 * refusal comes from `pos.voucher_offline`, decided in
 * `voucher-redemption.service.ts` before `checkVoucher` is ever consulted.
 */
export function errorCodeForRejection(reason: VoucherRejection): ErrorCode {
  switch (reason) {
    case 'not_found':
      return ERR_VOUCHER_NOT_FOUND;
    case 'not_active':
      return ERR_VOUCHER_NOT_ACTIVE;
    case 'not_started':
      return ERR_VOUCHER_NOT_STARTED;
    case 'expired':
      return ERR_VOUCHER_EXPIRED;
    case 'below_minimum':
      return ERR_VOUCHER_BELOW_MINIMUM;
    case 'wrong_location':
      return ERR_VOUCHER_WRONG_LOCATION;
    default: {
      // Compile error the moment a new `VoucherRejection` member exists and is
      // not handled above. See this file's header for why that is the point.
      const exhaustive: never = reason;
      throw new Error(`unhandled voucher rejection '${String(exhaustive)}'`);
    }
  }
}
