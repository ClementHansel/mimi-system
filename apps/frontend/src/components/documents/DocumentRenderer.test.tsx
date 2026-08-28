import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import {
  DOC_ELEMENT_TYPES,
  type BrandPalette,
  type DocData,
  type DocElement,
  type DocElementType,
  type DocTemplate,
} from '@/lib/shared-types';
import { DocumentRenderer, buildDocHtml, buildDocSheetsHtml } from './DocumentRenderer';

/**
 * What these tests are actually protecting.
 *
 * The renderer is the last thing between a template and a piece of paper a
 * customer holds, and almost everything it can get wrong is INVISIBLE in
 * development: a colour token that silently falls back to black, an element
 * type that renders as nothing, a field value that closes the surrounding
 * attribute. So the assertions here are deliberately about the OUTPUT, not
 * about component structure — they read the inline styles and the DOM the
 * printer would get.
 *
 * The element-type sweep is driven by `DOC_ELEMENT_TYPES` from `@mimi/shared`
 * rather than a list written here, so adding a ninth element type to the
 * shared model fails this file until somebody teaches the renderer about it.
 * That is the runtime half of the exhaustive `switch`'s compile-time check.
 */

const BRAND: BrandPalette = {
  primary: '#a8481a',
  accent: '#c85f26',
  ink: '#1c1917',
  muted: '#78716c',
};

/** jsdom normalises inline colours to `rgb()`, so assertions compare in that space. */
function rgb(hex: string): string {
  const int = parseInt(hex.slice(1), 16);
  return `rgb(${(int >> 16) & 0xff}, ${(int >> 8) & 0xff}, ${int & 0xff})`;
}

function data(overrides: Partial<DocData> = {}): DocData {
  return {
    fields: { invoice_number: 'INV-202608-0147', party_name: 'CV Sumber Rejeki' },
    items: [{ no: '1', name: 'Ayam Geprek', qty: '2', line_total: 'Rp36.000' }],
    totals: [
      { key: 'subtotal', value: 'Rp36.000' },
      { key: 'total', value: 'Rp36.000', strong: true },
    ],
    logoUrl: 'https://minio.example/logo.png',
    backgroundUrl: null,
    codes: { invoice_number: 'INV-202608-0147' },
    brand: BRAND,
    ...overrides,
  };
}

function template(elements: DocElement[]): DocTemplate {
  return {
    kind: 'invoice',
    paper: 'A4',
    width: 794,
    height: 1123,
    backgroundAttachmentId: null,
    elements,
    version: 1,
  };
}

/** One element of every type, so the sweep below is exhaustive by construction. */
function elementOfType(type: DocElementType): DocElement {
  const base = { id: type, type, x: 10, y: 10, w: 200, h: 40, color: 'brand.ink' } as DocElement;
  switch (type) {
    case 'text':
      return { ...base, text: 'Terima kasih' };
    case 'field':
      return { ...base, field: 'invoice_number' };
    case 'table':
      return {
        ...base,
        w: 400,
        columns: [
          { key: 'no', width: 40 },
          { key: 'name', width: 240 },
          { key: 'line_total', width: 120, align: 'right' },
        ],
      };
    case 'code':
      return { ...base, codeType: 'qr', codeSource: 'invoice_number', w: 80, h: 80 };
    case 'signature':
      return { ...base, signatureRole: 'issuer', h: 100 };
    case 'box':
      return { ...base, background: 'brand.primary' };
    default:
      return base;
  }
}

describe('DocumentRenderer — element-type coverage', () => {
  it('draws something for every element type the shared model declares', () => {
    const tpl = template(DOC_ELEMENT_TYPES.map(elementOfType));
    const { container } = render(<DocumentRenderer template={tpl} data={data()} />);

    for (const type of DOC_ELEMENT_TYPES) {
      const host = container.querySelector(`[data-doc-element="${type}"]`);
      expect(host, `no host for element type ${type}`).not.toBeNull();
      // Every type must emit real markup inside its host. An unhandled type
      // would leave an empty wrapper — which on paper is a blank rectangle
      // where a signature block or a QR code should be.
      expect(host?.innerHTML.length, `element type ${type} rendered nothing`).toBeGreaterThan(0);
    }
  });

  it('renders each type as the right kind of node', () => {
    const tpl = template(DOC_ELEMENT_TYPES.map(elementOfType));
    const { container } = render(<DocumentRenderer template={tpl} data={data()} />);

    expect(container.querySelector('[data-doc-element="text"]')?.textContent).toBe('Terima kasih');
    expect(container.querySelector('[data-doc-element="field"]')?.textContent).toBe(
      'INV-202608-0147',
    );
    expect(container.querySelector('[data-doc-element="logo"] img')).not.toBeNull();
    expect(container.querySelector('[data-doc-element="table"] table')).not.toBeNull();
    // A real QR symbol, from the `qrcode` dependency — not a placeholder.
    expect(container.querySelector('[data-doc-element="code"] svg path')).not.toBeNull();
    // The signature block names who signs, resolved from i18n.
    expect(container.querySelector('[data-doc-element="signature"]')?.textContent).toContain(
      'Hormat Kami',
    );
  });

  it('stacks the totals block and emphasises the strong row', () => {
    const tpl = template([{ ...elementOfType('totals'), id: 'totals', w: 240, h: 100 }]);
    const { container } = render(<DocumentRenderer template={tpl} data={data()} />);
    const host = container.querySelector('[data-doc-element="totals"]');
    // Labels come from `doc.total.*`, values verbatim from the resolver.
    expect(host?.textContent).toContain('Subtotal');
    expect(host?.textContent).toContain('TOTAL');
    expect(host?.textContent).toContain('Rp36.000');
  });
});

describe('DocumentRenderer — brand colour resolution', () => {
  /**
   * THE test for "every printed document follows the brand". A seeded template
   * names `brand.*` tokens and never a hex (`documents/defaults.ts` rule 1), so
   * if `resolveDocColor` were bypassed anywhere in the renderer, changing the
   * palette in Admin → Merek would silently stop re-colouring documents.
   */
  it('resolves every brand token against the palette rather than hardcoding ink', () => {
    const tpl = template([
      { id: 'p', type: 'field', field: 'invoice_number', x: 0, y: 0, w: 200, h: 20, color: 'brand.primary' },
      { id: 'a', type: 'field', field: 'invoice_number', x: 0, y: 30, w: 200, h: 20, color: 'brand.accent' },
      { id: 'i', type: 'field', field: 'invoice_number', x: 0, y: 60, w: 200, h: 20, color: 'brand.ink' },
      { id: 'm', type: 'field', field: 'invoice_number', x: 0, y: 90, w: 200, h: 20, color: 'brand.muted' },
    ]);
    const { container } = render(<DocumentRenderer template={tpl} data={data()} />);

    const colorOf = (id: string) =>
      container.querySelector<HTMLElement>(`[data-doc-element="${id}"] > div`)?.style.color;

    expect(colorOf('p')).toBe(rgb(BRAND.primary));
    expect(colorOf('a')).toBe(rgb(BRAND.accent));
    expect(colorOf('i')).toBe(rgb(BRAND.ink));
    expect(colorOf('m')).toBe(rgb(BRAND.muted));
  });

  it('re-colours the same template when the palette changes, with no template edit', () => {
    const tpl = template([
      { id: 'p', type: 'field', field: 'invoice_number', x: 0, y: 0, w: 200, h: 20, color: 'brand.primary' },
    ]);
    const teal: BrandPalette = { ...BRAND, primary: '#0f766e' };
    const { container } = render(
      <DocumentRenderer template={tpl} data={data({ brand: teal })} />,
    );
    expect(
      container.querySelector<HTMLElement>('[data-doc-element="p"] > div')?.style.color,
    ).toBe(rgb('#0f766e'));
  });

  it('falls back to ink for a colour that is neither a token nor a hex', () => {
    // Owner-authored data outlives any one release; a template holding
    // `"chartreuse"` must print, not throw. `resolveDocColor` decides this and
    // the renderer must not second-guess it.
    const tpl = template([
      { id: 'x', type: 'field', field: 'invoice_number', x: 0, y: 0, w: 200, h: 20, color: 'chartreuse' },
    ]);
    const { container } = render(<DocumentRenderer template={tpl} data={data()} />);
    expect(
      container.querySelector<HTMLElement>('[data-doc-element="x"] > div')?.style.color,
    ).toBe(rgb(BRAND.ink));
  });
});

describe('DocumentRenderer — escaping', () => {
  /**
   * The renderer builds an HTML STRING and injects it with
   * `dangerouslySetInnerHTML` (see its header for why there is one renderer
   * and not two). That is only safe because every interpolated value is
   * escaped, and this is the test that keeps it true — a resolver field is
   * customer-supplied data on some documents (a party name typed into a manual
   * invoice).
   */
  it('escapes a field value that contains markup instead of executing it', () => {
    const tpl = template([
      { id: 'x', type: 'field', field: 'party_name', x: 0, y: 0, w: 400, h: 20 },
    ]);
    const evil = '<img src=x onerror="alert(1)">';
    const { container } = render(
      <DocumentRenderer template={tpl} data={data({ fields: { party_name: evil } })} />,
    );
    expect(container.querySelector('[data-doc-element="x"] img')).toBeNull();
    expect(container.querySelector('[data-doc-element="x"]')?.textContent).toBe(evil);
  });

  it('escapes an owner-typed column label', () => {
    const tpl = template([
      {
        ...elementOfType('table'),
        id: 'tbl',
        columns: [{ key: 'name', width: 400, labelText: '<b>Barang</b>' }],
      },
    ]);
    const { container } = render(<DocumentRenderer template={tpl} data={data()} />);
    expect(container.querySelector('[data-doc-element="tbl"] th b')).toBeNull();
    expect(container.querySelector('[data-doc-element="tbl"] th')?.textContent).toBe(
      '<b>Barang</b>',
    );
  });
});

describe('buildDocHtml / buildDocSheetsHtml', () => {
  it('sizes the page box to the template, with no printer margin', () => {
    // `@page` margin MUST be 0: a template-driven document already has its
    // margins baked into where the owner dragged things, so any printer margin
    // shifts and rescales the whole layout.
    const html = buildDocHtml(template([elementOfType('text')]), data(), 'INV-1');
    expect(html).toContain('@page{size:794px 1123px;margin:0}');
    expect(html).toContain('<title>INV-1</title>');
  });

  it('emits one page per sheet with a break between them', () => {
    const tpl = template([elementOfType('field')]);
    const html = buildDocSheetsHtml(tpl, [data(), data(), data()], 'SJ-1');
    expect(html.match(/class="doc-sheet"/g)).toHaveLength(3);
    // The break goes on `.doc-sheet + .doc-sheet`, so a single-sheet document
    // never emits a trailing blank page.
    expect(html).toContain('.doc-sheet+.doc-sheet{break-before:page');
  });

  it('escapes the document title it puts in <title>', () => {
    const html = buildDocHtml(template([]), data(), '</title><script>x</script>');
    expect(html).not.toContain('<script>x</script>');
  });
});

describe('DocumentRenderer — write-in rules for empty cells', () => {
  /**
   * The Surat Jalan rule, expressed generically: an empty table cell is a cell
   * somebody is expected to write in, so it prints a rule rather than nothing —
   * and never a `0`, which would assert that nothing arrived. The resolver
   * decides what is empty (`documents/catalog.ts`); this only checks the
   * renderer holds up its half.
   */
  it('draws a write-in rule for an empty cell and never substitutes a zero', () => {
    const tpl = template([
      {
        id: 'tbl',
        type: 'table',
        x: 0,
        y: 0,
        w: 400,
        h: 200,
        columns: [
          { key: 'name', width: 200 },
          { key: 'qty_received', width: 200, align: 'right' },
        ],
      },
    ]);
    const { container } = render(
      <DocumentRenderer
        template={tpl}
        data={data({ items: [{ name: 'Ayam Potong Beku 1kg', qty_received: '' }] })}
      />,
    );
    const cells = container.querySelectorAll('[data-doc-element="tbl"] tbody td');
    const received = cells[1];
    expect(received?.textContent?.trim()).not.toBe('0');
    expect(received?.querySelector('span')?.getAttribute('style')).toContain('border-bottom');
  });
});
