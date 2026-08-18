import { Type } from 'class-transformer';
import {
  IsEnum,
  IsISO8601,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { CashVarianceProposalStatus } from '@mimi/shared';

/**
 * `POST /api/pos/cash-variances/:id/approve` and `/reject` — CONTRACTS.md
 * §4.13, Amendment 2 / D-19 / §5.9. Reason is REQUIRED on both approve and
 * reject (unlike every other approval chain, where reject alone requires
 * one) — a wage-deduction decision is never silent either way.
 */
export class CashVarianceDecisionDto {
  @IsString()
  @IsNotEmpty({ message: 'alasan keputusan wajib diisi (disetujui maupun ditolak)' })
  reason!: string;
}

export class ListCashVariancesQueryDto {
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsEnum(CashVarianceProposalStatus)
  status?: CashVarianceProposalStatus;

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number = 50;
}
