import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { PosChannel } from './types';

/**
 * F-POS-3 — which channel the till is currently ringing into: walk-in,
 * GoFood, or ShopeeFood (owner: "need only 1 interface for 3 of them").
 * Global, not per-component state, because BOTH the top bar (the toggle)
 * and the page (grid/cart/payment pricing) need to read the same value —
 * same reasoning as `shift-store.ts`.
 *
 * Persisted for the same reason `shift-store.ts` persists `current`: a
 * mid-shift reload must not silently move the till back to walk-in prices
 * under an already-in-progress GoFood queue — that would be the exact
 * mispricing accident this feature exists to prevent, just triggered by a
 * refresh instead of a mis-tap. Resets to `walk_in` only on a genuinely new
 * device/browser profile (nothing persisted yet).
 */
interface ChannelState {
  channel: PosChannel;
  setChannel: (channel: PosChannel) => void;
}

export const usePosChannelStore = create<ChannelState>()(
  persist(
    (set) => ({
      channel: 'walk_in',
      setChannel: (channel) => set({ channel }),
    }),
    { name: 'mimi-pos-channel' },
  ),
);
