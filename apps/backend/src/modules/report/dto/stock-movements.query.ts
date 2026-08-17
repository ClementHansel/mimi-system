import { IsDateString, IsIn, IsOptional, IsUUID } from 'class-validator';
import { FormatQueryDto } from './format.query';

const MOVEMENT_TYPES = [
  'opening_balance',
  'purchase_in',
  'transfer_in',
  'transfer_out',
  'usage_out',
  'waste_out',
  'return_in',
  'return_out',
  'adjustment_in',
  'adjustment_out',
] as const;

/** `GET /api/reports/stock-movements` query params (CONTRACTS.md §4.19, FR-LOG-21/FR-SO-04). */
export class StockMovementsQueryDto extends FormatQueryDto {
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsIn(MOVEMENT_TYPES)
  movementType?: (typeof MOVEMENT_TYPES)[number];
}
