/**
 * POS (F02) local types — CONTRACTS.md §4.13. Kept separate from
 * `@/lib/shared-types` because these shapes are specific to this surface
 * (catalog cache envelope, cart line UI state) rather than wire types other
 * surfaces also need.
 */
import type { Money, Qty, UUID } from '@/lib/shared-types';

/** CONTRACTS §4.13 M09 `Product` — the POS catalog precache row (FR-POS-01). */
export interface PosPackageLine {
  memberProductId: UUID;
  memberName: string;
  memberCode: string;
  qty: Qty;
  sortOrder: number;
}

export interface PosProduct {
  id: UUID;
  code: string;
  name: string;
  category: string;
  categoryId: UUID;
  price: Money;
  /** Always `null` on this payload — a presigned url would expire before an offline catalog does. Use `photoPath`. */
  photoUrl: string | null;
  /** Stable api-relative path to a cached thumbnail; resolved to a `blob:` url by `product-photo-cache`. */
  photoPath: string | null;
  sortOrder: number;
  isActive: boolean;
  /** `'package'` sells as ONE line at its own price and consumes its members' recipes. */
  kind: 'product' | 'package';
  hasRecipe: boolean;
  /** Present only for a package — what the cashier sees is inside it. */
  packageLines?: PosPackageLine[];
}

export interface PosCatalog {
  products: PosProduct[];
  categories: string[];
  version: string;
  /** When this catalog was last fetched successfully — surfaced so the cashier knows how stale an offline catalog is. */
  fetchedAt: string;
}

/** One row in the on-screen cart — extends the pure `@mimi/shared` `CartLine` with display fields. */
export interface PosCartLine {
  productId: UUID;
  productName: string;
  unitPrice: Money;
  qty: Qty;
  discount: Money;
}

export type PosPaymentMethod = 'cash' | 'qris' | 'bank_transfer';

export interface PosPaymentDraft {
  method: PosPaymentMethod;
  amount: Money;
  reference: string | null;
}
