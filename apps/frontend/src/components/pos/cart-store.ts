import { create } from 'zustand';
import { calculateCartSummary, ZERO_MONEY, type CartSummary } from '@mimi/shared';
import type { Money, UUID } from '@/lib/shared-types';
import type { PosCartLine } from './types';

/**
 * The sale-in-progress cart (FR-POS-01/04). Holds only raw line inputs —
 * every derived number (line totals, subtotal, grand total) is recomputed on
 * read via `@mimi/shared`'s `calculateCartSummary`, never stored, so there is
 * exactly one place money math happens and the UI can never drift from it.
 */
interface CartState {
  lines: PosCartLine[];
  saleDiscount: Money;
  addProduct: (p: { productId: UUID; productName: string; unitPrice: Money }) => void;
  setQty: (productId: UUID, qty: string) => void;
  setLineDiscount: (productId: UUID, discount: Money) => void;
  removeLine: (productId: UUID) => void;
  setSaleDiscount: (discount: Money) => void;
  clear: () => void;
}

export const usePosCartStore = create<CartState>((set) => ({
  lines: [],
  saleDiscount: ZERO_MONEY,
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
  clear: () => set({ lines: [], saleDiscount: ZERO_MONEY }),
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
