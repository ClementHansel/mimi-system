/**
 * Turning what an operator TYPED into the id an endpoint wants.
 *
 * Every line importer has the same problem: the CSV holds "Ayam Fillet Dada" or
 * "SKU-0142" or "Chiller", and the API takes a UUID. Doing that lookup once,
 * here, is what keeps four create forms from each inventing their own slightly
 * different matching rules — the kind of drift where waste accepts a name
 * case-insensitively and retur does not, and only one of them is "broken".
 *
 * MATCHING IS EXACT-AFTER-NORMALISATION, never fuzzy. Trimming, case-folding
 * and collapsing repeated spaces fix what a spreadsheet does to a value; a
 * nearest-match would let "Ayam Paha Atas" write off "Ayam Paha Bawah" because
 * someone's row was one word short. A miss is reported as a row error with the
 * value quoted back, which the operator can fix; a wrong silent match is a stock
 * movement against the wrong item that nobody catches until opname.
 */

/** The minimum an item-like row must carry to be matched by SKU or name. */
export interface ResolvableItem {
  id: string;
  sku: string;
  name: string;
}

/** Anything matched by name alone — storage areas, outlets, suppliers. */
export interface ResolvableNamed {
  id: string;
  name: string;
}

function key(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * A lookup that accepts either the SKU or the name.
 *
 * SKU WINS on a collision, because it is the identifier the warehouse prints on
 * shelf labels and the one an exported file leads with. An AMBIGUOUS name — two
 * active items really called the same thing — resolves to `null` rather than to
 * whichever happened to be loaded first: guessing there is exactly the silent
 * wrong-item write this module refuses to make, and the operator can
 * disambiguate by pasting the SKU instead.
 */
export interface ItemIndex {
  bySku: Map<string, ResolvableItem>;
  byName: Map<string, ResolvableItem | 'ambiguous'>;
}

export function buildItemIndex(items: readonly ResolvableItem[]): ItemIndex {
  const bySku = new Map<string, ResolvableItem>();
  const byName = new Map<string, ResolvableItem | 'ambiguous'>();
  for (const item of items) {
    if (item.sku) bySku.set(key(item.sku), item);
    const nameKey = key(item.name);
    byName.set(nameKey, byName.has(nameKey) ? 'ambiguous' : item);
  }
  return { bySku, byName };
}

/**
 * Resolve one cell against the index. Pass BOTH cells when the template has a
 * SKU column and a name column — an exported file has both, and honouring the
 * SKU lets an operator rename an item in their sheet without breaking the
 * import.
 */
export function resolveItem(
  index: ItemIndex,
  cells: { sku?: string; name?: string },
): ResolvableItem | null {
  const sku = cells.sku?.trim();
  if (sku) {
    const bySku = index.bySku.get(key(sku));
    if (bySku) return bySku;
    // A SKU column that was filled in but matched nothing is a miss, not a
    // reason to fall through to the name — the two columns disagreeing is
    // precisely when a fallback would pick the wrong item.
    return null;
  }
  const name = cells.name?.trim();
  if (!name) return null;
  const byName = index.byName.get(key(name));
  return byName === undefined || byName === 'ambiguous' ? null : byName;
}

/** Name-only lookup, same normalisation, same refusal to guess on a duplicate. */
export function buildNameIndex(
  rows: readonly ResolvableNamed[],
): Map<string, ResolvableNamed | 'ambiguous'> {
  const index = new Map<string, ResolvableNamed | 'ambiguous'>();
  for (const row of rows) {
    const k = key(row.name);
    index.set(k, index.has(k) ? 'ambiguous' : row);
  }
  return index;
}

export function resolveNamed(
  index: Map<string, ResolvableNamed | 'ambiguous'>,
  text: string,
): ResolvableNamed | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const hit = index.get(key(trimmed));
  return hit === undefined || hit === 'ambiguous' ? null : hit;
}

/**
 * Match a cell against a fixed set of enum values, accepting either the wire
 * value (`expired`) or the Indonesian label the export writes (`Kedaluwarsa`).
 *
 * A round trip is the whole point of these importers, and an export that shows
 * an operator "Kedaluwarsa" cannot then demand they type `expired` back. The
 * caller supplies the label map because the labels come from i18n, which this
 * module deliberately does not import.
 */
export function resolveEnum<T extends string>(
  text: string,
  values: readonly T[],
  labelOf: (value: T) => string,
): T | null {
  const k = key(text);
  if (!k) return null;
  return values.find((value) => key(value) === k || key(labelOf(value)) === k) ?? null;
}
