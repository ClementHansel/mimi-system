import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
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

  /**
   * MA-192 — "Nama dan harga item terpotong dan overlapping di cart POS".
   *
   * The cause was arithmetic. The cart is a fixed 360px column
   * (`app/pos/page.tsx`) with `p-4` — 328px of content — and the old single
   * row's FIXED columns claimed 296px of it: the stepper (44 + 6 + 40 + 6 +
   * 44), the line total (`w-24`), the delete button (`size-9`) and three
   * `gap-2`s. `flex-1` was left with 32px, which truncated the name to a
   * character or two, and the unit price beneath it had no truncation at all,
   * so it spilled sideways under the stepper.
   *
   * jsdom has no layout, so the overlap itself is not observable here — that
   * part was fixed by removing the constraint, and checked against the
   * measurements above. What IS worth pinning is the STRUCTURE that made the
   * name lose: it must not share a row with the stepper and the totals, or the
   * same squeeze comes straight back the next time someone edits this file.
   */
  it('does not make the product name compete for width with the stepper', () => {
    const longName = 'Ayam Goreng Crispy Paha Atas Pedas Level 5 Porsi Besar';
    const lines: PosCartLine[] = [
      {
        productId: 'p1',
        productName: longName,
        unitPrice: '125000.00',
        qty: '9',
        discount: '0.00',
      },
    ];

    render(
      <Cart
        lines={lines}
        summary={summarizeCart(lines, '0.00')}
        saleDiscount="0.00"
        onSaleDiscountChange={() => {}}
      />,
    );

    const name = screen.getByText(longName);
    // The row that holds the name must not also hold the quantity controls.
    const nameRow = name.closest('div');
    expect(nameRow).not.toBeNull();
    expect(
      nameRow!.querySelector('[aria-label="Tambah jumlah"]'),
      'the name is sharing its row with the stepper again — that is the squeeze MA-192 was',
    ).toBeNull();

    // Both figures still render in full ON THE LINE: unit price AND the
    // seven-figure total the old `w-24` cap clipped. Scoped to the lines list,
    // because the same total also appears in the subtotal/grand-total block.
    const list = within(screen.getByRole('list'));
    expect(list.getByText('Rp125.000')).toBeInTheDocument();
    expect(list.getByText('Rp1.125.000')).toBeInTheDocument();
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
