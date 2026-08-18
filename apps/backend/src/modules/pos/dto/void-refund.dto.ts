import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { VoidRefundStatus, VoidRefundType } from '@mimi/shared';
import { IsMoneyString } from './common.dto';

/** `POST /api/pos/sales/:id/void-request` — CONTRACTS.md §4.13, FR-POS-03. */
export class VoidRequestDto {
  @IsUUID()
  clientId!: string;

  @IsEnum(VoidRefundType)
  type!: VoidRefundType;

  @IsString()
  @IsNotEmpty({ message: 'alasan void wajib diisi' })
  reason!: string;

  @IsOptional()
  @IsMoneyString()
  amount?: string;
}

/** `POST /api/pos/void-refunds/:id/approve` — online path. `pin` authenticates the approving supervisor's own PIN (D-17's cached-credential offline path is a sync event, not this endpoint). */
export class ApproveVoidDto {
  @IsString()
  @IsNotEmpty()
  pin!: string;
}

export class RejectVoidDto {
  @IsString()
  @IsNotEmpty({ message: 'alasan penolakan wajib diisi' })
  reason!: string;
}

export class ListVoidRefundsQueryDto {
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsEnum(VoidRefundStatus)
  status?: VoidRefundStatus;

  @IsOptional()
  @IsISO8601()
  date?: string;

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
