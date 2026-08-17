/**
 * Cart / sale total calculator (FR-POS-01/04/05/07) — line totals, sale-level
 * discount, and the GoFood/ShopeeFood net-received walk. All money math is
 * decimal-safe via `../money`; nothing here touches a JS `number` for an
 * amount.
 */
import { addMoney, clampMoneyToZero, isNegativeMoney, mulMoneyByQty, subMoney, sumMoney, ZERO_MONEY } from '../money';
import { ERR_NET_MISMATCH } from '../error-codes';
import type { Money, Qty, UUID } from '../types';

export interface CartLine {
  productId: UUID;
  unitPrice: Money;
  qty: Qty;
  /** Manual per-line discount, total (not per-unit) — mirrors CONTRACTS.md `sale_lines.discount`. */
  discount: Money;
}

export interface CartLineResult extends CartLine {
  lineTotal: Money;
}

/** `qty × unitPrice − discount`, floored at zero (a line can never charge negative). */
export function calculateLineTotal(line: CartLine): Money {
  const gross = mulMoneyByQty(line.unitPrice, line.qty);
  return clampMoneyToZero(subMoney(gross, line.discount));
}

export interface CartSummary {
  lines: CartLineResult[];
  subtotal: Money;
  /** Sale-level discount, applied after line discounts. */
  discount: Money;
  total: Money;
}

/**
 * `subtotal = Σ lineTotal`; `total = max(0, subtotal − discount)`. Mirrors
 * `sales.subtotal/discount/total` (CONTRACTS.md §1.6).
 */
export function calculateCartSummary(lines: readonly CartLine[], saleDiscount: Money = ZERO_MONEY): CartSummary {
  const resolvedLines = lines.map((l) => ({ ...l, lineTotal: calculateLineTotal(l) }));
  const subtotal = sumMoney(resolvedLines.map((l) => l.lineTotal));
  const total = clampMoneyToZero(subMoney(subtotal, saleDiscount));
  return { lines: resolvedLines, subtotal, discount: saleDiscount, total };
}

/** `paid − total`, floored at zero — the change handed back to the customer on a cash sale. */
export function calculateChange(totalPaid: Money, saleTotal: Money): Money {
  return clampMoneyToZero(subMoney(totalPaid, saleTotal));
}

// ── GoFood / ShopeeFood net-received math (FR-POS-05/07) ─────────────────────

export interface OnlineOrderAmounts {
  grossAmount: Money;
  discountAmount: Money;
  platformFee: Money;
  otherFee: Money;
}

/** `net = gross − discount − platformFee − otherFee` (CONTRACTS.md `online_orders`). */
export function calculateOnlineOrderNet(amounts: OnlineOrderAmounts): Money {
  return subMoney(subMoney(subMoney(amounts.grossAmount, amounts.discountAmount), amounts.platformFee), amounts.otherFee);
}

export type NetValidationResult = { ok: true } | { ok: false; code: string; message: string; expectedNet: Money };

/**
 * `POST /api/pos/online-orders` rejects a mismatched `netReceived` with
 * `ERR_NET_MISMATCH` (CONTRACTS.md §4.13) — this is that check, pure.
 */
export function validateOnlineOrderNet(amounts: OnlineOrderAmounts, netReceived: Money): NetValidationResult {
  const expectedNet = calculateOnlineOrderNet(amounts);
  if (expectedNet !== netReceived) {
    return {
      ok: false,
      code: ERR_NET_MISMATCH,
      message: `netReceived ${netReceived} does not equal gross-discount-fees ${expectedNet}`,
      expectedNet,
    };
  }
  return { ok: true };
}

/** The platform-fee-driven journal split for `OUTLET_SALES` online rows (JOUT-03: net to 1030, fees+discount to 6300). */
export function calculateOnlineOrderJournalSplit(amounts: OnlineOrderAmounts): { netLeg: Money; feeLeg: Money } {
  return {
    netLeg: calculateOnlineOrderNet(amounts),
    feeLeg: addMoney(addMoney(amounts.discountAmount, amounts.platformFee), amounts.otherFee),
  };
}

/** `qty × unitPrice` for a recipe line — used to project ingredient usage cost (FR-POS-06), never as a sale price. */
export function calculateExtendedCost(unitCost: Money, qty: Qty): Money {
  return mulMoneyByQty(unitCost, qty);
}

export function assertNonNegative(amount: Money, label: string): void {
  if (isNegativeMoney(amount)) {
    throw new RangeError(`${label} must not be negative, got ${amount}`);
  }
}
