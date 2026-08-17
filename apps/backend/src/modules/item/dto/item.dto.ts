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
import { ItemStorageType } from '@mimi/shared';

/** NUMERIC(4,1) decimal-string pattern (Temp wire type, CONTRACTS.md §0). */
const TEMP_RE = /^-?\d+(\.\d)?$/;

/** `GET /api/items?q=&categoryId=&storageType=&active=&page=` (CONTRACTS.md §4.4). */
export class ListItemsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  q?: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsIn(Object.values(ItemStorageType))
  storageType?: ItemStorageType;

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

/** `POST /api/items` body (CONTRACTS.md §4.4). */
export class CreateItemDto {
  @IsString()
  @MaxLength(50)
  sku!: string;

  @IsString()
  @MaxLength(255)
  name!: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsUUID()
  baseUnitId!: string;

  @IsIn(Object.values(ItemStorageType))
  storageType!: ItemStorageType;

  @IsOptional()
  @IsBoolean()
  isSellable?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  shelfLifeDays?: number;

  @IsOptional()
  @IsString()
  @Matches(TEMP_RE)
  tempMin?: string;

  @IsOptional()
  @IsString()
  @Matches(TEMP_RE)
  tempMax?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  barcode?: string;
}

/** `PATCH /api/items/:id` body — partial (CONTRACTS.md §4.4). */
export class UpdateItemDto {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  sku?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string | null;

  @IsOptional()
  @IsUUID()
  baseUnitId?: string;

  @IsOptional()
  @IsIn(Object.values(ItemStorageType))
  storageType?: ItemStorageType;

  @IsOptional()
  @IsBoolean()
  isSellable?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  shelfLifeDays?: number | null;

  @IsOptional()
  @IsString()
  @Matches(TEMP_RE)
  tempMin?: string | null;

  @IsOptional()
  @IsString()
  @Matches(TEMP_RE)
  tempMax?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  barcode?: string | null;
}

/** `POST /api/items/categories` body (CONTRACTS.md §4.4). */
export class CreateItemCategoryDto {
  @IsString()
  @MaxLength(100)
  name!: string;

  @IsOptional()
  @IsUUID()
  parentId?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

/** `PATCH /api/items/categories/:id` body — partial (CONTRACTS.md §4.4). */
export class UpdateItemCategoryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsUUID()
  parentId?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

/** `POST /api/units` body (CONTRACTS.md §4.4). */
export class CreateUnitDto {
  @IsString()
  @MaxLength(20)
  code!: string;

  @IsString()
  @MaxLength(50)
  name!: string;
}
