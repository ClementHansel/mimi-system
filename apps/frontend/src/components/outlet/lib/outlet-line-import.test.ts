/**
 * These mappers stand between a spreadsheet three people typed into and a
 * document that writes off stock or claims cash. Every case below is a way a
 * real count sheet is wrong: a misspelt SKU, a blank quantity, an Indonesian
 * decimal comma, two items with the same name, and columns that got sorted
 * independently of each other.
 *
 * The rule under test throughout: a row that cannot be read becomes a REPORTED
 * error, never a silent zero and never a guess.
 */
import { describe, it, expect } from 'vitest';
import { parseCsv, type CsvRecord } from '@/lib/import/csv-parse';
import {
  makeItemResolver,
  makeAreaResolver,
  makeOpnameCountMapper,
  makeReplenishmentMapper,
  makeWasteMapper,
  makeReturnMapper,
  makePettyCashMapper,
  OPNAME_IMPORT_COLUMNS,
  REPLENISHMENT_IMPORT_COLUMNS,
  WASTE_IMPORT_COLUMNS,
  RETURN_IMPORT_COLUMNS,
  PETTY_CASH_IMPORT_COLUMNS,
} from './outlet-line-import';
import type { Item, OpnameLine, StorageArea } from './types';

function item(id: string, sku: string, name: string): Item {
  return {
    id,
    sku,
    name,
    categoryId: null,
    categoryName: null,
    baseUnit: { id: 'u1', code: 'kg' },
    storageType: 'frozen',
    isSellable: false,
    shelfLifeDays: null,
    tempMin: null,
    tempMax: null,
    barcode: null,
    isActive: true,
  };
}

function area(id: string, code: string, name: string): StorageArea {
  return {
    id,
    locationId: 'loc1',
    code,
    name,
    type: 'frozen',
    tempMin: null,
    tempMax: null,
    sortOrder: 0,
    isActive: true,
  };
}

function opnameLine(id: string, itemName: string, areaName: string, areaId = 'a1'): OpnameLine {
  return {
    id,
    storageAreaId: areaId,
    storageAreaName: areaName,
    itemId: `i-${id}`,
    itemName,
    unitCode: 'kg',
    systemQty: '10.000',
    countedQty: '0',
    diffQty: '0',
    varianceReason: null,
    disputed: false,
  };
}

const ITEMS = [
  item('i1', 'AYM-001', 'Ayam Utuh'),
  item('i2', 'SYR-001', 'Sayur Bayam'),
  // Same NAME, different SKU — a real catalogue state (two brands).
  item('i3', 'AYM-002', 'Ayam Potong'),
  item('i4', 'AYM-003', 'Ayam Potong'),
];
const AREAS = [area('a1', 'FRZ1', 'Freezer 1'), area('a2', 'CHL1', 'Chiller 1')];

/** Build one CsvRecord through the real parser, so header folding is exercised too. */
function row(headers: string, values: string): CsvRecord {
  const parsed = parseCsv(`${headers}\n${values}`);
  const first = parsed.rows[0];
  if (!first) throw new Error('no row parsed');
  return first;
}

describe('makeItemResolver', () => {
  const r = makeItemResolver(ITEMS);

  it('resolves by SKU and by name, ignoring case and padding', () => {
    expect(r.resolve('AYM-001', '')).toEqual({ ok: true, value: ITEMS[0] });
    expect(r.resolve(' aym-001 ', '')).toEqual({ ok: true, value: ITEMS[0] });
    expect(r.resolve('', 'ayam utuh')).toEqual({ ok: true, value: ITEMS[0] });
  });

  it('refuses an ambiguous name and says to use the SKU', () => {
    const res = r.resolve('', 'Ayam Potong');
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected failure');
    expect(res.error).toContain('sku');
  });

  it('resolves an ambiguous name when the SKU disambiguates it', () => {
    expect(r.resolve('AYM-003', 'Ayam Potong')).toEqual({ ok: true, value: ITEMS[3] });
  });

  it('rejects a SKU/name disagreement instead of preferring the SKU', () => {
    // Columns sorted independently in Excel — the accident that silently
    // ordering by SKU would hide.
    const res = r.resolve('AYM-001', 'Sayur Bayam');
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected failure');
    expect(res.error).toContain('tergeser');
  });

  it('names the unknown value it could not find', () => {
    const bad = r.resolve('NOPE-9', '');
    expect(bad.ok).toBe(false);
    if (bad.ok) throw new Error('expected failure');
    expect(bad.error).toContain('NOPE-9');
  });

  it('rejects a row with neither column filled', () => {
    expect(r.resolve('', '').ok).toBe(false);
  });
});

describe('makeAreaResolver', () => {
  const r = makeAreaResolver(AREAS);

  it('resolves by code or by name', () => {
    expect(r.resolve('FRZ1')).toEqual({ ok: true, value: AREAS[0] });
    expect(r.resolve('freezer 1')).toEqual({ ok: true, value: AREAS[0] });
  });

  it('reports an unknown area rather than defaulting to the first', () => {
    const res = r.resolve('Freezer 9');
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected failure');
    expect(res.error).toContain('Freezer 9');
  });
});

describe('opname count import', () => {
  const SHEET = [
    opnameLine('l1', 'Ayam Utuh', 'Freezer 1', 'a1'),
    opnameLine('l2', 'Sayur Bayam', 'Chiller 1', 'a2'),
    // Same item counted in two areas — the case a name alone cannot resolve.
    opnameLine('l3', 'Ayam Potong', 'Freezer 1', 'a1'),
    opnameLine('l4', 'Ayam Potong', 'Chiller 1', 'a2'),
  ];
  const map = makeOpnameCountMapper(SHEET);
  const H = 'nama_barang,area_simpan,qty_hitung,alasan_selisih';

  it('fills the matching sheet line', () => {
    expect(map(row(H, 'Ayam Utuh,,12.5,'))).toEqual({
      ok: true,
      line: { lineId: 'l1', countedQty: '12.5', varianceReason: '' },
    });
  });

  it('ACCEPTS a count of zero — "we have none left" is the point of a count', () => {
    const res = map(row(H, 'Ayam Utuh,,0,habis terjual'));
    expect(res).toEqual({
      ok: true,
      line: { lineId: 'l1', countedQty: '0', varianceReason: 'habis terjual' },
    });
  });

  it('reads an Indonesian decimal comma', () => {
    const res = map(row(H, 'Ayam Utuh,,"12,5",'));
    expect(res.ok && res.line?.countedQty).toBe('12.5');
  });

  it('needs the area when one name sits in two of them', () => {
    const res = map(row(H, 'Ayam Potong,,5,'));
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected failure');
    expect(res.error).toContain('area_simpan');

    expect(map(row(H, 'Ayam Potong,Chiller 1,5,'))).toEqual({
      ok: true,
      line: { lineId: 'l4', countedQty: '5', varianceReason: '' },
    });
  });

  it('never CREATES a line for an item the sheet does not contain', () => {
    const res = map(row(H, 'Daging Sapi,,5,'));
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected failure');
    expect(res.error).toContain('Daging Sapi');
  });

  it('reports an item that exists but not in the named area', () => {
    const res = map(row(H, 'Sayur Bayam,Freezer 1,5,'));
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected failure');
    expect(res.error).toContain('Freezer 1');
  });

  it('rejects a blank, non-numeric or negative count instead of importing zero', () => {
    for (const qty of ['', 'dua belas', '-3']) {
      const res = map(row(H, `Ayam Utuh,,${qty},`));
      expect(res.ok, `qty=${qty}`).toBe(false);
    }
  });
});

describe('replenishment line import', () => {
  const map = makeReplenishmentMapper(ITEMS);
  const H = 'sku,nama_barang,qty';

  it('maps a resolved item and quantity', () => {
    expect(map(row(H, 'AYM-001,,10'))).toEqual({
      ok: true,
      line: { itemId: 'i1', qtyRequested: '10' },
    });
  });

  it('reads a QUANTITY dot as a decimal point, not grouping', () => {
    // Deliberately the opposite of the money rule below: stock is genuinely
    // fractional, so `1.500` kg is a kilo and a half. Requesting 1500 kg of
    // chicken because a dot was read as a thousands separator would be the
    // worse error by three orders of magnitude.
    const res = map(row(H, 'AYM-001,,"1.500"'));
    expect(res.ok && res.line?.qtyRequested).toBe('1.500');
    // An Indonesian decimal comma still means the same thing.
    const comma = map(row(H, 'AYM-001,,"1,5"'));
    expect(comma.ok && comma.line?.qtyRequested).toBe('1.5');
  });

  it('rejects a zero or blank request', () => {
    expect(map(row(H, 'AYM-001,,0')).ok).toBe(false);
    expect(map(row(H, 'AYM-001,,')).ok).toBe(false);
  });
});

describe('waste line import', () => {
  const map = makeWasteMapper(ITEMS, AREAS);
  const H = 'area_simpan,sku,nama_barang,qty,alasan,detail_alasan';

  it('maps a full line', () => {
    expect(map(row(H, 'Freezer 1,AYM-001,,2.5,expired,lewat tanggal'))).toEqual({
      ok: true,
      line: {
        storageAreaId: 'a1',
        itemId: 'i1',
        qty: '2.5',
        reason: 'expired',
        reasonDetail: 'lewat tanggal',
      },
    });
  });

  it('demands a reason and lists the accepted ones', () => {
    const blank = map(row(H, 'Freezer 1,AYM-001,,2.5,,'));
    expect(blank.ok).toBe(false);
    if (blank.ok) throw new Error('expected failure');
    expect(blank.error).toContain('expired');

    const wrong = map(row(H, 'Freezer 1,AYM-001,,2.5,busuk,'));
    expect(wrong.ok).toBe(false);
    if (wrong.ok) throw new Error('expected failure');
    expect(wrong.error).toContain('spoiled');
  });

  it('rejects a zero write-off', () => {
    expect(map(row(H, 'Freezer 1,AYM-001,,0,expired,')).ok).toBe(false);
  });
});

describe('return line import', () => {
  const map = makeReturnMapper(ITEMS, AREAS);
  const H = 'area_simpan,sku,nama_barang,qty,kondisi,alasan';

  it('defaults a blank condition to the form default', () => {
    const res = map(row(H, 'Chiller 1,SYR-001,,3,,kemasan bocor'));
    expect(res).toEqual({
      ok: true,
      line: {
        itemId: 'i2',
        storageAreaId: 'a2',
        qty: '3',
        condition: 'damaged',
        reason: 'kemasan bocor',
      },
    });
  });

  it('rejects an unrecognised condition rather than falling back', () => {
    const res = map(row(H, 'Chiller 1,SYR-001,,3,penyok,kemasan bocor'));
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected failure');
    expect(res.error).toContain('wrong_item');
  });

  it('requires a reason', () => {
    expect(map(row(H, 'Chiller 1,SYR-001,,3,damaged,')).ok).toBe(false);
  });
});

describe('petty cash line import', () => {
  const map = makePettyCashMapper(ITEMS);
  const H = 'keterangan,kategori_biaya,jumlah,sku,nama_barang,qty';

  it('imports a NON-STOCK expense with no item at all', () => {
    // Most petty cash is a parking fee or a plumber, not a stock item.
    expect(map(row(H, 'Parkir pasar,operasional_lain,5000,,,'))).toEqual({
      ok: true,
      line: {
        description: 'Parkir pasar',
        itemId: '',
        qty: null,
        amount: '5000',
        expenseCategory: 'operasional_lain',
      },
    });
  });

  it('links an item and qty when given', () => {
    const res = map(row(H, 'Beli ayam,bahan_baku,120000,AYM-001,,2'));
    expect(res).toEqual({
      ok: true,
      line: {
        description: 'Beli ayam',
        itemId: 'i1',
        qty: '2',
        amount: '120000',
        expenseCategory: 'bahan_baku',
      },
    });
  });

  it('defaults a blank category but rejects a wrong one', () => {
    const res = map(row(H, 'Beli ayam,,120000,,,'));
    expect(res.ok && res.line?.expenseCategory).toBe('bahan_baku');
    expect(map(row(H, 'Beli ayam,makanan,120000,,,')).ok).toBe(false);
  });

  it('requires a description and a positive amount', () => {
    expect(map(row(H, ',bahan_baku,120000,,,')).ok).toBe(false);
    expect(map(row(H, 'Beli ayam,bahan_baku,0,,,')).ok).toBe(false);
    expect(map(row(H, 'Beli ayam,bahan_baku,,,,')).ok).toBe(false);
  });

  it('reads rupiah written with thousands dots as thousands', () => {
    // `parseDecimal` alone reads `120.000` as one hundred and twenty — right
    // for a quantity, a 1000x understatement of a cash claim. Rupiah has no
    // subunit in practice, so for money a dot before exactly three digits is
    // grouping. This is the case that made `positiveMoney` exist.
    const res = map(row(H, 'Beli ayam,bahan_baku,"120.000",,,'));
    expect(res.ok && res.line?.amount).toBe('120000');

    const millions = map(row(H, 'Beli ayam,bahan_baku,"1.250.000",,,'));
    expect(millions.ok && millions.line?.amount).toBe('1250000');

    // A genuine decimal amount is still left alone — only the exactly-three
    // -digit grouping shape is degrouped.
    const cents = map(row(H, 'Beli ayam,bahan_baku,"120.5",,,'));
    expect(cents.ok && cents.line?.amount).toBe('120.5');
  });
});

describe('declared columns', () => {
  it('declare every header their mapper reads', () => {
    // `LineImportButton` flags any header the file has that the column list
    // does not declare, as a "wrong file" signal. A header the mapper reads but
    // the list omits would make the app's OWN template look like a wrong file.
    const cases: [{ header: string }[], string[]][] = [
      [OPNAME_IMPORT_COLUMNS, ['nama_barang', 'area_simpan', 'qty_hitung', 'alasan_selisih']],
      [REPLENISHMENT_IMPORT_COLUMNS, ['sku', 'nama_barang', 'qty']],
      [
        WASTE_IMPORT_COLUMNS,
        ['area_simpan', 'sku', 'nama_barang', 'qty', 'alasan', 'detail_alasan'],
      ],
      [RETURN_IMPORT_COLUMNS, ['area_simpan', 'sku', 'nama_barang', 'qty', 'kondisi', 'alasan']],
      [
        PETTY_CASH_IMPORT_COLUMNS,
        ['keterangan', 'kategori_biaya', 'jumlah', 'sku', 'nama_barang', 'qty'],
      ],
    ];
    for (const [columns, expected] of cases) {
      expect(columns.map((c) => c.header)).toEqual(expected);
    }
  });
});
