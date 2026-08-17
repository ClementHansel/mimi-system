import { Type } from 'class-transformer';
import { IsDateString, IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { MovementType } from '@mimi/shared';

/** `GET /api/inventory/movements` query params (CONTRACTS.md §4.7). */
export class ListMovementsQueryDto {
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsUUID()
  itemId?: string;

  @IsOptional()
  @IsUUID()
  storageAreaId?: string;

  @IsOptional()
  @IsEnum(MovementType)
  movementType?: MovementType;

  /** `'YYYY-MM-DD'` — inclusive lower bound on `occurred_at` (WITA calendar day). */
  @IsOptional()
  @IsDateString()
  from?: string;

  /** `'YYYY-MM-DD'` — inclusive upper bound on `occurred_at` (WITA calendar day). */
  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number;
}
