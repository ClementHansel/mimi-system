import { IsDateString, IsIn, IsOptional, IsUUID } from 'class-validator';
import { FormatQueryDto } from './format.query';

export type SalesReportGroupBy = 'day' | 'outlet' | 'product' | 'method' | 'channel';

/** `GET /api/reports/sales` query params (CONTRACTS.md §4.19). */
export class SalesReportQueryDto extends FormatQueryDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsIn(['day', 'outlet', 'product', 'method', 'channel'])
  groupBy?: SalesReportGroupBy;
}
