import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

/** `POST /api/products/categories` body — POS menu category (CONTRACTS.md §4.5, migration 247). */
export class CreateProductCategoryDto {
  @IsString()
  @MaxLength(100)
  name!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

/** `PATCH /api/products/categories/:id` body — partial; rename, reorder, retire. */
export class UpdateProductCategoryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** `GET /api/products/categories?includeInactive=` — the back office needs retired rows to rename or reactivate them; the till never does. */
export class ListProductCategoriesQueryDto {
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  includeInactive?: boolean;
}

/**
 * `PUT /api/products/categories/order` body — the whole ordered list of ids in
 * one call, not one PATCH per row.
 *
 * WHY A BULK ROUTE: order is a statement about the list, not about any one row,
 * so N sequential PATCHes would leave the till's chip row transiently
 * inconsistent — and permanently so if one of them failed halfway. One request,
 * one transaction.
 */
export class ReorderProductCategoriesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsUUID(undefined, { each: true })
  ids!: string[];
}
