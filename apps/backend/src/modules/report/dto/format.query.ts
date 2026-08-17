import { IsIn, IsOptional } from 'class-validator';
import type { ReportFormat } from '../report-response.util';

/** `?format=` — shared by every §4.19 endpoint (CONTRACTS.md §4.19). */
export class FormatQueryDto {
  @IsOptional()
  @IsIn(['json', 'csv', 'xlsx'])
  format?: ReportFormat;
}
