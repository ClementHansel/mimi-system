import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';
import { StorageAreaType } from '@mimi/shared';

/** NUMERIC(4,1) decimal-string pattern (Temp wire type, CONTRACTS.md §0). */
const TEMP_RE = /^-?\d+(\.\d)?$/;

/** `GET /api/locations/:id/storage-areas?active=` (CONTRACTS.md §4.3). */
export class ListStorageAreasQueryDto {
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  active?: boolean;
}

/** `POST /api/locations/:id/storage-areas` body (CONTRACTS.md §4.3, D-15). */
export class CreateStorageAreaDto {
  @IsString()
  @MaxLength(20)
  code!: string;

  @IsString()
  @MaxLength(100)
  name!: string;

  @IsIn(Object.values(StorageAreaType))
  type!: StorageAreaType;

  @IsOptional()
  @IsString()
  @Matches(TEMP_RE)
  tempMin?: string;

  @IsOptional()
  @IsString()
  @Matches(TEMP_RE)
  tempMax?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

/** `PATCH /api/locations/:id/storage-areas/:areaId` body — partial (CONTRACTS.md §4.3). */
export class UpdateStorageAreaDto {
  @IsOptional()
  @IsString()
  @MaxLength(20)
  code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsIn(Object.values(StorageAreaType))
  type?: StorageAreaType;

  @IsOptional()
  @IsString()
  @Matches(TEMP_RE)
  tempMin?: string | null;

  @IsOptional()
  @IsString()
  @Matches(TEMP_RE)
  tempMax?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
