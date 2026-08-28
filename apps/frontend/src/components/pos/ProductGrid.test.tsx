import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProductGrid } from './ProductGrid';
import type { PosProduct } from './types';

const PRODUCT: PosProduct = {
  id: 'p1',
  code: 'AYG',
  name: 'Ayam Goreng',
  category: 'Ayam',
  categoryId: 'c1',
  price: '15000.00',
  priceGofood: '18000.00',
  priceShopeefood: null, // no ShopeeFood price set -> must show the walk-in price, never Rp0
  photoUrl: null,
  photoPath: null,
  sortOrder: 0,
  isActive: true,
  kind: 'product',
  hasRecipe: true,
};

/**
 * F-POS-3 — "the product grid ... must all use the selected channel's
 * price." The grid is what the cashier is looking at when they tap to add
 * an item, so a stale/wrong price here is the point of first failure for
 * the whole feature.
 */
describe('ProductGrid — channel-aware pricing (F-POS-3)', () => {
  it('shows the walk-in price under the walk_in channel', () => {
    render(
      <ProductGrid products={[PRODUCT]} categories={['Ayam']} channel="walk_in" onAdd={vi.fn()} />,
    );
    expect(screen.getByText('Rp15.000')).toBeInTheDocument();
  });

  it('shows the GoFood price under the gofood channel', () => {
    render(
      <ProductGrid products={[PRODUCT]} categories={['Ayam']} channel="gofood" onAdd={vi.fn()} />,
    );
    expect(screen.getByText('Rp18.000')).toBeInTheDocument();
    expect(screen.queryByText('Rp15.000')).not.toBeInTheDocument();
  });

  it('falls back to the walk-in price under shopeefood when priceShopeefood is null — never Rp0', () => {
    render(
      <ProductGrid
        products={[PRODUCT]}
        categories={['Ayam']}
        channel="shopeefood"
        onAdd={vi.fn()}
      />,
    );
    expect(screen.getByText('Rp15.000')).toBeInTheDocument();
    expect(screen.queryByText('Rp0')).not.toBeInTheDocument();
  });
});
