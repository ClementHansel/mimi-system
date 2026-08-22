import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
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

/**
 * `POST /api/pos/void-refunds/:id/approve` — online path.
 *
 * B-15 (owner Q8, 2026-08-22): this used to carry the approving supervisor's
 * standing `pin`. It now carries a ONE-TIME `code` the approver generated for
 * this specific void (`POST /api/approvals/void_refund/:id/code`) and relayed
 * to the till. Nobody holds a reusable secret, so there is nothing here for
 * repeated guessing to extract.
 *
 * Six digits, exactly — validated at the edge so a malformed body never reaches
 * the argon2 verify, which is deliberately slow and would otherwise be a free
 * way to burn server time.
 *
 * D-17's cached-credential OFFLINE path is unchanged and still PIN-based: it is
 * a sync event, not this endpoint, and no server exists to mint a code when the
 * outlet has no internet. See B-17 for the offline recovery work that owes.
 */
export class ApproveVoidDto {
  @IsString()
  @Matches(/^\d{6}$/, { message: 'kode persetujuan harus 6 digit angka' })
  code!: string;
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
