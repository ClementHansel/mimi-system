import { IsOptional, IsUUID } from 'class-validator';

/** Shared shape for the several §4.7 endpoints whose only filter is `?locationId=` (summary, low-stock, suggestions). */
export class LocationScopeQueryDto {
  @IsOptional()
  @IsUUID()
  locationId?: string;
}
