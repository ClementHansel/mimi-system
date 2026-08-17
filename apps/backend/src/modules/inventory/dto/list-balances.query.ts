import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

/** `GET /api/inventory/balances` query params (CONTRACTS.md §4.7). */
export class ListBalancesQueryDto {
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsUUID()
  storageAreaId?: string;

  @IsOptional()
  @IsUUID()
  itemId?: string;

  /**
   * `?belowMin=true` — class-transformer's default `@Type(() => Boolean)`
   * would treat the STRING `"false"` as truthy (`Boolean("false") === true`),
   * so this transforms explicitly off the raw query string instead.
   */
  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : value === true || value === 'true'))
  @IsBoolean()
  belowMin?: boolean;

  @IsOptional()
  @IsString()
  q?: string;

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
