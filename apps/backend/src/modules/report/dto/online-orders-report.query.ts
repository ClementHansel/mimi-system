import { IsDateString, IsIn, IsOptional, IsUUID } from 'class-validator';
import { FormatQueryDto } from './format.query';

/** `GET /api/reports/online-orders` query params (CONTRACTS.md §4.19, FR-POS-05/07). */
export class OnlineOrdersReportQueryDto extends FormatQueryDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsIn(['gofood', 'shopeefood'])
  platform?: 'gofood' | 'shopeefood';

  @IsOptional()
  @IsUUID()
  locationId?: string;
}
