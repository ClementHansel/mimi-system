import { IsDateString, IsOptional, IsUUID } from 'class-validator';
import { FormatQueryDto } from './format.query';

/** `GET /api/reports/waste` query params (CONTRACTS.md §4.19, FR-WST-04). */
export class WasteReportQueryDto extends FormatQueryDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsUUID()
  locationId?: string;
}
