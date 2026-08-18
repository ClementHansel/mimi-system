import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Cart } from './Cart';
import { summarizeCart } from './cart-store';
import type { PosCartLine } from './types';

const LINES: PosCartLine[] = [
  {
    productId: 'p1',
    productName: 'Ayam Goreng',
    unitPrice: '15000.00',
    qty: '2',
    discount: '0.00',
  },
  { productId: 'p2', productName: 'Es Teh', unitPrice: '5000.00', qty: '3', discount: '1000.00' },
];

describe('Cart', () => {
  it('renders an empty state with no lines', () => {
    render(
      <Cart
        lines={[]}
        summary={summarizeCart([], '0.00')}
        saleDiscount="0.00"
        onSaleDiscountChange={() => {}}
      />,
    );
    expect(screen.getByText('Keranjang masih kosong')).toBeInTheDocument();
  });

  it('renders each line with its calculator-derived total, never a hand-rolled one', () => {
    const summary = summarizeCart(LINES, '0.00');
    // 2 x 15000 = 30000; 3 x 5000 - 1000 = 14000
    expect(summary.lines[0]!.lineTotal).toBe('30000.00');
    expect(summary.lines[1]!.lineTotal).toBe('14000.00');
    expect(summary.subtotal).toBe('44000.00');

    render(
      <Cart lines={LINES} summary={summary} saleDiscount="0.00" onSaleDiscountChange={() => {}} />,
    );
    expect(screen.getByText('Ayam Goreng')).toBeInTheDocument();
    expect(screen.getByText('Es Teh')).toBeInTheDocument();
    expect(screen.getByText('Rp30.000')).toBeInTheDocument();
    expect(screen.getByText('Rp14.000')).toBeInTheDocument();
  });

  it('applies a sale-level discount after line totals, floored at zero', () => {
    const summary = summarizeCart(LINES, '44000.00');
    expect(summary.total).toBe('0.00');
    const overDiscounted = summarizeCart(LINES, '100000.00');
    expect(overDiscounted.total).toBe('0.00'); // clamped, never negative — a sale can never charge negative
  });

  it('shows the grand total, not a per-line sum a screen might compute independently', () => {
    const summary = summarizeCart(LINES, '4000.00');
    render(
      <Cart
        lines={LINES}
        summary={summary}
        saleDiscount="4000.00"
        onSaleDiscountChange={() => {}}
      />,
    );
    expect(summary.total).toBe('40000.00');
    expect(screen.getByText('Rp40.000')).toBeInTheDocument();
  });
});
