import { IsDateString, IsOptional, IsUUID } from 'class-validator';
import { FormatQueryDto } from './format.query';

/** `GET /api/reports/stock-usage` query params (CONTRACTS.md §4.19, FR-POS-06/FR-LOG-21). */
export class StockUsageQueryDto extends FormatQueryDto {
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}
