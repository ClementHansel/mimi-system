import type { PermissionKeyOrKeys } from '@/lib/permissions';

/**
 * F-DOCS content model. Manuals are authored as plain data (this file's
 * types), never as hardcoded JSX — `components/docs/DocBody.tsx` is the one
 * place that turns a `DocSection[]` into markup, so editing a manual never
 * touches a component and adding a manual never touches the renderer.
 *
 * Inline text supports a tiny, deliberately non-extensible markup: `**bold**`
 * and `` `code` ``. This is NOT a markdown parser — it's two regex passes in
 * `DocBody` — so there is no dependency to add and no injection surface
 * (content is authored by us, not user input, but keeping the grammar this
 * small means a stray `_`/`#`/`[]` in real button-label text, e.g. "Ubah
 * jumlah [opsional]", is never misinterpreted as syntax).
 */

/** A single content block inside a section. */
export type DocBlock =
  | { type: 'p'; text: string }
  | { type: 'list'; ordered?: boolean; items: string[] }
  | { type: 'steps'; items: string[] }
  | { type: 'callout'; kind: 'rule' | 'note' | 'warning'; text: string }
  | { type: 'table'; headers: string[]; rows: string[][] };

export interface DocSection {
  /** Anchor id — kebab-case, unique within the manual. */
  id: string;
  heading: string;
  level?: 2 | 3;
  blocks: DocBlock[];
}

export interface DocManual {
  slug: string;
  title: string;
  /** Short role label shown as the card badge, e.g. "Kasir". */
  audience: string;
  /** Gates visibility exactly like `lib/nav.ts` gates its surface — same vocabulary, same ANY-of semantics. */
  permission: PermissionKeyOrKeys;
  blurb: string;
  /** Rough reading time in minutes, shown on the card and the reader header. */
  minutes: number;
  /** Display order on the index. */
  order: number;
  sections: DocSection[];
}
