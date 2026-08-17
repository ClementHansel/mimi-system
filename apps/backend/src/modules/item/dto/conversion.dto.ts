import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsString, IsUUID, Matches, ValidateNested } from 'class-validator';

/** NUMERIC(14,6) decimal-string pattern (`unit_conversions.factor`, CONTRACTS.md §1.2). */
const FACTOR_RE = /^\d+(\.\d+)?$/;

export class UnitConversionLineDto {
  @IsUUID()
  fromUnitId!: string;

  @IsUUID()
  toUnitId!: string;

  @IsString()
  @Matches(FACTOR_RE)
  factor!: string;
}

/** `PUT /api/items/:id/conversions` body (CONTRACTS.md §4.4) — full replace of the item's conversion set. */
export class PutConversionsDto {
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => UnitConversionLineDto)
  conversions!: UnitConversionLineDto[];
}
