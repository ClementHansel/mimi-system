import { describe, expect, it } from 'vitest';
import { buildOpnameSheet } from './opname-sheet';
import type { Balance, OpnameLine } from './types';

function balance(itemId: string, itemName: string, qty: string, areaId = 'a1'): Balance {
  return {
    locationId: 'loc-1',
    storageAreaId: areaId,
    storageAreaName: areaId === 'a1' ? 'Dry Store' : 'Freezer',
    storageAreaType: 'dry',
    itemId,
    sku: `SKU-${itemId}`,
    itemName,
    unitCode: 'kg',
    qtyOnHand: qty,
    minQty: null,
    belowMin: false,
  };
}

function line(id: string, itemId: string, itemName: string, over: Partial<OpnameLine> = {}) {
  return {
    id,
    storageAreaId: 'a1',
    storageAreaName: 'Dry Store',
    itemId,
    itemName,
    unitCode: 'kg',
    systemQty: '10.000',
    countedQty: '8.000',
    diffQty: '-2.000',
    varianceReason: 'susut',
    disputed: false,
    ...over,
  } satisfies OpnameLine;
}

describe('buildOpnameSheet', () => {
  it('puts every item in the area on the sheet, uncounted', () => {
    // THE DEFECT THIS GUARDS. A fresh count has no lines at all, because a line
    // can only exist once a quantity has been entered. Rendering lines alone
    // gave an empty sheet with no way to add a row, so a count against a
    // stocked area could not be performed — the whole flow was a dead end.
    const sheet = buildOpnameSheet([], [balance('i1', 'Ayam Utuh', '12.000')]);

    expect(sheet).toHaveLength(1);
    expect(sheet[0]).toMatchObject({
      itemId: 'i1',
      itemName: 'Ayam Utuh',
      systemQty: '12.000',
      countedQty: null,
    });
    expect(sheet[0]!.lineId, 'an uncounted row must not claim a saved line').toBeUndefined();
  });

  it('leaves an uncounted row blank rather than zero', () => {
    // A zero is a real count — "we have none left" — and is the largest
    // variance a sheet can carry. Defaulting an untouched row to 0 would submit
    // a whole area as empty.
    const sheet = buildOpnameSheet([], [balance('i1', 'Ayam Utuh', '12.000')]);
    expect(sheet[0]!.countedQty).toBeNull();
  });

  it('overlays what has already been counted', () => {
    const sheet = buildOpnameSheet(
      [line('l1', 'i1', 'Ayam Utuh')],
      [balance('i1', 'Ayam Utuh', '12.000')],
    );

    expect(sheet).toHaveLength(1);
    expect(sheet[0]).toMatchObject({
      lineId: 'l1',
      countedQty: '8.000',
      varianceReason: 'susut',
    });
  });

  it('keeps the SNAPSHOTTED system qty, not the live balance', () => {
    // The line's `system_qty` was frozen when the count was recorded. Taking
    // the live balance instead would let stock moving during the count shrink a
    // real variance to nothing — the count would always appear to agree.
    const sheet = buildOpnameSheet(
      [line('l1', 'i1', 'Ayam Utuh', { systemQty: '10.000' })],
      [balance('i1', 'Ayam Utuh', '3.000')],
    );

    expect(sheet[0]!.systemQty).toBe('10.000');
  });

  it('keeps a counted item whose balance row is gone', () => {
    // Counting an item down to zero can remove its balance row. Dropping it
    // from the sheet would erase a count somebody already did.
    const sheet = buildOpnameSheet([line('l1', 'i1', 'Ayam Utuh', { countedQty: '0' })], []);

    expect(sheet).toHaveLength(1);
    expect(sheet[0]).toMatchObject({ lineId: 'l1', countedQty: '0' });
  });

  it('counts the same item in two areas as two rows', () => {
    // Stock is counted per storage area. Keying by item alone would collapse
    // the freezer and the dry store into one line and lose half the count.
    const sheet = buildOpnameSheet(
      [],
      [balance('i1', 'Ayam Utuh', '12.000', 'a1'), balance('i1', 'Ayam Utuh', '4.000', 'a2')],
    );

    expect(sheet).toHaveLength(2);
    expect(sheet.map((r) => r.storageAreaName)).toEqual(['Dry Store', 'Freezer']);
  });

  it('orders rows by area then item, stably', () => {
    const sheet = buildOpnameSheet(
      [],
      [
        balance('i2', 'Sayur Bayam', '1.000'),
        balance('i1', 'Ayam Utuh', '2.000'),
        balance('i3', 'Beras', '3.000', 'a2'),
      ],
    );

    expect(sheet.map((r) => r.itemName)).toEqual(['Ayam Utuh', 'Sayur Bayam', 'Beras']);
  });
});
