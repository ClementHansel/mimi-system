import { Type } from 'class-transformer';
import {
  IsBoolean,
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

  @IsOptional()
  @IsString()
  @MaxLength(100)
  category?: string;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  active?: boolean;

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

  @IsString()
  @MaxLength(100)
  category!: string;

  @IsString()
  @Matches(MONEY_RE)
  price!: string;

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
  @IsString()
  @MaxLength(100)
  category?: string;

  @IsOptional()
  @IsString()
  @Matches(MONEY_RE)
  price?: string;

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
