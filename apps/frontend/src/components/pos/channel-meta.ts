/**
 * F-POS-3 — the one shared colour/icon/label table for a POS channel, used
 * by `ChannelToggle` (the picker), `ChannelBanner` (the always-on strip),
 * and `ChannelBadge` (the payment-screen/cart indicator) so the three
 * surfaces can never drift into showing GoFood as, say, green in one place
 * and orange in another — which would defeat the entire point of colour-
 * coding the channel for at-a-glance recognition.
 */
import { Store, Bike, ShoppingBag, type LucideIcon } from 'lucide-react';
import type { PosChannel } from './types';

export interface ChannelMeta {
  icon: LucideIcon;
  labelKey: string;
  /** Selected/emphasised state — toggle button and modal confirm copy. */
  activeClass: string;
  /** Low-emphasis pill — payment screen / receipt-adjacent badges. */
  badgeClass: string;
}

export const CHANNEL_META: Record<PosChannel, ChannelMeta> = {
  // Neutral/brand tone — the ordinary, "nothing special" state.
  walk_in: {
    icon: Store,
    labelKey: 'pos.channelWalkIn',
    activeClass: 'border-brand-500 bg-brand-50 text-brand-700',
    badgeClass: 'bg-brand-50 text-brand-700',
  },
  // Green — close to GoFood's own brand colour, and reads as "a distinctly
  // different mode is active" at a glance, not just a re-labelled default.
  gofood: {
    icon: Bike,
    labelKey: 'pos.channelGofood',
    activeClass: 'border-success-600 bg-success-50 text-success-700',
    badgeClass: 'bg-success-50 text-success-700',
  },
  // Orange/amber — close to ShopeeFood's own brand colour and visually
  // distinct from both walk-in and GoFood, so the three states can never be
  // confused for one another from across the counter.
  shopeefood: {
    icon: ShoppingBag,
    labelKey: 'pos.channelShopeefood',
    activeClass: 'border-warning-600 bg-warning-50 text-warning-700',
    badgeClass: 'bg-warning-50 text-warning-700',
  },
};
