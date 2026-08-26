import type { Money, Qty, Temp, UUID, ISODate, ISODateTime } from '@/lib/shared-types';

/**
 * Wire shapes for F10 admin's endpoints (CONTRACTS.md §4.2 users, §4.3
 * location/storage-area, §4.4 item, §4.5 product/recipe, §4.0 audit, §4.20
 * settings, §4.15 payroll-statutory). None of these are exported from
 * `@mimi/shared` (only the kernel/auth/RBAC shapes are, per
 * `lib/shared-types.ts`) — module response DTOs live with the module that
 * consumes them, transcribed verbatim from CONTRACTS' `interface` blocks.
 */

// ── §4.2 users ────────────────────────────────────────────────────────────
export interface UserRow {
  id: UUID;
  username: string;
  name: string;
  email: string | null;
  phone: string | null;
  roleKey: string;
  roleName: string;
  locations: { id: UUID; name: string }[];
  isActive: boolean;
  lastLoginAt: ISODateTime | null;
  createdAt: ISODateTime;
}

// ── §4.3 location / storage area ────────────────────────────────────────
export interface Location {
  id: UUID;
  code: string;
  name: string;
  type: 'warehouse' | 'outlet';
  city: string;
  address: string | null;
  phone: string | null;
  latitude: string | null;
  longitude: string | null;
  /** EFFECTIVE radius (own value, else the `hr.geofence_radius_m` default). */
  geofenceRadiusM: number;
  /** True when this location overrides the default rather than inheriting it. */
  geofenceRadiusIsOverride: boolean;
  isActive: boolean;
  storageAreaCount: number;
}

export type StorageAreaType = 'freezer' | 'chiller' | 'dry_store' | 'display' | 'kitchen_line';

export interface StorageArea {
  id: UUID;
  locationId: UUID;
  code: string;
  name: string;
  type: StorageAreaType;
  tempMin: Temp | null;
  tempMax: Temp | null;
  sortOrder: number;
  isActive: boolean;
}

// ── §4.4 item ─────────────────────────────────────────────────────────────
export interface ItemCategory {
  id: UUID;
  name: string;
  parentId: UUID | null;
  sortOrder: number;
}

export interface Unit {
  id: UUID;
  code: string;
  name: string;
}

export interface Item {
  id: UUID;
  sku: string;
  name: string;
  categoryId: UUID | null;
  categoryName: string | null;
  baseUnit: { id: UUID; code: string };
  storageType: 'frozen' | 'chilled' | 'dry';
  isSellable: boolean;
  shelfLifeDays: number | null;
  tempMin: Temp | null;
  tempMax: Temp | null;
  avgCost?: Money;
  lastPurchaseCost?: Money;
  barcode: string | null;
  isActive: boolean;
}

// ── §4.5 product / recipe / package ──────────────────────────────────────
/** A POS menu category — a `product_categories` row since migration 247, free text on `products.category` before it. */
export interface ProductCategory {
  id: UUID;
  name: string;
  sortOrder: number;
  isActive: boolean;
  /** Includes INACTIVE products: what makes retiring the category unsafe. */
  productCount: number;
}

export type ProductKind = 'product' | 'package';

/** One member of a package (`product_package_lines`, migration 248). */
export interface ProductPackageLine {
  memberProductId: UUID;
  memberName: string;
  memberCode: string;
  qty: Qty;
  sortOrder: number;
}

export interface Product {
  id: UUID;
  code: string;
  name: string;
  /** Display name of the category; `categoryId` is the key to send back. */
  category: string;
  categoryId: UUID;
  price: Money;
  /** Presigned and EXPIRING (10 min) — fine to render now, never to cache. */
  photoUrl: string | null;
  /** Stable api-relative path to a cached thumbnail, or null when there is no photo. */
  photoPath: string | null;
  sortOrder: number;
  isActive: boolean;
  kind: ProductKind;
  hasRecipe: boolean;
  /** Present only when `kind === 'package'`. */
  packageLines?: ProductPackageLine[];
}

export interface RecipeLine {
  itemId: UUID;
  itemName: string;
  qty: Qty;
  unitId: UUID;
  unitCode: string;
}

export interface Recipe {
  productId: UUID;
  yieldQty: Qty;
  lines: RecipeLine[];
}

// ── §4.0 audit ────────────────────────────────────────────────────────────
export interface AuditRow {
  id: UUID;
  userId: UUID;
  userName: string;
  roleKey: string;
  module: string;
  action: string;
  entityType: string;
  // NULLABLE in the database and null for most real rows (an action with no
  // single target row — a login, a report export — has no entity id). This was
  // typed as a plain `UUID`, so TypeScript could not catch `entityId.slice()`
  // and the Jejak Audit page crashed to a blank "Application error" screen.
  // The type lying about nullability is the root cause; the guard in
  // AuditPanel is only the symptom fix.
  entityId: UUID | null;
  beforeValue: object | null;
  afterValue: object | null;
  reason: string | null;
  offlineAuthorized: boolean;
  occurredAt: ISODateTime;
}

// ── §4.20 settings ────────────────────────────────────────────────────────
export interface Setting {
  key: string;
  value: unknown;
  description: string;
  updatedBy: string | null;
  updatedAt: ISODateTime;
}

// ── §4.15 payroll statutory (Amendment 1 / D-18) ─────────────────────────
export type StatutoryMissingKey =
  | 'bpjs_configs'
  | 'pph21_ter_rates'
  | 'pph21_ptkp'
  | 'pph21_article17_brackets'
  | 'employee_tax_profiles';

export interface StatutoryStatus {
  enabled: boolean;
  ready: boolean;
  enabledAt: ISODateTime | null;
  enabledBy: string | null;
  missing: StatutoryMissingKey[];
  profileCoverage: { withProfile: number; total: number };
}

export type { UUID, ISODate, ISODateTime, Money, Qty, Temp };
