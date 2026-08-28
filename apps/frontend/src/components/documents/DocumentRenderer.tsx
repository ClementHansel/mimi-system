'use client';

import { useMemo } from 'react';
import { resolveDocColor, type BrandPalette, type DocAlign, type DocData, type DocElement, type DocTemplate } from '@/lib/shared-types';
import { translate } from '@/lib/i18n';
import { escapeXmlText, renderCodeSvg } from './codes';

/**
 * THE renderer. One `DocTemplate` + one `DocData` → one sheet of paper, drawn
 * identically on the designer canvas, in the print-route preview, and in the
 * print window.
 *
 * ── ONE IMPLEMENTATION, AS AN HTML STRING ────────────────────────────────────
 * The reference implementation this was adopted from (`aire`'s
 * `DocumentRenderer.tsx`) has TWO renderers in one file: a React
 * `DocumentPreview` and a `buildDocHtml` string builder, each with its own
 * copy of every element's geometry and styling. They had already begun to
 * diverge — `buildDocHtml` drops a `logo`/`code` element entirely when the
 * image is missing while the preview draws a `[logo]` placeholder, and the
 * table's row-border colour is hardcoded differently in the two.
 *
 * Here there is exactly one: `renderDocumentBodyHtml`, which returns markup.
 * The React component below wraps that markup, and `buildDocHtml` wraps the
 * same markup in a print document. "What you dragged is what prints" is then
 * true by construction rather than by two functions being kept in step by
 * hand — the same argument `documents/template.ts` makes for declaring the
 * types once in `@mimi/shared`.
 *
 * The cost of that choice is `dangerouslySetInnerHTML` on the preview. It is
 * paid for by every interpolated string passing through `escapeXmlText`
 * (`codes.ts`) — element text, field values, table cells, totals, the owner's
 * column labels, image URLs. Nothing reaches the markup un-escaped, and the
 * only unescaped fragments are numbers and colours this module computes.
 *
 * ── SCALE IS A TRANSFORM, NOT ARITHMETIC ─────────────────────────────────────
 * `aire` multiplied every x/y/w/h/fontSize by `scale`. That is a rounding
 * error per element per axis, so a preview at 60% does not agree with the
 * printed sheet about where a table's right edge lands. Here the body is
 * always drawn at 1:1 in template pixels and the CONTAINER is
 * `transform: scale()`d — geometrically exact at any zoom, and it is what lets
 * the designer convert a pointer delta back to template pixels by a single
 * division.
 *
 * ── COLOUR ───────────────────────────────────────────────────────────────────
 * Every colour in this file goes through `resolveDocColor(el.color,
 * data.brand)`. There is no hardcoded ink anywhere, and that is the whole
 * mechanism behind "every printed document follows the brand": the seeded
 * templates name `brand.*` tokens (`documents/defaults.ts`), so changing the
 * palette in Admin → Merek re-colours every untouched document at once. The
 * two literal colours that DO appear are paper white (`#ffffff`, the sheet
 * itself and a QR's quiet zone — not ink) and the designer-only placeholder
 * grey, which never reaches paper.
 */

/** The `t()` shape this module needs — matches `useI18n()`'s. */
export type Translate = (key: string, params?: Record<string, string | number>) => string;

/**
 * `translate` returns the KEY itself when a key is missing (see
 * `lib/i18n/index.tsx`). On screen that is a loud, useful bug signal; on a
 * customer's invoice it is `doc.column.line_total` printed where "Jumlah"
 * should be. So every lookup in this file goes through here and falls back to
 * something a human can read.
 */
function tOr(t: Translate, key: string, fallback: string): string {
  const value = t(key);
  return value === key ? fallback : value;
}

function justifyFor(align: DocAlign | undefined): string {
  return align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start';
}

function textAlignFor(align: DocAlign | undefined): string {
  return align === 'center' ? 'center' : align === 'right' ? 'right' : 'left';
}

/**
 * Relative luminance of an `#rrggbb`, sRGB-weighted. Used only to pick a
 * table header's INK against the fill the owner chose.
 *
 * Why derive it instead of honouring `el.color` for the header text: the
 * seeded invoice and Surat Jalan templates set the header fill to
 * `brand.primary` (a dark terracotta by default) and the element's `color` to
 * `brand.ink` (near-black) — a combination that is legible in the designer's
 * property list and unreadable on paper. Honouring both literally would print
 * a black-on-dark-brown header row. Deriving the header ink means an owner can
 * pick ANY fill, including a brand colour we have never seen, and the header
 * stays readable; `el.color` still governs the body rows, which is where it
 * actually reads as the owner's choice.
 */
function isDarkColor(hex: string): boolean {
  const match = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!match?.[1]) return false;
  const int = parseInt(match[1], 16);
  const r = (int >> 16) & 0xff;
  const g = (int >> 8) & 0xff;
  const b = int & 0xff;
  // Rec. 709 luma, 0–255. 140 sits just above mid-grey, which is where
  // white-on-colour stops being the more readable of the two.
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 140;
}

/** Serialises a CSS declaration map. Values are numbers/colours we computed, never user text. */
function css(declarations: Record<string, string | number | undefined>): string {
  return Object.entries(declarations)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}:${typeof v === 'number' ? `${v}px` : v}`)
    .join(';');
}

/** The absolute box every element occupies, in template pixels. */
function boxCss(el: DocElement): Record<string, string | number> {
  return {
    position: 'absolute',
    left: el.x,
    top: el.y,
    width: el.w,
    height: el.h,
    overflow: 'hidden',
  };
}

export interface RenderOptions {
  /**
   * Designer-only. Draws a dashed outline and a type label where an element
   * has nothing to show (no logo uploaded, an unencodable code, an empty
   * box), so a placed-but-empty element is still selectable and visible on the
   * canvas. NEVER true on a print path — an outline is not part of the
   * document.
   */
  placeholders?: boolean;
  t?: Translate;
}

const PLACEHOLDER_STROKE = '#9ca3af';

function placeholderHtml(label: string, options: RenderOptions): string {
  if (!options.placeholders) return '';
  return `<div style="${css({
    position: 'absolute',
    inset: '0',
    display: 'flex',
    'align-items': 'center',
    'justify-content': 'center',
    border: `1px dashed ${PLACEHOLDER_STROKE}`,
    color: PLACEHOLDER_STROKE,
    'font-size': 10,
  })}">${escapeXmlText(label)}</div>`;
}

// ── Element renderers ────────────────────────────────────────────────────────

function renderTextish(el: DocElement, data: DocData, ink: string): string {
  const value = el.type === 'text' ? (el.text ?? '') : (data.fields[el.field ?? ''] ?? '');
  const wrap = el.wrap === true;
  const style = css({
    ...boxCss(el),
    display: 'flex',
    // A wrapping block reads from its top edge; a single line is optically
    // centred in the box the owner drew.
    'align-items': wrap ? 'flex-start' : 'center',
    'justify-content': justifyFor(el.align),
    'font-size': el.fontSize ?? 12,
    'line-height': wrap ? '1.3' : '1.15',
    color: ink,
    'font-weight': el.bold ? 700 : 400,
    'text-align': textAlignFor(el.align),
    'white-space': wrap ? 'normal' : 'nowrap',
    'word-break': wrap ? 'break-word' : 'normal',
  });
  return `<div style="${style}"><span style="max-width:100%">${escapeXmlText(value)}</span></div>`;
}

function renderLogo(el: DocElement, data: DocData, options: RenderOptions, t: Translate): string {
  const style = css({
    ...boxCss(el),
    display: 'flex',
    'align-items': 'center',
    'justify-content': justifyFor(el.align),
  });
  if (!data.logoUrl) {
    return `<div style="${style}">${placeholderHtml(tOr(t, 'doc.designer.element.logo', 'logo'), options)}</div>`;
  }
  // A plain <img>, never `next/image`: the src is a short-lived presigned
  // MinIO URL (see `DocData.logoUrl`), and this markup also has to work
  // verbatim inside a detached print window with no Next runtime at all.
  return (
    `<div style="${style}">` +
    `<img src="${escapeXmlText(data.logoUrl)}" alt="" style="max-width:100%;max-height:100%;object-fit:contain"/>` +
    `</div>`
  );
}

function renderDivider(el: DocElement, ink: string): string {
  // A divider whose box is taller than it is wide is a VERTICAL rule — the
  // element carries no orientation flag, and inferring it from the box the
  // owner drew is both what they meant and one less property to explain.
  const vertical = el.h > el.w;
  const style = css({
    ...boxCss(el),
    [vertical ? 'border-left' : 'border-top']: `1px solid ${ink}`,
  });
  return `<div style="${style}"></div>`;
}

function renderBox(el: DocElement, brand: BrandPalette, options: RenderOptions, t: Translate): string {
  const fill = el.background ? resolveDocColor(el.background, brand) : undefined;
  // A box with a `color` but no `background` is an outline — that is the only
  // sensible reading of the two properties, and it is how an owner draws a
  // framed notes area without burning toner on a fill.
  const stroke = el.color ? resolveDocColor(el.color, brand) : undefined;
  const style = css({
    ...boxCss(el),
    background: fill,
    border: stroke ? `1px solid ${stroke}` : undefined,
  });
  const empty = !fill && !stroke;
  return `<div style="${style}">${empty ? placeholderHtml(tOr(t, 'doc.designer.element.box', 'box'), options) : ''}</div>`;
}

function renderTable(el: DocElement, data: DocData, brand: BrandPalette, ink: string, t: Translate): string {
  const columns = el.columns ?? [];
  if (columns.length === 0) return `<div style="${css(boxCss(el))}"></div>`;

  const fontSize = el.fontSize ?? 10;
  const headerFill = el.background ? resolveDocColor(el.background, brand) : undefined;
  const headerInk = headerFill ? (isDarkColor(headerFill) ? '#ffffff' : ink) : ink;
  // Row rules are drawn in the MUTED brand colour rather than in `el.color`:
  // the element's colour is the text's, and a table whose grid printed as
  // heavily as its numbers reads as a spreadsheet, not as an invoice.
  const rule = brand.muted;

  const colgroup = columns.map((c) => `<col style="width:${c.width}px"/>`).join('');

  const head = columns
    .map((c) => {
      const label = c.labelText?.trim() || tOr(t, `doc.column.${c.key}`, c.key);
      return (
        `<th style="${css({
          'text-align': textAlignFor(c.align),
          padding: '3px 4px',
          'font-weight': 700,
          color: headerInk,
          background: headerFill,
          'border-bottom': `1px solid ${headerFill ?? ink}`,
          'white-space': 'nowrap',
          overflow: 'hidden',
          'text-overflow': 'ellipsis',
        })}">${escapeXmlText(label)}</th>`
      );
    })
    .join('');

  const body = data.items
    .map((row) => {
      const cells = columns
        .map((c) => {
          const value = row[c.key] ?? '';
          // AN EMPTY CELL IS A CELL SOMEBODY IS EXPECTED TO WRITE IN, so it
          // prints a write-in rule instead of nothing. This is a deliberately
          // GENERIC rule, not a Surat-Jalan-specific one: the resolver decides
          // what is empty (`qty_received` on an un-received drop returns `''`
          // — never `'0'`, which would assert nothing arrived; see
          // `documents/catalog.ts`), and the renderer only makes "empty"
          // writable. Putting the kind's knowledge here instead would put the
          // same decision in two places.
          const content =
            value === ''
              ? `<span style="display:inline-block;width:80%;border-bottom:1px solid ${rule}">&nbsp;</span>`
              : escapeXmlText(value);
          return (
            `<td style="${css({
              'text-align': textAlignFor(c.align),
              padding: '3px 4px',
              'border-bottom': `1px solid ${rule}`,
              'white-space': 'nowrap',
              overflow: 'hidden',
              'text-overflow': 'ellipsis',
            })}">${content}</td>`
          );
        })
        .join('');
      return `<tr>${cells}</tr>`;
    })
    .join('');

  // The table is CLIPPED to the box the owner drew — a document laid out by
  // dragging has no reflow model, so a 60-line invoice cannot push a totals
  // block down a page that has no page 2. That is a real limitation of the
  // designer model (it is also `aire`'s), and the honest mitigation is that
  // the seeded templates give the items table the full height of the page
  // between the header block and the totals.
  const style = css({
    ...boxCss(el),
    'font-size': fontSize,
    color: ink,
  });
  return (
    `<div style="${style}">` +
    `<table style="width:100%;border-collapse:collapse;table-layout:fixed">` +
    `<colgroup>${colgroup}</colgroup>` +
    `<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`
  );
}

function renderTotals(el: DocElement, data: DocData, ink: string, t: Translate): string {
  const rows = data.totals
    .map((row) => {
      // `DocTotalRow.key` is "a token under `docs.total.*`, or an
      // owner-authored label already resolved" (see `documents/data.ts`), so a
      // key that does not resolve is printed as-is rather than swallowed.
      const label = tOr(t, `doc.total.${row.key}`, row.key);
      return (
        `<div style="${css({
          display: 'flex',
          'justify-content': 'space-between',
          gap: '8px',
          'font-weight': row.strong ? 700 : 400,
          'border-top': row.strong ? `1px solid ${ink}` : undefined,
          'padding-top': row.strong ? 3 : 0,
          'margin-top': row.strong ? 2 : 0,
        })}"><span>${escapeXmlText(label)}</span><span>${escapeXmlText(row.value)}</span></div>`
      );
    })
    .join('');

  const style = css({
    ...boxCss(el),
    'font-size': el.fontSize ?? 12,
    color: ink,
    display: 'flex',
    'flex-direction': 'column',
    gap: '2px',
  });
  return `<div style="${style}">${rows}</div>`;
}

function renderCode(el: DocElement, data: DocData, ink: string, options: RenderOptions, t: Translate): string {
  const source = el.codeSource ?? '';
  const payload = data.codes[source] ?? data.fields[source] ?? '';
  const svg = renderCodeSvg(el.codeType, payload, el.w, el.h, ink);
  const style = css({
    ...boxCss(el),
    display: 'flex',
    'align-items': 'center',
    'justify-content': justifyFor(el.align ?? 'center'),
  });
  if (!svg) {
    return `<div style="${style}">${placeholderHtml(tOr(t, 'doc.designer.element.code', 'code'), options)}</div>`;
  }
  return `<div style="${style}">${svg}</div>`;
}

function renderSignature(el: DocElement, ink: string, t: Translate): string {
  const role = el.signatureRole ?? '';
  const label = tOr(t, `doc.signature.${role}`, role);
  const fontSize = el.fontSize ?? 10;
  const style = css({
    ...boxCss(el),
    'font-size': fontSize,
    color: ink,
    display: 'flex',
    'flex-direction': 'column',
    'justify-content': 'space-between',
  });
  // Role on top, signing space, rule, then a name line. This is the shape the
  // hand-coded Surat Jalan already printed and that outlets already sign:
  // the role has to be readable BEFORE the pen touches the paper, and the
  // bracketed name line is what makes an illegible signature attributable
  // weeks later in a dispute.
  return (
    `<div style="${style}">` +
    `<div>${escapeXmlText(label)}</div>` +
    `<div>` +
    `<div style="border-top:1px solid ${ink}"></div>` +
    `<div style="${css({ 'padding-top': 2, 'font-size': Math.max(7, fontSize - 1) })}">(&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;)</div>` +
    `</div></div>`
  );
}

/**
 * One element → markup. The switch is EXHAUSTIVE over `DocElementType`: the
 * `never` in the default branch is what turns "somebody added an element type
 * to `@mimi/shared` and forgot the renderer" into a compile error instead of a
 * blank rectangle on a customer's invoice — which is exactly why
 * `template.ts` declares the union as a closed one.
 */
export function renderElementHtml(
  el: DocElement,
  data: DocData,
  options: RenderOptions = {},
): string {
  const t = options.t ?? translate;
  const ink = resolveDocColor(el.color, data.brand);

  switch (el.type) {
    case 'text':
    case 'field':
      return renderTextish(el, data, ink);
    case 'logo':
      return renderLogo(el, data, options, t);
    case 'divider':
      return renderDivider(el, ink);
    case 'box':
      return renderBox(el, data.brand, options, t);
    case 'table':
      return renderTable(el, data, data.brand, ink, t);
    case 'totals':
      return renderTotals(el, data, ink, t);
    case 'code':
      return renderCode(el, data, ink, options, t);
    case 'signature':
      return renderSignature(el, ink, t);
    default: {
      const exhaustive: never = el.type;
      return exhaustive;
    }
  }
}

/**
 * The whole sheet's inner markup, at 1:1 template pixels: the background
 * image, then every element in template order (later elements paint over
 * earlier ones — the designer's "bring forward" is an array reorder, so
 * z-index never has to be stored on an element).
 */
export function renderDocumentBodyHtml(
  template: DocTemplate,
  data: DocData,
  options: RenderOptions = {},
): string {
  const background = data.backgroundUrl
    ? `<img src="${escapeXmlText(data.backgroundUrl)}" alt="" style="position:absolute;left:0;top:0;width:100%;height:100%;object-fit:cover"/>`
    : '';
  const elements = template.elements
    .map(
      (el) =>
        `<div data-doc-element="${escapeXmlText(el.id)}" data-doc-element-type="${el.type}" style="position:absolute;left:0;top:0">${renderElementHtml(el, data, options)}</div>`,
    )
    .join('');
  return background + elements;
}

/** The page box itself — white paper at the template's exact pixel size. */
function sheetHtml(template: DocTemplate, data: DocData, options: RenderOptions = {}): string {
  const style = css({
    position: 'relative',
    width: template.width,
    height: template.height,
    background: '#ffffff',
    overflow: 'hidden',
  });
  return `<div class="doc-sheet" style="${style}">${renderDocumentBodyHtml(template, data, options)}</div>`;
}

// ── React surface ────────────────────────────────────────────────────────────

/**
 * The on-screen renderer. `scale` shrinks the sheet to fit its container
 * WITHOUT touching a single template coordinate (see this file's header) — the
 * outer div reserves the scaled footprint so surrounding layout is correct,
 * and the inner div is the true-size sheet with a `transform`.
 */
export function DocumentRenderer({
  template,
  data,
  scale = 1,
  placeholders = false,
  className,
}: {
  template: DocTemplate;
  data: DocData;
  scale?: number;
  placeholders?: boolean;
  className?: string;
}) {
  // The markup is rebuilt only when something it depends on actually changes.
  // The designer re-renders this on every pointer move during a drag, and a
  // full A4 template is ~40 elements plus a QR path — cheap, but not free.
  const html = useMemo(
    () => renderDocumentBodyHtml(template, data, { placeholders }),
    [template, data, placeholders],
  );

  return (
    <div
      className={className}
      style={{ width: template.width * scale, height: template.height * scale }}
    >
      <div
        data-doc-sheet
        style={{
          position: 'relative',
          width: template.width,
          height: template.height,
          background: '#ffffff',
          overflow: 'hidden',
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
        }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

/**
 * A `<style>` element a print ROUTE renders to make the browser's page box
 * match the template exactly.
 *
 * `app/print/print.css` declares `@page { size: A4; margin: 14mm 12mm }` for
 * the hand-laid-out payslip and the old Surat Jalan, both of which are flowed
 * HTML that wants a printer margin. A template-driven document is the
 * opposite: it is absolutely positioned in page pixels, and its margins are
 * already baked into where the owner dragged things. Anything but
 * `margin: 0` here shifts the whole layout and scales it down to fit.
 *
 * Emitted per-route rather than added to `print.css` because the size is
 * DATA — 794×1123 for A4, 283×680 for an 80mm roll, 324×204 for a voucher
 * card — and a stylesheet cannot read the template.
 */
export function DocPageStyle({ width, height }: { width: number; height: number }) {
  return (
    <style>{`@page { size: ${width}px ${height}px; margin: 0 }
.print-sheet { padding: 0 !important; max-width: none !important; margin: 0 auto !important; background: transparent !important; box-shadow: none !important; }
@media print { .doc-sheet { box-shadow: none !important; } }`}</style>
  );
}

// ── Print-window builders ────────────────────────────────────────────────────

const PRINT_DOCUMENT_FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, Helvetica, sans-serif`;

function printShell(title: string, width: number, height: number, body: string): string {
  return (
    `<!doctype html><html lang="id"><head><meta charset="utf-8"/>` +
    `<title>${escapeXmlText(title)}</title>` +
    `<style>` +
    `@page{size:${width}px ${height}px;margin:0}` +
    `html,body{margin:0;padding:0;background:#ffffff;font-family:${PRINT_DOCUMENT_FONT}}` +
    `.doc-sheet{box-sizing:border-box}` +
    // Each sheet but the last starts a new page. `break-after` on the sheet
    // itself (rather than `break-before` on the next) means a single-sheet
    // document never emits a trailing blank page.
    `.doc-sheet+.doc-sheet{break-before:page;page-break-before:always}` +
    `</style></head><body>${body}</body></html>`
  );
}

/**
 * A standalone, self-contained print document for ONE sheet — everything a
 * detached `window.open()` needs, with no stylesheet, no script and no Next
 * runtime to load.
 *
 * `document.title` becomes the browser's suggested print-to-PDF filename, so
 * callers pass the document NUMBER, sanitised of path separators (the same
 * thing `PrintFrame` already does).
 */
export function buildDocHtml(
  template: DocTemplate,
  data: DocData,
  title = 'Dokumen',
  t: Translate = translate,
): string {
  return printShell(title, template.width, template.height, sheetHtml(template, data, { t }));
}

/**
 * The multi-sheet variant, for a `DocCopySet`: a Surat Jalan's drops × copy
 * holders, or a batch of voucher cards. Each element of `sheets` is a complete
 * `DocData` and prints as its own page.
 *
 * Separate from `buildDocHtml` rather than an overload taking `DocData |
 * DocData[]` because the two have genuinely different contracts: this one
 * guarantees a page break between sheets, and a caller that passes one sheet
 * to it still gets exactly one page.
 */
export function buildDocSheetsHtml(
  template: DocTemplate,
  sheets: readonly DocData[],
  title = 'Dokumen',
  t: Translate = translate,
): string {
  const body = sheets.map((data) => sheetHtml(template, data, { t })).join('');
  return printShell(title, template.width, template.height, body);
}

/**
 * Opens a print window for finished document HTML.
 *
 * Deliberately NOT auto-`window.print()` from inside the generated document
 * (which is what `aire` does with `window.onload=()=>window.print()`): the
 * same reason `PrintFrame` records for not auto-printing. A popup that opens a
 * modal print dialog the user did not ask for is hostile, and an image that
 * has not decoded yet prints as a gap. Returns `false` when the popup was
 * blocked so the caller can say so instead of appearing to do nothing.
 */
export function openPrintWindow(html: string): boolean {
  if (typeof window === 'undefined') return false;
  const win = window.open('', '_blank');
  if (!win) return false;
  win.document.open();
  win.document.write(html);
  win.document.close();
  return true;
}
