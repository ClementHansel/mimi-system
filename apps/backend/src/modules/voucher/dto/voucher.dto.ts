/** Request DTOs — the voucher module (`/api/vouchers/**`). */
import { Type } from 'class-transformer';
import { applyDecorators } from '@nestjs/common';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  Max,
  IsUUID,
  ValidateIf,
} from 'class-validator';
import { VoucherBatchStatus, VoucherStatus, VoucherType } from '@mimi/shared';

/**
 * Local copies of the two wire-format guards, matching this repo's
 * local-copy-per-module discipline (BUILD-PLAN §6 rule 1) rather than
 * importing `modules/pos/dto/common.dto`'s. Reaching across module folders
 * for a decorator would make `voucher` depend on `pos` for no runtime reason,
 * and these are four lines each. The regexes are byte-identical to that file's
 * on purpose — if one changes, both must.
 */
const MONEY_RE = /^-?\d+\.\d{2}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const IsMoneyString = (): PropertyDecorator =>
  applyDecorators(
    Matches(MONEY_RE, {
      message: 'must be a decimal money string with exactly 2 fractional digits, e.g. "125000.00"',
    }),
  );

/**
 * `valid_from`/`valid_until` are DATE columns compared as plain
 * `YYYY-MM-DD` strings by `checkVoucher()` — which is only correct because
 * ISO dates sort lexicographically and both sides are already the WITA
 * business date (D-11). `@IsISO8601()` would also accept a full datetime,
 * which would silently break that comparison the first time somebody sent
 * one. So: the strict date-only shape, nothing else.
 */
const IsIsoDate = (): PropertyDecorator =>
  applyDecorators(
    Matches(ISO_DATE_RE, { message: 'must be a date-only string, e.g. "2026-08-27"' }),
  );

const BATCH_CODE_RE = /^[A-Z0-9_-]+$/;

const VOUCHER_TYPES = Object.values(VoucherType) as readonly string[];
const BATCH_STATUSES = Object.values(VoucherBatchStatus) as readonly string[];
const VOUCHER_STATUSES = Object.values(VoucherStatus) as readonly string[];

/** `GET /api/vouchers/batches` */
export class ListBatchesQueryDto {
  @IsOptional()
  @IsIn(BATCH_STATUSES)
  status?: VoucherBatchStatus;

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

/** `GET /api/vouchers/batches/:id/vouchers` */
export class ListBatchVouchersQueryDto {
  @IsOptional()
  @IsIn(VOUCHER_STATUSES)
  status?: VoucherStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  pageSize?: number = 100;
}

/**
 * `POST /api/vouchers/batches` — authors a DRAFT batch. No coupons exist until
 * `POST /batches/:id/issue`, which is the whole reason the two are separate
 * endpoints with separate permissions: authoring a promotion is a marketing
 * act (`voucher.manage`), minting the money is not (`voucher.issue`).
 *
 * `value`'s MEANING depends on `type` — rupiah for `fixed`, a percent for
 * `percentage` (`'10.00'` = 10%, not 0.10). Both are `Money`-shaped strings
 * because both are `NUMERIC(18,2)`; the semantic switch lives in
 * `checkVoucher()`. The range check that a percentage cannot exceed 100 is
 * enforced BOTH here (fast, legible 400) and by
 * `chk_voucher_batch_value` in migration 254 (authoritative, and the one that
 * survives a future second writer).
 */
export class CreateBatchDto {
  @IsString()
  @MaxLength(20)
  @Matches(BATCH_CODE_RE, {
    message: 'must be uppercase letters, digits, underscore or hyphen — it is printed on the card',
  })
  code!: string;

  @IsString()
  @MaxLength(255)
  name!: string;

  @IsIn(VOUCHER_TYPES)
  type!: VoucherType;

  @IsMoneyString()
  value!: string;

  @IsOptional()
  @IsMoneyString()
  minSubtotal?: string;

  /**
   * Percentage cap. Nullable rather than merely optional: `null` explicitly
   * clears a cap on PATCH, and without it there would be no way to remove one
   * once set — the same reasoning `UpdateLocationDto.geofenceRadiusM` records.
   */
  @IsOptional()
  @ValidateIf((o: { maxDiscount?: string | null }) => o.maxDiscount !== null)
  @IsMoneyString()
  maxDiscount?: string | null;

  @IsIsoDate()
  validFrom!: string;

  @IsIsoDate()
  validUntil!: string;

  /**
   * `null`/omitted = usable at EVERY outlet. An empty array would mean
   * "usable at no outlet", which is a batch nobody can ever redeem — so
   * `@ArrayMinSize(1)` rejects it rather than letting an owner print a
   * thousand dead coupons.
   */
  @IsOptional()
  @ValidateIf((o: { locationIds?: string[] | null }) => o.locationIds !== null)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsUUID('4', { each: true })
  locationIds?: string[] | null;

  @IsOptional()
  @ValidateIf((o: { terms?: string | null }) => o.terms !== null)
  @IsString()
  @MaxLength(2000)
  terms?: string | null;
}

/**
 * `PATCH /api/vouchers/batches/:id` — draft-only, enforced in the UPDATE's own
 * `WHERE status = 'draft'` (see `VoucherRepository.updateDraftBatch`).
 *
 * `code` stays editable while draft but is deliberately absent from the
 * partial below... no: it IS present, for the same reason
 * `UpdateLocationDto.code` is — an edit form echoes the unchanged value back,
 * and the global `forbidNonWhitelisted` pipe would 400 on a field it does not
 * know. Changing it while nothing has been minted is harmless.
 */
export class UpdateBatchDto {
  @IsOptional()
  @IsString()
  @MaxLength(20)
  @Matches(BATCH_CODE_RE)
  code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsIn(VOUCHER_TYPES)
  type?: VoucherType;

  @IsOptional()
  @IsMoneyString()
  value?: string;

  @IsOptional()
  @IsMoneyString()
  minSubtotal?: string;

  @IsOptional()
  @ValidateIf((o: { maxDiscount?: string | null }) => o.maxDiscount !== null)
  @IsMoneyString()
  maxDiscount?: string | null;

  @IsOptional()
  @IsIsoDate()
  validFrom?: string;

  @IsOptional()
  @IsIsoDate()
  validUntil?: string;

  @IsOptional()
  @ValidateIf((o: { locationIds?: string[] | null }) => o.locationIds !== null)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsUUID('4', { each: true })
  locationIds?: string[] | null;

  @IsOptional()
  @ValidateIf((o: { terms?: string | null }) => o.terms !== null)
  @IsString()
  @MaxLength(2000)
  terms?: string | null;
}

/**
 * `POST /api/vouchers/batches/:id/issue` — mints `quantity` coupons.
 *
 * The 5000 ceiling is not arbitrary. Each coupon is one INSERT inside one
 * transaction, and the batch's card sheet prints 8-up on A4, so 5000 is 625
 * sheets of card stock — already far beyond any print run an outlet network
 * of this size does at once. A higher number is far more likely to be a typo
 * (an owner meaning 500) than an intention, and a typo here mints real
 * bearer instruments. Issuing twice is always available and is the honest way
 * to get more.
 */
export class IssueVouchersDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5000)
  quantity!: number;
}

/**
 * `POST /api/vouchers/check` — "what is this code worth on this basket", the
 * question a cashier asks with a customer standing in front of them.
 *
 * `subtotal` is the PRE-VOUCHER basket total (after line and sale discounts),
 * matching `VoucherCheckInput.subtotal`'s contract exactly.
 *
 * This endpoint WRITES NOTHING and reserves nothing. That is a real design
 * decision with a real cost: between the check and the sale, another till can
 * take the same coupon, so a cashier can be told "Rp 10.000 off" and then have
 * the sale refuse it. The alternative — reserving the coupon here — would need
 * a lease with an expiry and a sweeper, and would let a customer who walks
 * away lock a coupon out for the lease duration. The window is seconds, the
 * failure mode is a clear refusal at payment rather than a wrong receipt, and
 * the redemption itself is still arbitrated by the unique index. See
 * migration 254's header.
 */
export class CheckVoucherDto {
  @IsString()
  @MaxLength(40)
  code!: string;

  @IsMoneyString()
  subtotal!: string;

  @IsUUID()
  locationId!: string;
}
