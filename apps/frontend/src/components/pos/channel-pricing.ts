/**
 * F-POS-3 — the ONE place the null->walk-in fallback is implemented
 * (owner's contract: "priceGofood/priceShopeefood are nullable, and when
 * null the walk-in price applies — never zero"). The product grid, the cart
 * repricing on channel switch, and the product form's live preview all call
 * this instead of re-deriving the fallback independently, which is exactly
 * how a silent "GoFood price defaults to Rp0" bug would sneak in.
 */
import type { Money } from '@/lib/shared-types';
import type { PosChannel } from './types';

/** The subset of a product/catalog row this needs — works for both `PosProduct` (POS catalog) and admin's `Product` (Data Master) shapes. */
export interface ChannelPriceable {
  price: Money;
  priceGofood?: Money | null;
  priceShopeefood?: Money | null;
}

/** The price a cashier should see/charge for `product` under `channel` — never `0.00` for "no channel price set". */
export function priceForChannel(product: ChannelPriceable, channel: PosChannel): Money {
  if (channel === 'gofood') return product.priceGofood ?? product.price;
  if (channel === 'shopeefood') return product.priceShopeefood ?? product.price;
  return product.price;
}
