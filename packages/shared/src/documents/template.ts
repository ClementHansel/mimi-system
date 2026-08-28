/**
 * The document-template model — the data behind the invoice / receipt /
 * voucher / Surat Jalan designers.
 *
 * WHY THIS LIVES IN `@mimi/shared` AND NOT IN THE BACKEND MODULE
 * -------------------------------------------------------------
 * A template is authored in the browser, stored by the backend, and rendered
 * in THREE places that must agree pixel-for-pixel or the feature is a lie:
 * the designer canvas, the on-screen preview, and the printed sheet. The
 * reference implementation this was adopted from (project `aire`) kept one
 * copy of these interfaces in its Nest service and a second, hand-synced copy
 * in its React renderer; the two had already drifted (`reportSections`
 * existed on one side only). Declaring the shape once here — the same
 * discipline `recipe/explosion.ts` records for the explosion formula, which
 * also drifted once across two modules — makes that class of drift a compile
 * error instead of a rendering bug nobody sees until a customer holds the
 * paper.
 *
 * NO USER-FACING STRINGS. Elements carry field TOKENS (`invoice_number`,
 * `outlet_name`), never labels. The label the designer shows next to a token,
 * and the header printed above a table column, resolve from i18n on the
 * frontend (`docs.field.*` / `docs.column.*`) — this package holds no Bahasa
 * Indonesia text (BUILD-PLAN §6.9). The one exception is a `text` element's
 * `text` and a column's `labelText`, which are copy the OWNER typed into
 * their own document: that is data, not product copy.
 *
 * GEOMETRY IS IN CSS PIXELS AT 96dpi, top-left origin, for every kind
 * including thermal. `@page { size: <w>px <h>px }` and the designer canvas
 * then share one coordinate system, so "what you dragged" is "what prints"
 * with no unit conversion anywhere. A4 is therefore 794×1123, not 595×842
 * (A4 in POINTS — the unit `frontend/lib/export/pdf.ts` uses for its own
 * hand-rolled tabular PDF, and deliberately NOT the unit here).
 */

/** The four business documents an owner can lay out. */
export type DocKind = 'invoice' | 'receipt' | 'voucher' | 'surat_jalan';

export const DOC_KINDS: readonly DocKind[] = [
  'invoice',
  'receipt',
  'voucher',
  'surat_jalan',
] as const;

export function isDocKind(value: unknown): value is DocKind {
  return typeof value === 'string' && (DOC_KINDS as readonly string[]).includes(value);
}

/**
 * Physical stock a template targets. Width/height stay stored explicitly on
 * the template (an owner may nudge a voucher card); `paper` records the
 * INTENT, which is what the print CSS needs to choose a `@page` size and what
 * tells the POS whether a receipt fits a 58mm thermal head.
 */
export type DocPaper = 'A4' | 'A5' | 'thermal80' | 'thermal58' | 'card';

export const DOC_PAPERS: readonly DocPaper[] = ['A4', 'A5', 'thermal80', 'thermal58', 'card'];

export const DOC_PAPER_SIZES: Readonly<Record<DocPaper, { width: number; height: number }>> = {
  // 210×297mm and 148×210mm at 96dpi.
  A4: { width: 794, height: 1123 },
  A5: { width: 559, height: 794 },
  // 80mm/58mm rolls minus the printer's own dead margin, at 96dpi. Height is
  // the DESIGN height — a receipt roll is continuous, so this is the canvas
  // the owner lays out on and the height the sheet grows from, not a page
  // break.
  thermal80: { width: 283, height: 680 },
  thermal58: { width: 208, height: 620 },
  // A voucher the size of a bank card, printed 8-up on A4 by the voucher
  // sheet route.
  card: { width: 324, height: 204 },
};

export type DocAlign = 'left' | 'center' | 'right';

/**
 * Every element type the renderer knows how to draw. Adding one here without
 * handling it in the renderer's exhaustive switch is a compile error, which
 * is the point.
 */
export type DocElementType =
  | 'text'
  | 'field'
  | 'logo'
  | 'table'
  | 'totals'
  | 'code'
  | 'divider'
  | 'box'
  | 'signature';

export const DOC_ELEMENT_TYPES: readonly DocElementType[] = [
  'text',
  'field',
  'logo',
  'table',
  'totals',
  'code',
  'divider',
  'box',
  'signature',
];

/**
 * A colour on a template is EITHER a literal `#rrggbb` OR one of these brand
 * tokens. This is the whole mechanism behind "every PDF uses the brand
 * colour": a seeded default template references `brand.primary`, so changing
 * the brand colour in Admin → Merek re-colours every document at once, while
 * an owner who deliberately picks a literal colour for one heading keeps it.
 * See `resolveDocColor`.
 */
export type BrandColorToken = 'brand.primary' | 'brand.accent' | 'brand.ink' | 'brand.muted';

export const BRAND_COLOR_TOKENS: readonly BrandColorToken[] = [
  'brand.primary',
  'brand.accent',
  'brand.ink',
  'brand.muted',
] as const;

/** `#rrggbb` or a `BrandColorToken`. */
export type DocColor = string;

export interface BrandPalette {
  primary: string;
  accent: string;
  ink: string;
  muted: string;
}

/**
 * Resolve a template colour against the brand palette. An unrecognised value
 * falls back to `ink` rather than throwing: a template is owner-authored data
 * that outlives any one release, and a document that prints in the wrong
 * colour is recoverable while one that fails to print is not.
 */
export function resolveDocColor(color: DocColor | undefined, brand: BrandPalette): string {
  if (!color) return brand.ink;
  switch (color) {
    case 'brand.primary':
      return brand.primary;
    case 'brand.accent':
      return brand.accent;
    case 'brand.ink':
      return brand.ink;
    case 'brand.muted':
      return brand.muted;
    default:
      return HEX_COLOR.test(color) ? color : brand.ink;
  }
}

/** One column of a repeating line-items table. `key` indexes each `DocData.items[n]`. */
export interface DocTableColumn {
  key: string;
  /** Owner-typed override for the printed header. Absent/empty = the i18n label for `key`. */
  labelText?: string;
  /** Column width in the same px units as the element. */
  width: number;
  align?: DocAlign;
}

/** A single positioned element on the document canvas. */
export interface DocElement {
  id: string;
  type: DocElementType;
  /** Token from the kind's field catalog — `type: 'field'`. */
  field?: string;
  /** Owner-typed literal — `type: 'text'`. */
  text?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize?: number;
  color?: DocColor;
  /** Fill for `box`, and the header-row fill for `table`. */
  background?: DocColor;
  align?: DocAlign;
  bold?: boolean;
  /** `true` lets a long value wrap inside `h` instead of being clipped to one line. */
  wrap?: boolean;
  /** `type: 'table'`. */
  columns?: DocTableColumn[];
  /** `type: 'code'`. */
  codeType?: 'qr' | 'barcode';
  /** Which field token supplies the code's payload. */
  codeSource?: string;
  /** `type: 'signature'` — the token naming who signs, printed under the rule. */
  signatureRole?: string;
}

/**
 * A complete layout for one document kind.
 *
 * `backgroundAttachmentId` points at `attachments` (MinIO), never at inline
 * bytes: a base64 letterhead would be re-sent on every template read, to
 * every POS tablet, forever. The frontend resolves it through the existing
 * `GET /api/attachments/:id/url` presign path like every other image here.
 */
export interface DocTemplate {
  kind: DocKind;
  paper: DocPaper;
  width: number;
  height: number;
  backgroundAttachmentId: string | null;
  elements: DocElement[];
  /** Schema version of the layout itself — bumped only by a breaking element change. */
  version: number;
}

export const DOC_TEMPLATE_VERSION = 1;

/**
 * Hard caps, enforced server-side by `validateDocTemplate`. A template is
 * owner-authored JSON that reaches every POS tablet in the network and is
 * re-rendered on every print — it needs a ceiling, for the same reason
 * `settings-value-validator.ts` type-checks a setting's value rather than
 * trusting the client that produced it.
 */
export const DOC_TEMPLATE_LIMITS = {
  maxElements: 120,
  maxColumns: 8,
  minDimension: 100,
  maxDimension: 4000,
  maxTextLength: 500,
  maxFontSize: 96,
  minFontSize: 4,
} as const;

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export function isValidDocColor(value: unknown): value is DocColor {
  return (
    typeof value === 'string' &&
    (HEX_COLOR.test(value) || (BRAND_COLOR_TOKENS as readonly string[]).includes(value))
  );
}
