import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsISO8601,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumberString,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { AccountType, PayeeType, PaymentVerificationRefType } from '@mimi/shared';

/** M17 `accounting` DTOs — CONTRACTS.md §4.17. Kept in one file (unlike the per-endpoint
 * `dto/*.ts` split some sibling modules use) since this module has ~20 request shapes across
 * six sub-areas; splitting further would cost more in cross-file navigation than it buys. */

// ── §4.17 chart of accounts ──────────────────────────────────────────────────

export class ListAccountsQueryDto {
  @IsOptional()
  @IsEnum(AccountType)
  type?: AccountType;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsString()
  q?: string;
}

export class CreateAccountDto {
  @IsString()
  @IsNotEmpty()
  code!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsEnum(AccountType)
  type!: AccountType;

  @IsIn(['debit', 'credit'])
  normalBalance!: 'debit' | 'credit';

  @IsOptional()
  @IsUUID()
  parentId?: string;

  @IsOptional()
  @IsBoolean()
  isPostable?: boolean;
}

export class UpdateAccountDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

// ── §4.17 journal ─────────────────────────────────────────────────────────────

export class ListJournalQueryDto {
  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  @IsOptional()
  @IsString()
  accountCode?: string;

  @IsOptional()
  @IsString()
  eventType?: string;

  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsIn(['system', 'manual'])
  source?: 'system' | 'manual';

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

export class JournalLineDto {
  @IsString()
  @IsNotEmpty()
  accountCode!: string;

  @IsOptional()
  @IsNumberString()
  debit?: string;

  @IsOptional()
  @IsNumberString()
  credit?: string;

  @IsOptional()
  @IsString()
  memo?: string;
}

export class CreateJournalEntryDto {
  @IsISO8601()
  entryDate!: string;

  @IsString()
  @IsNotEmpty()
  description!: string;

  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => JournalLineDto)
  lines!: JournalLineDto[];
}

export class ReverseJournalEntryDto {
  @IsString()
  @IsNotEmpty()
  reason!: string;
}

// ── §4.17 fiscal periods ──────────────────────────────────────────────────────

export class ClosePeriodDto {
  @IsOptional()
  @IsString()
  note?: string;
}

export class ReopenPeriodDto {
  @IsString()
  @IsNotEmpty()
  reason!: string;
}

// ── §4.17 reports ─────────────────────────────────────────────────────────────

export class TrialBalanceQueryDto {
  @IsString()
  @IsNotEmpty()
  periodCode!: string;
}

export class ProfitLossQueryDto {
  @IsISO8601()
  from!: string;

  @IsISO8601()
  to!: string;

  @IsOptional()
  @IsUUID()
  locationId?: string;
}

export class BalanceSheetQueryDto {
  @IsISO8601()
  asOf!: string;
}

export class StockValueQueryDto {
  @IsOptional()
  @IsISO8601()
  asOf?: string;

  @IsOptional()
  @IsUUID()
  locationId?: string;
}

// ── §4.17 payment verification (FR-ACCT-01..04) ───────────────────────────────

export class ListPaymentsQueryDto {
  @IsOptional()
  @IsIn(['pending', 'verified', 'paid', 'rejected'])
  status?: string;

  @IsOptional()
  @IsString()
  refType?: string;

  @IsOptional()
  @IsUUID()
  locationId?: string;

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

export class CreatePaymentDto {
  @IsEnum(PaymentVerificationRefType)
  refType!: PaymentVerificationRefType;

  @IsOptional()
  @IsUUID()
  refId?: string;

  @IsEnum(PayeeType)
  payeeType!: PayeeType;

  @IsOptional()
  @IsUUID()
  payeeId?: string;

  @IsNumberString()
  amount!: string;

  @IsOptional()
  @IsUUID()
  proofAttachmentId?: string;

  @IsOptional()
  @IsString()
  referenceNumber?: string;

  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class UploadProofDto {
  @IsUUID()
  proofAttachmentId!: string;

  @IsOptional()
  @IsString()
  referenceNumber?: string;
}

export class VerifyPaymentDto {
  @IsOptional()
  @IsString()
  note?: string;
}

export class PayPaymentDto {
  @IsIn(['cash', 'bank_transfer', 'qris'])
  paidVia!: 'cash' | 'bank_transfer' | 'qris';

  @IsOptional()
  @IsISO8601()
  paidAt?: string;
}

export class RejectPaymentDto {
  @IsString()
  @IsNotEmpty()
  reason!: string;
}

// ── §4.17 exceptions (D-17 finance queue) ─────────────────────────────────────

export class ListExceptionsQueryDto {
  @IsOptional()
  @IsIn(['open', 'resolved', 'dismissed'])
  status?: string;

  @IsOptional()
  @IsIn(['offline_auth_failed', 'offline_auth_unprovable'])
  class?: string;

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

export class ExceptionVerdictDto {
  @IsIn(['upheld', 'rejected'])
  verdict!: 'upheld' | 'rejected';

  @IsString()
  @IsNotEmpty()
  reason!: string;

  @IsOptional()
  @IsBoolean()
  routeToPayrollDeduction?: boolean;
}
