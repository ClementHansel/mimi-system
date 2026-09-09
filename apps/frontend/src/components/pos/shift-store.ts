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
 *
 * Persisted per BROWSER PROFILE, which is the whole reason `kasirUserId`
 * below is not optional: an outlet till is a shared machine that three
 * cashiers log into across a day, and this blob outlives every one of their
 * sessions (`logout()` clears `mimi-session`, nothing else).
 */
export interface OpenShift {
  shiftId: UUID;
  locationId: UUID;
  /**
   * WHOSE shift this is — `actor.actorUserId`, the same identity stamped on
   * the `pos_shifts.opened` fact this record accompanies.
   *
   * MA-191: without it, the record was a DEVICE-level fact standing in for a
   * per-cashier one. The morning cashier opened a shift; the till persisted
   * it; they went home. The afternoon cashier logged into the same browser
   * and the POS surface — which gates purely on this slot being truthy —
   * skipped "Buka Kasir" entirely and dropped them straight into a shift that
   * was not theirs, with the morning cashier's name on the Shift tab. Every
   * sale they rang went onto that `shiftId`, and closing it counted their
   * drawer against someone else's opening cash.
   */
  kasirUserId: UUID;
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

/**
 * Is the persisted shift the cashier who is logged in RIGHT NOW?
 *
 * The one question every reader of `current` has to ask before treating it as
 * "my open shift" (MA-191 — see `OpenShift.kasirUserId`). Lives here rather
 * than inline at each gate because there are three of them (`app/pos/page.tsx`
 * decides which screen to show, `PosTopBar` decides whether the till is
 * operational, `ShiftOpenForm` decides between opening and handing over) and
 * they must never disagree about whose shift is on screen.
 *
 * A record written before `kasirUserId` existed has none, so it reads as
 * somebody else's. That is the right answer for a blob whose owner cannot be
 * established: it gets offered for handover rather than silently adopted.
 */
export function shiftBelongsTo(shift: OpenShift | null, userId: string | undefined): boolean {
  return !!shift && !!userId && shift.kasirUserId === userId;
}
