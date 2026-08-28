import { describe, it, expect } from 'vitest';
import { DOC_CATALOGS, DOC_TOTALS_ROWS } from './catalog';
import { defaultDocTemplate } from './defaults';
import {
  BRAND_COLOR_TOKENS,
  DOC_KINDS,
  DOC_PAPER_SIZES,
  DOC_TEMPLATE_LIMITS,
  isDocKind,
  resolveDocColor,
  type DocKind,
  type DocTemplate,
} from './template';
import { validateDocTemplate } from './validate';
import { DEFAULT_BRAND_PALETTE } from '../brand';

function clone(tpl: DocTemplate): DocTemplate {
  return JSON.parse(JSON.stringify(tpl)) as DocTemplate;
}

describe('DocKind', () => {
  it('covers exactly the four documents the owner asked for', () => {
    expect([...DOC_KINDS]).toEqual(['invoice', 'receipt', 'voucher', 'surat_jalan']);
  });

  it('rejects anything else, so an untrusted :kind route param cannot reach a resolver', () => {
    expect(isDocKind('report')).toBe(false);
    expect(isDocKind('')).toBe(false);
    expect(isDocKind(null)).toBe(false);
  });
});

describe('seeded defaults', () => {
  it.each(DOC_KINDS)('%s validates against its own kind', (kind) => {
    expect(validateDocTemplate(kind, defaultDocTemplate(kind))).toEqual([]);
  });

  it.each(DOC_KINDS)('%s uses ONLY brand colour tokens, never a literal hex', (kind) => {
    // This is the assertion behind "changing the brand colour re-colours every
    // document". A literal hex slipping into a seeded default would silently
    // opt that element out of the palette forever.
    for (const el of defaultDocTemplate(kind).elements) {
      for (const value of [el.color, el.background]) {
        if (value === undefined) continue;
        expect(BRAND_COLOR_TOKENS).toContain(value);
      }
    }
  });

  it.each(DOC_KINDS)('%s seeds no `text` element, so no product copy lives in this package', (kind) => {
    expect(defaultDocTemplate(kind).elements.some((el) => el.type === 'text')).toBe(false);
  });

  it.each(DOC_KINDS)('%s only places field tokens its own catalog advertises', (kind) => {
    const catalog = DOC_CATALOGS[kind];
    for (const el of defaultDocTemplate(kind).elements) {
      if (el.type === 'field') expect(catalog.fields).toContain(el.field);
      if (el.type === 'table') {
        for (const col of el.columns ?? []) expect(catalog.columns).toContain(col.key);
      }
    }
  });

  it.each(DOC_KINDS)('%s matches its declared paper size', (kind) => {
    const tpl = defaultDocTemplate(kind);
    expect({ width: tpl.width, height: tpl.height }).toEqual(DOC_PAPER_SIZES[tpl.paper]);
  });

  it('hands back a deep copy — a caller that mutates one cannot poison the next request', () => {
    const first = defaultDocTemplate('invoice');
    first.elements[0]!.x = 999;
    first.elements.find((e) => e.type === 'table')!.columns![0]!.width = 999;
    const second = defaultDocTemplate('invoice');
    expect(second.elements[0]!.x).not.toBe(999);
    expect(second.elements.find((e) => e.type === 'table')!.columns![0]!.width).not.toBe(999);
  });

  it('lays out every table so its columns exactly fill the element width', () => {
    // A column set that overflows its element is how a printed invoice loses
    // its rightmost money column off the edge of the paper.
    for (const kind of DOC_KINDS) {
      for (const el of defaultDocTemplate(kind).elements) {
        if (el.type !== 'table') continue;
        const total = (el.columns ?? []).reduce((sum, c) => sum + c.width, 0);
        expect(`${kind}:${total}`).toBe(`${kind}:${el.w}`);
      }
    }
  });

  it('gives a kind a totals block only where money belongs', () => {
    // A Surat Jalan travels with the goods and must never print a rupiah
    // figure; a voucher has no line items to total.
    expect(DOC_TOTALS_ROWS.surat_jalan).toEqual([]);
    expect(DOC_TOTALS_ROWS.voucher).toEqual([]);
    expect(DOC_CATALOGS.surat_jalan.elements).not.toContain('totals');
    expect(DOC_TOTALS_ROWS.invoice.length).toBeGreaterThan(0);
  });
});

describe('resolveDocColor', () => {
  it('maps every brand token to the palette', () => {
    expect(resolveDocColor('brand.primary', DEFAULT_BRAND_PALETTE)).toBe(
      DEFAULT_BRAND_PALETTE.primary,
    );
    expect(resolveDocColor('brand.accent', DEFAULT_BRAND_PALETTE)).toBe(
      DEFAULT_BRAND_PALETTE.accent,
    );
    expect(resolveDocColor('brand.muted', DEFAULT_BRAND_PALETTE)).toBe(DEFAULT_BRAND_PALETTE.muted);
  });

  it('passes a literal hex straight through — an owner opting one element out keeps it', () => {
    expect(resolveDocColor('#123abc', DEFAULT_BRAND_PALETTE)).toBe('#123abc');
  });

  it('falls back to ink rather than throwing on junk — a wrong colour beats a document that will not print', () => {
    expect(resolveDocColor('rgb(1,2,3)', DEFAULT_BRAND_PALETTE)).toBe(DEFAULT_BRAND_PALETTE.ink);
    expect(resolveDocColor(undefined, DEFAULT_BRAND_PALETTE)).toBe(DEFAULT_BRAND_PALETTE.ink);
  });
});

describe('validateDocTemplate — structural only', () => {
  const base = () => defaultDocTemplate('invoice');

  it('rejects an unknown kind before looking at anything else', () => {
    expect(validateDocTemplate('report', base())).toEqual([
      "'report' is not a document kind",
    ]);
  });

  it('rejects a template whose kind does not match the slot it is saved into', () => {
    const tpl = { ...base(), kind: 'receipt' as DocKind };
    expect(validateDocTemplate('invoice', tpl).join()).toMatch(/does not match/);
  });

  it('rejects an element type the kind does not offer', () => {
    // A thermal receipt offers no signature block — nobody signs a receipt.
    const tpl = clone(defaultDocTemplate('receipt'));
    tpl.elements.push({
      id: 'sig',
      type: 'signature',
      signatureRole: 'sender',
      x: 0,
      y: 0,
      w: 100,
      h: 40,
    });
    expect(validateDocTemplate('receipt', tpl).join()).toMatch(
      /'signature' is not available on a 'receipt'/,
    );
  });

  it('rejects a field token from another kind', () => {
    const tpl = clone(base());
    tpl.elements.push({ id: 'x', type: 'field', field: 'sj_number', x: 0, y: 0, w: 100, h: 20 });
    expect(validateDocTemplate('invoice', tpl).join()).toMatch(/is not a 'invoice' field token/);
  });

  it('rejects geometry that runs off the page in either axis', () => {
    const tpl = clone(base());
    tpl.elements.push({ id: 'wide', type: 'text', text: 'x', x: 700, y: 10, w: 400, h: 20 });
    tpl.elements.push({ id: 'tall', type: 'text', text: 'x', x: 10, y: 1100, w: 100, h: 200 });
    const errors = validateDocTemplate('invoice', tpl).join('\n');
    expect(errors).toMatch(/outside the 794px page width/);
    expect(errors).toMatch(/outside the 1123px page height/);
  });

  it('rejects duplicate element ids', () => {
    const tpl = clone(base());
    tpl.elements.push({ ...tpl.elements[0]! });
    expect(validateDocTemplate('invoice', tpl).join()).toMatch(/is duplicated/);
  });

  it('rejects a colour that is neither a hex nor a brand token', () => {
    const tpl = clone(base());
    tpl.elements[0]!.color = 'red';
    expect(validateDocTemplate('invoice', tpl).join()).toMatch(/#rrggbb or a brand/);
  });

  it('rejects a table with no columns, and a duplicated column', () => {
    const empty = clone(base());
    empty.elements.find((e) => e.type === 'table')!.columns = [];
    expect(validateDocTemplate('invoice', empty).join()).toMatch(/at least one column/);

    const dupe = clone(base());
    const table = dupe.elements.find((e) => e.type === 'table')!;
    table.columns = [
      { key: 'name', width: 100 },
      { key: 'name', width: 100 },
    ];
    expect(validateDocTemplate('invoice', dupe).join()).toMatch(/'name' is duplicated/);
  });

  it('reports a bad page size WITHOUT burying it under every derived element error', () => {
    // With width=0 every element is "outside the page"; surfacing 20 derived
    // errors above the one real one is how a validation message becomes
    // useless.
    const tpl = { ...clone(base()), width: 0 };
    const errors = validateDocTemplate('invoice', tpl);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/template.width must be between/);
  });

  it('enforces the element ceiling', () => {
    const tpl = clone(base());
    while (tpl.elements.length <= DOC_TEMPLATE_LIMITS.maxElements) {
      tpl.elements.push({
        id: `e${tpl.elements.length}`,
        type: 'text',
        text: '.',
        x: 0,
        y: 0,
        w: 10,
        h: 10,
      });
    }
    expect(validateDocTemplate('invoice', tpl).join()).toMatch(/exceeds 120 elements/);
  });

  it('PERMITS a merely ugly layout — this validator does not have opinions about design', () => {
    const tpl = clone(base());
    // Two elements stacked directly on top of each other, at the smallest
    // legal font. Ugly, entirely legal.
    tpl.elements.push({ id: 'a', type: 'text', text: 'a', x: 48, y: 48, w: 100, h: 20, fontSize: 4 });
    tpl.elements.push({ id: 'b', type: 'text', text: 'b', x: 48, y: 48, w: 100, h: 20, fontSize: 4 });
    expect(validateDocTemplate('invoice', tpl)).toEqual([]);
  });

  it('rejects non-objects rather than throwing', () => {
    expect(validateDocTemplate('invoice', null)).toEqual(['template must be an object']);
    expect(validateDocTemplate('invoice', [])).toEqual(['template must be an object']);
  });
});
