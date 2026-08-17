import { IsDateString, IsIn, IsOptional, IsUUID } from 'class-validator';

/** `GET /api/dashboard/trend` query params (CONTRACTS.md §4.18). */
export class TrendQueryDto {
  @IsIn(['revenue', 'tx', 'usage'])
  metric!: 'revenue' | 'tx' | 'usage';

  @IsIn(['daily', 'weekly'])
  granularity!: 'daily' | 'weekly';

  @IsDateString({ strict: true })
  from!: string;

  @IsDateString({ strict: true })
  to!: string;

  @IsOptional()
  @IsUUID()
  locationId?: string;
}
