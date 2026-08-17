import { IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

const QTY_PATTERN = /^\d+(\.\d{1,3})?$/;

/** `POST /api/inventory/area-transfer` body (CONTRACTS.md §4.7, D-15). */
export class AreaTransferDto {
  @IsUUID()
  locationId!: string;

  @IsUUID()
  itemId!: string;

  @IsUUID()
  fromAreaId!: string;

  @IsUUID()
  toAreaId!: string;

  @Matches(QTY_PATTERN, { message: 'qty must be a positive decimal string with up to 3 fractional digits, e.g. "5.000"' })
  qty!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
