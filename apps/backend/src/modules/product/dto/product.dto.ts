import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** NUMERIC(18,2) decimal-string pattern (Money wire type, CONTRACTS.md §0). */
const MONEY_RE = /^\d+(\.\d{1,2})?$/;

/** `GET /api/products?q=&category=&active=&page=` (CONTRACTS.md §4.5). */
export class ListProductsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  q?: string;

  /** Filter by menu category. A `product_categories` id since migration 247 — the free-text name it replaced was never a stable key. */
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  active?: boolean;

  /** `'package'` to list only bundles, `'product'` only plain products; omitted lists both. */
  @IsOptional()
  @IsIn(['product', 'package'])
  kind?: 'product' | 'package';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number = 50;
}

/** `POST /api/products` body (CONTRACTS.md §4.5). */
export class CreateProductDto {
  @IsString()
  @MaxLength(50)
  code!: string;

  @IsString()
  @MaxLength(255)
  name!: string;

  @IsUUID()
  categoryId!: string;

  @IsString()
  @Matches(MONEY_RE)
  price!: string;

  /** GoFood price (three-tier channel pricing, migration 249). Omit to fall back to `price`. */
  @IsOptional()
  @IsString()
  @Matches(MONEY_RE)
  priceGofood?: string;

  /** ShopeeFood price. Omit to fall back to `price`. */
  @IsOptional()
  @IsString()
  @Matches(MONEY_RE)
  priceShopeefood?: string;

  @IsOptional()
  @IsUUID()
  photoAttachmentId?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

/** `PATCH /api/products/:id` body — partial. A `price` change emits `products.price_changed` (CONTRACTS.md §4.5). */
export class UpdateProductDto {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsString()
  @Matches(MONEY_RE)
  price?: string;

  /**
   * GoFood price. `undefined` leaves it unchanged, `null` clears the
   * override back to falling through to `price`, a money string sets it —
   * same three-state convention as `photoAttachmentId` below.
   */
  @IsOptional()
  @IsString()
  @Matches(MONEY_RE)
  priceGofood?: string | null;

  /** ShopeeFood price — same three-state convention as `priceGofood`. */
  @IsOptional()
  @IsString()
  @Matches(MONEY_RE)
  priceShopeefood?: string | null;

  @IsOptional()
  @IsUUID()
  photoAttachmentId?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  /**
   * Take a product off the POS menu, or put it back (owner, 2026-08-21).
   * `products.is_active` existed from migration 012 and nothing could ever
   * change it: no PATCH field, no deactivate route. A sold-out or seasonal line
   * could not be hidden from the till at all.
   */
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
