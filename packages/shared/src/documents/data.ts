/**
 * `DocData` — the RESOLVED contents a template is filled with at print time.
 *
 * Everything here is a DISPLAY STRING, already formatted. That is a deliberate
 * boundary and the reason this type carries no `Money`/`Qty`:
 *
 *  - money and quantity are decimal strings end-to-end in this codebase
 *    (CONTRACTS §0, D-10), and the ONE place they become "Rp 12.345,00" is
 *    `frontend/lib/formatters`. A renderer that received raw `Money` would
 *    have to format it a second time, and a backend resolver that received it
 *    would have to reimplement `formatMoney` server-side — two more places for
 *    the same number to render differently on screen and on paper.
 *  - so resolvers hand back text, and the renderer only positions text. The
 *    renderer does no arithmetic at all: `totals` arrives as ordered rows, not
 *    as numbers to add up.
 *
 * The cost is that `DocData` cannot be re-totalled or re-formatted downstream,
 * which is correct — a printed document is a snapshot of what was true when it
 * was issued, not a live view.
 */

import type { BrandPalette } from './template';

/** One row of a repeating table, keyed by the column keys the kind allows. */
export type DocItemRow = Record<string, string>;

/** One line of the totals block. `strong` prints it as the emphasised grand-total rule. */
export interface DocTotalRow {
  /** Token under `docs.total.*`, or an owner-authored label already resolved. */
  key: string;
  value: string;
  strong?: boolean;
}

export interface DocData {
  /** field token → display string. Every token the kind advertises must be present. */
  fields: Record<string, string>;
  items: DocItemRow[];
  totals: DocTotalRow[];
  /**
   * Resolved image URLs. Both are short-lived presigned MinIO URLs when they
   * come from `attachments`, which is why they are passed IN rather than being
   * fetched by the renderer: a presign is an authenticated call, and the
   * renderer runs inside a print window that has no session.
   */
  logoUrl: string | null;
  backgroundUrl: string | null;
  /** Payload for `code` elements, keyed by the `codeSource` field token. */
  codes: Record<string, string>;
  /** Colours the template's `brand.*` tokens resolve against. */
  brand: BrandPalette;
}

/** An empty, renderable `DocData` — used by the designer before real data exists. */
export function emptyDocData(brand: BrandPalette): DocData {
  return {
    fields: {},
    items: [],
    totals: [],
    logoUrl: null,
    backgroundUrl: null,
    codes: {},
    brand,
  };
}
