import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { addMoney, ZERO_MONEY } from '@mimi/shared';
import type { Money, UUID } from '@/lib/shared-types';

/**
 * The device's notion of "is a shift open right now" (FR-POS-02, SYNC-PROTOCOL
 * §8 row 16 — open/close is a fully local fact in every connectivity tier).
 * This is deliberately NOT part of `LocalRuntime`: the runtime records the
 * `pos_shifts.opened`/`closed` FACTS (durable, synced), but "which shift is
 * currently open on this tablet" is UI-session state the POS surface needs to
 * decide what screen to show — persisted so a refresh/reload mid-shift
 * doesn't lose track of it and re-prompt "buka kasir" over an already-open
 * shift.
 */
export interface OpenShift {
  shiftId: UUID;
  locationId: UUID;
  openingCash: Money;
  openedAt: string;
  kasirName: string;
  /** Device-local running totals — a same-device ESTIMATE only; the cloud recomputes the authoritative `ShiftReport` at close/sync (R7, SYNC-PROTOCOL §8 row 16). */
  cashCollected: Money;
  grossSales: Money;
  salesCount: number;
  voidCount: number;
}

interface ShiftState {
  current: OpenShift | null;
  open: (
    shift: Omit<OpenShift, 'cashCollected' | 'grossSales' | 'salesCount' | 'voidCount'>,
  ) => void;
  recordSale: (args: { total: Money; cashPortion: Money }) => void;
  recordVoid: () => void;
  close: () => void;
}

export const usePosShiftStore = create<ShiftState>()(
  persist(
    (set) => ({
      current: null,
      open: (shift) =>
        set({
          current: {
            ...shift,
            cashCollected: ZERO_MONEY,
            grossSales: ZERO_MONEY,
            salesCount: 0,
            voidCount: 0,
          },
        }),
      recordSale: ({ total, cashPortion }) =>
        set((s) =>
          s.current
            ? {
                current: {
                  ...s.current,
                  cashCollected: addMoney(s.current.cashCollected, cashPortion),
                  grossSales: addMoney(s.current.grossSales, total),
                  salesCount: s.current.salesCount + 1,
                },
              }
            : s,
        ),
      recordVoid: () =>
        set((s) =>
          s.current ? { current: { ...s.current, voidCount: s.current.voidCount + 1 } } : s,
        ),
      close: () => set({ current: null }),
    }),
    { name: 'mimi-pos-shift' },
  ),
);
