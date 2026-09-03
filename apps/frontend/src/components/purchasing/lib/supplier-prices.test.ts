import { describe, expect, it } from 'vitest';
import { fillLinePrices } from './supplier-prices';
import type { Money } from '@/lib/shared-types';

const PRICES: Record<string, Money> = {
  i1: '30360.35' as Money,
  i2: '1693.49' as Money,
};

describe('fillLinePrices', () => {
  it("fills a blank line with the supplier's own price", () => {
    // THE REPORTED DEFECT: choosing a supplier left every price empty, because
    // the only source was the PR estimate and a converted outlet request has
    // none.
    const next = fillLinePrices([{ itemId: 'i1', unitPrice: null }], PRICES);
    expect(next).toEqual([{ itemId: 'i1', unitPrice: '30360.35' }]);
  });

  it('never overwrites a price the buyer typed', () => {
    // A figure on the form is a commitment the buyer made — the supplier's list
    // is a suggestion. Overwriting it would change an order behind their back.
    const next = fillLinePrices([{ itemId: 'i1', unitPrice: '29000.00' as Money }], PRICES);
    expect(next, 'a typed price was replaced by the price list').toBeNull();
  });

  it('leaves items the supplier does not sell alone', () => {
    const next = fillLinePrices([{ itemId: 'unknown', unitPrice: null }], PRICES);
    expect(next).toBeNull();
  });

  it('ignores an empty line', () => {
    // A freshly-added row has no item yet and must not acquire a price.
    expect(fillLinePrices([{ itemId: '', unitPrice: null }], PRICES)).toBeNull();
  });

  it('fills only the blanks in a mixed set', () => {
    const next = fillLinePrices(
      [
        { itemId: 'i1', unitPrice: '29000.00' as Money },
        { itemId: 'i2', unitPrice: null },
        { itemId: 'unknown', unitPrice: null },
      ],
      PRICES,
    );

    expect(next).toEqual([
      { itemId: 'i1', unitPrice: '29000.00' },
      { itemId: 'i2', unitPrice: '1693.49' },
      { itemId: 'unknown', unitPrice: null },
    ]);
  });

  it('returns null when there is no price list at all', () => {
    // A supplier with no items is normal, and must not clear the form.
    expect(fillLinePrices([{ itemId: 'i1', unitPrice: null }], {})).toBeNull();
  });

  it('preserves any other fields on the line', () => {
    const next = fillLinePrices(
      [{ itemId: 'i1', unitPrice: null, qtyOrdered: '5.000', unitId: 'u1' }],
      PRICES,
    );
    expect(next![0]).toMatchObject({ qtyOrdered: '5.000', unitId: 'u1' });
  });
});
