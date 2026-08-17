import { IsOptional, IsUUID, Matches } from 'class-validator';
import { FormatQueryDto } from './format.query';

/** `GET /api/reports/attendance` query params (CONTRACTS.md §4.19, FR-HR-03). */
export class AttendanceReportQueryDto extends FormatQueryDto {
  /** `'YYYY-MM'` payroll period code (same convention as `payrollPeriodBoundaries` in `@mimi/shared/wita`). */
  @Matches(/^\d{4}-\d{2}$/, { message: 'periodCode must be YYYY-MM' })
  periodCode!: string;

  @IsOptional()
  @IsUUID()
  locationId?: string;
}
