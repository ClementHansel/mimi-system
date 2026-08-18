import { describe, it, expect } from 'vitest';
import { MovementType } from '@mimi/shared';
import {
  applyMovement,
  explodeAreaTransferToMovements,
  explodeSaleToMovements,
  foldMovementsToBalances,
  movementSign,
  projectBalanceAt,
  reconcileBalance,
  stockKeyOf,
  type MovementFact,
} from './stock-projector';

const LOC = 'loc-1';
const AREA = 'area-1';
const ITEM = 'item-ayam';

function movement(overrides: Partial<MovementFact> = {}): MovementFact {
  return {
    locationId: LOC,
    storageAreaId: AREA,
    itemId: ITEM,
    factId: 'fact-1',
    movementType: MovementType.PURCHASE_IN,
    qty: '10.000',
    unitCost: '20000.00',
    refType: 'goods_receipt',
    refId: 'gr-1',
    occurredAt: '2026-08-17T00:00:00.000Z',
    ...overrides,
  };
}

describe('movementSign', () => {
  it('is +1 for _in types and -1 for _out types', () => {
    expect(movementSign(MovementType.PURCHASE_IN)).toBe(1);
    expect(movementSign(MovementType.USAGE_OUT)).toBe(-1);
    expect(movementSign(MovementType.TRANSFER_IN)).toBe(1);
    expect(movementSign(MovementType.WASTE_OUT)).toBe(-1);
  });
});

describe('explodeSaleToMovements (FR-POS-06 recipe explosion)', () => {
  it('aggregates ingredient usage across sale lines sharing an ingredient', () => {
    const recipes = new Map([
      ['product-ayam-goreng', [{ itemId: 'item-ayam', qtyPerUnit: '0.300', unitCost: '20000.00' }]],
      [
        'product-paket',
        [
          { itemId: 'item-ayam', qtyPerUnit: '0.300', unitCost: '20000.00' },
          { itemId: 'item-nasi', qtyPerUnit: '0.200', unitCost: '5000.00' },
        ],
      ],
    ]);
    const movements = explodeSaleToMovements(
      'sale-1',
      [
        { productId: 'product-ayam-goreng', qty: '2.000' },
        { productId: 'product-paket', qty: '1.000' },
      ],
      recipes,
      { locationId: LOC, storageAreaId: AREA },
      '2026-08-17T05:00:00.000Z',
    );

    const ayam = movements.find((m) => m.itemId === 'item-ayam')!;
    const nasi = movements.find((m) => m.itemId === 'item-nasi')!;
    expect(ayam.qty).toBe('0.900'); // (2 * 0.3) + (1 * 0.3)
    expect(ayam.movementType).toBe(MovementType.USAGE_OUT);
    expect(nasi.qty).toBe('0.200');
  });

  it('skips products with no recipe (e.g. a bottled drink)', () => {
    const movements = explodeSaleToMovements(
      'sale-2',
      [{ productId: 'product-drink', qty: '3.000' }],
      new Map(),
      { locationId: LOC, storageAreaId: AREA },
      '2026-08-17T05:00:00.000Z',
    );
    expect(movements).toHaveLength(0);
  });

  it('produces stable, per-item factIds derived from the sale event id', () => {
    const recipes = new Map([
      ['p', [{ itemId: 'item-x', qtyPerUnit: '1.000', unitCost: '100.00' }]],
    ]);
    const movements = explodeSaleToMovements(
      'sale-3',
      [{ productId: 'p', qty: '1.000' }],
      recipes,
      { locationId: LOC, storageAreaId: AREA },
      '2026-08-17T00:00:00.000Z',
    );
    expect(movements[0]!.factId).toBe('sale-3:usage:item-x');
  });
});

describe('explodeAreaTransferToMovements', () => {
  it('produces a paired transfer_out/transfer_in at the same location', () => {
    const movements = explodeAreaTransferToMovements(
      'xfer-1',
      LOC,
      ITEM,
      'area-freezer',
      'area-kitchen',
      '5.000',
      '20000.00',
      '2026-08-17T00:00:00.000Z',
    );
    expect(movements).toHaveLength(2);
    expect(movements[0]!.movementType).toBe(MovementType.TRANSFER_OUT);
    expect(movements[0]!.storageAreaId).toBe('area-freezer');
    expect(movements[1]!.movementType).toBe(MovementType.TRANSFER_IN);
    expect(movements[1]!.storageAreaId).toBe('area-kitchen');
  });
});

describe('foldMovementsToBalances', () => {
  it('sums signed quantities per (location, area, item)', () => {
    const movements = [
      movement({ factId: 'f1', movementType: MovementType.PURCHASE_IN, qty: '10.000' }),
      movement({ factId: 'f2', movementType: MovementType.USAGE_OUT, qty: '3.000' }),
      movement({ factId: 'f3', movementType: MovementType.WASTE_OUT, qty: '1.500' }),
    ];
    const balances = foldMovementsToBalances(movements);
    const balance = balances.get(
      stockKeyOf({ locationId: LOC, storageAreaId: AREA, itemId: ITEM }),
    );
    expect(balance?.qtyOnHand).toBe('5.500'); // 10 - 3 - 1.5
  });

  it('deduplicates by factId — replaying the same fact twice changes nothing', () => {
    const fact = movement({ factId: 'dup-1', qty: '7.000' });
    const balances = foldMovementsToBalances([fact, fact, fact]);
    expect(balances.get(stockKeyOf(fact))?.qtyOnHand).toBe('7.000');
  });

  it('keeps separate keys independent', () => {
    const movements = [
      movement({ factId: 'a', itemId: 'item-a', qty: '10.000' }),
      movement({ factId: 'b', itemId: 'item-b', qty: '4.000' }),
    ];
    const balances = foldMovementsToBalances(movements);
    expect(balances.size).toBe(2);
  });
});

describe('projectBalanceAt', () => {
  it('returns zero for a key with no movements', () => {
    expect(
      projectBalanceAt([], { locationId: LOC, storageAreaId: AREA, itemId: 'nothing-here' }),
    ).toBe('0.000');
  });
});

describe('applyMovement — D-17a dual mode', () => {
  it('strict mode rejects a movement that would drive the balance negative', () => {
    const result = applyMovement(
      '5.000',
      movement({ movementType: MovementType.USAGE_OUT, qty: '10.000' }),
      'strict',
    );
    expect(result).toMatchObject({ ok: false, code: 'ERR_STOCK_INSUFFICIENT' });
  });

  it('fact mode applies the same movement and flags the negative result instead of rejecting', () => {
    const result = applyMovement(
      '5.000',
      movement({ movementType: MovementType.USAGE_OUT, qty: '10.000' }),
      'fact',
    );
    expect(result).toMatchObject({ ok: true, nextBalance: '-5.000', wentNegative: true });
  });

  it('both modes agree when the result stays non-negative', () => {
    const fact = movement({ movementType: MovementType.PURCHASE_IN, qty: '10.000' });
    expect(applyMovement('5.000', fact, 'strict')).toEqual(applyMovement('5.000', fact, 'fact'));
  });
});

describe('reconcileBalance', () => {
  it('reports no divergence when the stored balance matches the fold', () => {
    const fact = movement({ qty: '10.000' });
    const result = reconcileBalance(
      { locationId: LOC, storageAreaId: AREA, itemId: ITEM },
      '10.000',
      [fact],
    );
    expect(result.matches).toBe(true);
    expect(result.divergence).toBe('0.000');
  });

  it('reports the exact divergence when they differ (R1/R2)', () => {
    const fact = movement({ qty: '10.000' });
    const result = reconcileBalance(
      { locationId: LOC, storageAreaId: AREA, itemId: ITEM },
      '12.000',
      [fact],
    );
    expect(result.matches).toBe(false);
    expect(result.divergence).toBe('-2.000'); // expected(10) - stored(12)
  });
});
