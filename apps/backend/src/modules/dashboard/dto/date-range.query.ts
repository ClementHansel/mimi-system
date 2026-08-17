import { IsDateString, IsOptional, IsUUID } from 'class-validator';

/** `?from=&to=` — WITA calendar dates (`'YYYY-MM-DD'`), used by `/overview`, `/top-products`, `/staff-kpi`, `/trend`. */
export class DateRangeQueryDto {
  @IsDateString({ strict: true })
  from!: string;

  @IsDateString({ strict: true })
  to!: string;

  @IsOptional()
  @IsUUID()
  locationId?: string;
}
