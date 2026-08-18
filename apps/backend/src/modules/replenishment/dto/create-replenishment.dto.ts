import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsOptional,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { IsQtyString } from '../qty.validator';

export class CreateReplenishmentLineDto {
  @IsUUID()
  itemId!: string;

  @IsQtyString()
  qtyRequested!: string;

  @IsUUID()
  unitId!: string;
}

/** `POST /api/replenishment` (CONTRACTS.md §4.9). `locationId` is validated against the caller's own scope in the service — RLS alone would only stop the INSERT after the fact, and a clear `ERR_LOCATION_OUT_OF_SCOPE` is a better failure than a generic RLS denial. */
export class CreateReplenishmentDto {
  @IsUUID()
  locationId!: string;

  @IsOptional()
  @IsDateString({ strict: true })
  neededBy?: string;

  @IsOptional()
  @IsIn(['manual', 'auto_suggestion'])
  source?: 'manual' | 'auto_suggestion';

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateReplenishmentLineDto)
  lines!: CreateReplenishmentLineDto[];
}
