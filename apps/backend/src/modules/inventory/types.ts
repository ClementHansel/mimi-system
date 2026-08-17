/**
 * M07 `inventory` — response shapes CONTRACTS.md §4.7 gives inline but that
 * `@mimi/shared/interfaces` does not carry (that package only transcribes the
 * "core resource" shapes — `Balance`/`Movement` — per its own header comment;
 * one-off query/response shapes stay local to the owning module, same as
 * every other Wave 3 module's `dto/`).
 */
import type { ISODate, Money, Movement, Qty, UUID } from '@mimi/shared';

export interface InventorySummary {
  totalItems: number;
  belowMin: number;
  /** Only present when the caller holds `supplier.price.read` (FR-SUP-06 role lock — mirrors `Balance.value`). */
  stockValue?: Money;
  byArea: { storageAreaId: UUID; name: string; items: number }[];
}

export interface LowStockRow {
  locationId: UUID;
  itemId: UUID;
  itemName: string;
  qtyOnHand: Qty;
  minQty: Qty;
  suggestedQty: Qty | null;
}

export interface MinStockRuleRow {
  id: UUID;
  locationId: UUID;
  itemId: UUID;
  itemName: string;
  minQty: Qty;
  reorderQty: Qty | null;
  isActive: boolean;
}

export interface SuggestionRow {
  itemId: UUID;
  itemName: string;
  qtyOnHand: Qty;
  minQty: Qty;
  avgDailyUsage: Qty;
  suggestedQty: Qty;
  basis: 'usage_pattern' | 'reorder_qty';
}

export interface HistoryDayRow {
  date: ISODate;
  qtyIn: Qty;
  qtyOut: Qty;
  closing: Qty;
}

export interface AreaTransferResult {
  ok: true;
  movements: Movement[];
}
