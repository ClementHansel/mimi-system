import { create } from 'zustand';
import {
  calculateCartSummary,
  clampMoneyToZero,
  subMoney,
  ZERO_MONEY,
  type CartSummary,
} from '@mimi/shared';
import type { Money, UUID } from '@/lib/shared-types';
import type { PosCartLine } from './types';
import type { AppliedVoucher } from './VoucherEntry';

/**
 * The sale-in-progress cart (FR-POS-01/04). Holds only raw line inputs —
 * every derived number (line totals, subtotal, grand total) is recomputed on
 * read via `@mimi/shared`'s `calculateCartSummary`, never stored, so there is
 * exactly one place money math happens and the UI can never drift from it.
 */
interface CartState {
  lines: PosCartLine[];
  saleDiscount: Money;
  /**
   * A voucher checked and accepted by `/vouchers/check` for this sale, or
   * `null`. Kept SEPARATE from `saleDiscount` on purpose, not folded in:
   * `saleDiscount` is the cashier's own manual discount, typed by a human on
   * this screen and authored by them; `appliedVoucher.discount` is a
   * server-computed figure attached to one specific redeemable code. Merging
   * them into a single number would lose which is which — on the receipt
   * (a customer disputing "why was Rp 10.000 taken off" needs to be told
   * "coupon MC-XXXX" vs. "the cashier's own discretion", not both under one
   * label), in the sync payload (the server needs the code back to mark that
   * voucher redeemed — a merged number has nowhere to carry it), and for the
   * cashier's own UX ("Hapus Voucher" must remove exactly the voucher's
   * amount and nothing the cashier typed themselves; that is
   * un-implementable once the two are added together and stored as one
   * field).
   */
  appliedVoucher: AppliedVoucher | null;
  addProduct: (p: { productId: UUID; productName: string; unitPrice: Money }) => void;
  setQty: (productId: UUID, qty: string) => void;
  setLineDiscount: (productId: UUID, discount: Money) => void;
  removeLine: (productId: UUID) => void;
  setSaleDiscount: (discount: Money) => void;
  setAppliedVoucher: (voucher: AppliedVoucher | null) => void;
  /**
   * F-POS-3 — re-prices every current line to a newly-selected channel.
   * `getPrice` is the caller's `productId -> new unitPrice` lookup (built
   * from the catalog + `priceForChannel`, see `ChannelToggle.tsx`); a line
   * whose product isn't found (stale/offline catalog) is left at its
   * current price rather than dropped — a cart is never silently mutated
   * out from under the cashier by removing a line they added on purpose.
   * Callers gate this behind an explicit confirmation, never call it
   * silently — see `ChannelToggle.tsx` for why.
   */
  repriceForChannel: (getPrice: (productId: UUID) => Money | undefined) => void;
  clear: () => void;
}

export const usePosCartStore = create<CartState>((set) => ({
  lines: [],
  saleDiscount: ZERO_MONEY,
  appliedVoucher: null,
  addProduct: ({ productId, productName, unitPrice }) =>
    set((s) => {
      const existing = s.lines.find((l) => l.productId === productId);
      if (existing) {
        const nextQty = (parseFloat(existing.qty) + 1).toString();
        return {
          lines: s.lines.map((l) => (l.productId === productId ? { ...l, qty: nextQty } : l)),
        };
      }
      return {
        lines: [...s.lines, { productId, productName, unitPrice, qty: '1', discount: ZERO_MONEY }],
      };
    }),
  setQty: (productId, qty) =>
    set((s) => ({
      lines:
        qty === '0' || qty === ''
          ? s.lines.filter((l) => l.productId !== productId)
          : s.lines.map((l) => (l.productId === productId ? { ...l, qty } : l)),
    })),
  setLineDiscount: (productId, discount) =>
    set((s) => ({
      lines: s.lines.map((l) => (l.productId === productId ? { ...l, discount } : l)),
    })),
  removeLine: (productId) =>
    set((s) => ({ lines: s.lines.filter((l) => l.productId !== productId) })),
  setSaleDiscount: (saleDiscount) => set({ saleDiscount }),
  setAppliedVoucher: (appliedVoucher) => set({ appliedVoucher }),
  repriceForChannel: (getPrice) =>
    set((s) => ({
      lines: s.lines.map((l) => {
        const next = getPrice(l.productId);
        return next ? { ...l, unitPrice: next } : l;
      }),
    })),
  clear: () => set({ lines: [], saleDiscount: ZERO_MONEY, appliedVoucher: null }),
}));

/** Pure selector helper: derive the cart summary from the current lines (component tests call this directly, no store needed). */
export function summarizeCart(lines: readonly PosCartLine[], saleDiscount: Money): CartSummary {
  return calculateCartSummary(
    lines.map((l) => ({
      productId: l.productId,
      unitPrice: l.unitPrice,
      qty: l.qty,
      discount: l.discount,
    })),
    saleDiscount,
  );
}

/**
 * Folds the voucher's discount on top of `calculateCartSummary`'s own result,
 * for the grand total the cashier and the receipt both show.
 *
 * WHY A SIBLING FUNCTION RATHER THAN THREADING THE VOUCHER THROUGH
 * `calculateCartSummary` ITSELF: that function is `@mimi/shared`, called by
 * both the POS and (per CONTRACTS §1.6) mirrored by `sales.subtotal/
 * discount/total` server-side, and its signature is `(lines, saleDiscount)`
 * — `packages/shared/src/**` is frozen for this ticket (hard boundary) and,
 * more importantly, changing a function two systems already agree on to grow
 * a THIRD discount concept is exactly the kind of shared-contract decision
 * this ticket is not authorised to make on its own. So the voucher is summed
 * on the client side, over the shared result, the same way `calculateChange`
 * already composes over `calculateCartSummary`'s `total` in `PaymentPanel`
 * rather than being folded into the shared calculator.
 *
 * REJECTED: subtracting the voucher inside `summarizeCart` and returning a
 * modified `CartSummary` whose `.discount` already includes it. That would
 * make `summary.discount` silently mean "manual + voucher" wherever it's
 * read (the receipt's "Diskon" line, `Cart.tsx`'s summary) and reintroduce
 * exactly the "which discount is this" ambiguity `appliedVoucher` being
 * separate from `saleDiscount` was meant to avoid one field up.
 *
 * The voucher can never take the total below zero — `checkVoucher` itself
 * clamps the discount to at most the subtotal it was computed against
 * (`packages/shared/src/voucher/index.ts`), but that subtotal can be STALE
 * by the time this runs (the cashier can add a line, change a qty, or edit
 * `saleDiscount` after the voucher check response comes back and before the
 * sale is submitted — the check is not re-run on every keystroke). So this
 * clamps again here, defensively, against whatever `total` actually is now
 * — cheap insurance, not a re-implementation of `checkVoucher`'s own rules
 * (this never recomputes what the voucher is WORTH, only re-floors what's
 * already been decided against a total that may have moved).
 */
export function applyVoucherToSummary(
  summary: CartSummary,
  voucher: { discount: Money } | null,
): CartSummary {
  if (!voucher) return summary;
  return { ...summary, total: clampMoneyToZero(subMoney(summary.total, voucher.discount)) };
}
