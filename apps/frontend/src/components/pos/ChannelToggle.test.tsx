import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChannelToggle } from './ChannelToggle';
import { usePosChannelStore } from './channel-store';
import { usePosCartStore, summarizeCart } from './cart-store';
import type { PosProduct } from './types';

const PRODUCTS: PosProduct[] = [
  {
    id: 'p1',
    code: 'AYG',
    name: 'Ayam Goreng',
    category: 'Ayam',
    categoryId: 'c1',
    price: '15000.00',
    priceGofood: '18000.00',
    priceShopeefood: '17000.00',
    photoUrl: null,
    photoPath: null,
    sortOrder: 0,
    isActive: true,
    kind: 'product',
    hasRecipe: true,
  },
];

describe('ChannelToggle', () => {
  beforeEach(() => {
    usePosChannelStore.setState({ channel: 'walk_in' });
    usePosCartStore.getState().clear();
  });

  it('switches instantly, no confirmation, when the cart is empty', () => {
    render(<ChannelToggle products={PRODUCTS} />);
    fireEvent.click(screen.getByText('GoFood'));
    expect(usePosChannelStore.getState().channel).toBe('gofood');
    expect(screen.queryByText('Ganti Channel Penjualan?')).not.toBeInTheDocument();
  });

  it('asks for confirmation before switching when the cart is non-empty, and leaves channel/cart untouched on cancel', () => {
    usePosCartStore
      .getState()
      .addProduct({ productId: 'p1', productName: 'Ayam Goreng', unitPrice: '15000.00' });

    render(<ChannelToggle products={PRODUCTS} />);
    fireEvent.click(screen.getByText('GoFood'));

    expect(screen.getByText('Ganti Channel Penjualan?')).toBeInTheDocument();
    // Neither the channel nor the cart line's price changed yet — the switch
    // is not applied until the cashier explicitly confirms it.
    expect(usePosChannelStore.getState().channel).toBe('walk_in');
    expect(usePosCartStore.getState().lines[0]!.unitPrice).toBe('15000.00');

    fireEvent.click(screen.getByText('Batal'));
    expect(usePosChannelStore.getState().channel).toBe('walk_in');
    expect(screen.queryByText('Ganti Channel Penjualan?')).not.toBeInTheDocument();
  });

  it('re-prices every existing line from the catalog on confirm — the cart totals follow the newly active channel', () => {
    usePosCartStore
      .getState()
      .addProduct({ productId: 'p1', productName: 'Ayam Goreng', unitPrice: '15000.00' });

    render(<ChannelToggle products={PRODUCTS} />);
    fireEvent.click(screen.getByText('GoFood'));
    fireEvent.click(screen.getByText('Ganti & Perbarui Harga'));

    expect(usePosChannelStore.getState().channel).toBe('gofood');
    const line = usePosCartStore.getState().lines[0]!;
    expect(line.unitPrice).toBe('18000.00'); // GoFood price, not the walk-in price it was added at

    // And the derived cart summary — what the cashier is actually charged —
    // reflects it too, not just the raw line field.
    const summary = summarizeCart(usePosCartStore.getState().lines, '0.00');
    expect(summary.total).toBe('18000.00');
  });

  it('leaves a line at its current price when its product is not in the (possibly stale/offline) catalog, rather than dropping it', () => {
    usePosCartStore.getState().addProduct({
      productId: 'not-in-catalog',
      productName: 'Produk Lama',
      unitPrice: '9000.00',
    });

    render(<ChannelToggle products={PRODUCTS} />);
    fireEvent.click(screen.getByText('ShopeeFood'));
    fireEvent.click(screen.getByText('Ganti & Perbarui Harga'));

    expect(usePosChannelStore.getState().channel).toBe('shopeefood');
    expect(usePosCartStore.getState().lines[0]!.unitPrice).toBe('9000.00');
  });
});
