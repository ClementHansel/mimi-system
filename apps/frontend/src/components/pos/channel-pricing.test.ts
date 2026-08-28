import { describe, it, expect } from 'vitest';
import { priceForChannel } from './channel-pricing';

/**
 * F-POS-3 — the contract, verbatim: "priceGofood/priceShopeefood are
 * nullable, and when null the walk-in price applies" — never `0.00`. This
 * is the one place that fallback is implemented (`ProductGrid`, the cart
 * repricing on channel switch, and the product form's preview all call
 * through here) — pinned directly so a future edit can't quietly turn "no
 * channel price set" into "free".
 */
describe('priceForChannel — null->walk-in fallback (F-POS-3 contract)', () => {
  const product = { price: '15000.00', priceGofood: '18000.00', priceShopeefood: '17000.00' };

  it('walk_in always uses the walk-in price', () => {
    expect(priceForChannel(product, 'walk_in')).toBe('15000.00');
  });

  it('gofood uses its own price when set', () => {
    expect(priceForChannel(product, 'gofood')).toBe('18000.00');
  });

  it('shopeefood uses its own price when set', () => {
    expect(priceForChannel(product, 'shopeefood')).toBe('17000.00');
  });

  it('gofood falls back to the walk-in price when null — never 0.00', () => {
    const noChannelPrice = { price: '15000.00', priceGofood: null, priceShopeefood: '17000.00' };
    expect(priceForChannel(noChannelPrice, 'gofood')).toBe('15000.00');
  });

  it('shopeefood falls back to the walk-in price when null — never 0.00', () => {
    const noChannelPrice = { price: '15000.00', priceGofood: '18000.00', priceShopeefood: null };
    expect(priceForChannel(noChannelPrice, 'shopeefood')).toBe('15000.00');
  });

  it('falls back even when the channel field is entirely absent from the payload (an older/degraded catalog row)', () => {
    const bareProduct = { price: '15000.00' };
    expect(priceForChannel(bareProduct, 'gofood')).toBe('15000.00');
    expect(priceForChannel(bareProduct, 'shopeefood')).toBe('15000.00');
  });
});
