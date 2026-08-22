import { describe, it, expect } from 'vitest';
import { parseCsv, validate, ENTITIES, type EntityDef } from './import-schema';

const entity = (name: string): EntityDef => {
  const found = ENTITIES.find((e) => e.name === name);
  if (!found) throw new Error(`no entity ${name}`);
  return found;
};

/**
 * The importer's whole job is to refuse bad data BEFORE it reaches a real
 * database, so these tests are about the refusals as much as the happy path.
 * They run against the actual entity definitions rather than fixtures — a
 * column renamed in `ENTITIES` should break a test, not a production import.
 */
describe('parseCsv', () => {
  it('keeps commas and newlines that live inside quotes', () => {
    const csv = parseCsv('code,name\nA,"Jl. Sudirman 1, Balikpapan"\n');
    expect(csv.rows[0]!.values).toEqual(['A', 'Jl. Sudirman 1, Balikpapan']);
  });

  it('reads "" as a literal quote', () => {
    const csv = parseCsv('code,name\nA,"Ayam ""Geprek"" Spesial"\n');
    expect(csv.rows[0]!.values[1]).toBe('Ayam "Geprek" Spesial');
  });

  it('handles CRLF and a UTF-8 BOM, which is what Excel exports', () => {
    const csv = parseCsv('﻿code,name\r\nkg,Kilogram\r\n');
    expect(csv.header).toEqual(['code', 'name']);
    expect(csv.rows).toHaveLength(1);
    expect(csv.rows[0]!.values).toEqual(['kg', 'Kilogram']);
  });

  it('reports FILE line numbers, so an error matches what the editor shows', () => {
    const csv = parseCsv('code,name\na,A\nb,B\n');
    expect(csv.rows.map((r) => r.line)).toEqual([2, 3]);
  });

  it('ignores a trailing blank line rather than inventing an empty row', () => {
    expect(parseCsv('code,name\nkg,Kilogram\n\n').rows).toHaveLength(1);
  });
});

describe('validate', () => {
  it('accepts a good units file', () => {
    const result = validate(entity('units'), parseCsv('code,name\nkg,Kilogram\n'));
    expect(result.errors).toEqual([]);
    expect(result.rows[0]!.values).toEqual({ code: 'kg', name: 'Kilogram' });
  });

  it('names a misspelled header instead of silently dropping the column', () => {
    // The dangerous failure: "lattitude" would leave every latitude NULL and
    // look like missing source data rather than a typo.
    const result = validate(
      entity('locations'),
      parseCsv('code,name,type,city,lattitude\nA,B,outlet,Balikpapan,1\n'),
    );
    expect(result.errors.some((e) => e.message.includes('unknown column "lattitude"'))).toBe(true);
  });

  it('rejects a row whose field count differs from the header', () => {
    // An unquoted comma inside an address is how a phone number ends up in the
    // wrong column; padding or truncating would import that silently.
    const result = validate(entity('units'), parseCsv('code,name\nkg,Kilogram,extra\n'));
    expect(result.rows).toHaveLength(0);
    expect(result.errors[0]!.message).toMatch(/3 fields but the header has 2/);
  });

  it('flags a missing required column once, not once per row', () => {
    const result = validate(entity('units'), parseCsv('code\nkg\npcs\n'));
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.message).toMatch(/required column "name" is missing/);
  });

  it('collects EVERY bad row instead of stopping at the first', () => {
    const result = validate(
      entity('items'),
      parseCsv(
        'sku,name,base_unit,storage_type,is_sellable\n' +
          'A,,kg,frozen,yes\n' +
          'B,Bee,kg,lukewarm,yes\n' +
          'C,Cee,kg,dry,maybe\n',
      ),
    );
    expect(result.errors).toHaveLength(3);
    expect(result.errors.map((e) => e.line)).toEqual([2, 3, 4]);
  });

  it('normalises decimals to their contract scale, and accepts a comma separator', () => {
    // Money is 2dp, quantity 3dp, both as STRINGS (CONTRACTS §0) — and an
    // Indonesian spreadsheet writes 18500,50 rather than 18500.50.
    const products = validate(
      entity('products'),
      parseCsv('code,name,category,price\nP1,Ayam,Ayam,"18500,5"\n'),
    );
    expect(products.errors).toEqual([]);
    expect(products.rows[0]!.values.price).toBe('18500.50');

    const recipes = validate(
      entity('recipes'),
      parseCsv('product_code,item_sku,qty,unit\nP1,S1,0.25,kg\n'),
    );
    expect(recipes.rows[0]!.values.qty).toBe('0.250');
  });

  it('reads yes/no in either language and rejects anything else', () => {
    const ok = validate(
      entity('items'),
      parseCsv('sku,name,base_unit,storage_type,is_sellable\nA,Aa,kg,dry,ya\nB,Bb,kg,dry,No\n'),
    );
    expect(ok.errors).toEqual([]);
    expect(ok.rows.map((r) => r.values.is_sellable)).toEqual(['true', 'false']);
  });

  it('refuses to guess between two rows with the same natural key', () => {
    const result = validate(entity('units'), parseCsv('code,name\nkg,Kilogram\nKG,Kilo\n'));
    expect(result.rows).toHaveLength(1);
    expect(result.errors[0]!.message).toMatch(/already appears on line 2/);
  });

  it('allows many rows per product in recipes — that IS the format', () => {
    const result = validate(
      entity('recipes'),
      parseCsv('product_code,item_sku,qty,unit\nP1,S1,1,kg\nP1,S2,2,kg\n'),
    );
    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(2);
  });

  it('leaves an empty optional column NULL rather than writing an empty string', () => {
    // The importer's upsert COALESCEs NULL to the existing value, which is what
    // stops an import that omits `phone` from erasing a phone number someone
    // typed into the UI. An empty string would overwrite it.
    const result = validate(
      entity('locations'),
      parseCsv('code,name,type,city,phone\nA,B,outlet,Balikpapan,\n'),
    );
    expect(result.errors).toEqual([]);
    expect(result.rows[0]!.values.phone).toBeNull();
  });
});
