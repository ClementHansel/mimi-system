import type { Money } from '@/lib/shared-types';

/** A PO line as the create form holds it while being edited. */
export interface PricedLine {
  itemId: string;
  unitPrice: Money | null;
}

/**
 * Fills in the price the chosen supplier publishes for each item, and NEVER
 * overwrites one already entered.
 *
 * Reported from production 2026-09-03: "harga satuan dari supplier yg dipilih
 * tidak tampil ketika buat PO". The create form only ever received a price from
 * the purchase request's ESTIMATE, and an outlet request converts to a PR with
 * no estimate at all (Rp0) — so on the flow the outlets actually use, every
 * price was retyped by hand while the agreed figure sat in `supplier_items`.
 *
 * A typed figure is a decision and a price list is a starting point, so this
 * only ever fills blanks. That is also what makes it safe to re-run whenever
 * the list or the lines change.
 */
export function fillLinePrices<T extends PricedLine>(
  lines: readonly T[],
  priceByItem: Readonly<Record<string, Money>>,
): T[] | null {
  let changed = false;
  const next = lines.map((line) => {
    if (!line.itemId || line.unitPrice) return line;
    const price = priceByItem[line.itemId];
    if (!price) return line;
    changed = true;
    return { ...line, unitPrice: price };
  });
  // Null means "nothing to do" so a caller can skip the state update entirely
  // rather than handing React a new array on every render.
  return changed ? next : null;
}
