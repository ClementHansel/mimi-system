import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PaymentMethod, SaleStatus, type SaleChannel } from '@mimi/shared';
import { IsMoneyString, IsQtyString } from './common.dto';

/** `sales.channel`'s CHECK constraint values, verbatim (migration 249). */
const SALE_CHANNELS: SaleChannel[] = ['walk_in', 'gofood', 'shopeefood'];

export class SaleLineDto {
  @IsUUID()
  productId!: string;

  @IsQtyString()
  qty!: string;

  @IsMoneyString()
  unitPrice!: string;

  @IsOptional()
  @IsMoneyString()
  discount?: string;
}

export class SalePaymentDto {
  @IsEnum(PaymentMethod)
  method!: PaymentMethod;

  @IsMoneyString()
  amount!: string;

  @IsOptional()
  @IsString()
  reference?: string;

  @IsOptional()
  @IsUUID()
  proofAttachmentId?: string;
}

/**
 * `VoucherRedemptionDraft` on the wire — the coupon a sale was rung with.
 *
 * `code` is validated only for LENGTH here, not shape: `normalizeVoucherCode()`
 * on the server accepts exactly the sloppiness a cashier types (lower case,
 * missing dashes, an `O` for a `0`), and rejecting those at the DTO boundary
 * would make the server stricter than the till it has to agree with. A code
 * that cannot be normalised is refused later, with a voucher-shaped error the
 * cashier can read, rather than a field-validation 400.
 */
export class SaleVoucherDto {
  @IsString()
  @MaxLength(40)
  code!: string;

  /** What the DEVICE calculated. Recorded and compared; never used as money. */
  @IsOptional()
  @IsMoneyString()
  discount?: string;

  /** True when the till took this coupon while it could not reach the cloud. */
  @IsOptional()
  @IsBoolean()
  offlineAccepted?: boolean;
}

/** `POST /api/pos/sales` — CONTRACTS.md §4.13. Duplicate `clientId` returns the existing sale (200, idempotent). */
export class CreateSaleDto {
  @IsUUID()
  clientId!: string;

  @IsUUID()
  shiftId!: string;

  @IsUUID()
  locationId!: string;

  @IsISO8601()
  occurredAt!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SaleLineDto)
  lines!: SaleLineDto[];

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SalePaymentDto)
  payments!: SalePaymentDto[];

  /**
   * Sale-level MANUAL discount, EXCLUDING any voucher.
   *
   * That exclusion is a CONTRACT, not a description, and it is the reason
   * `voucher` below carries its own `discount` field. The server prices the
   * coupon itself — from its own subtotal and its own copy of the batch rules,
   * via `@mimi/shared`'s `checkVoucher()` — and ADDS the result to this
   * number. A client that also folded the coupon into `discount` would have it
   * subtracted twice, and the customer would be undercharged by exactly the
   * value of the coupon.
   *
   * The identical statement is on the `sales.completed` sync schema's own
   * `discount` field, because the offline outbox has to follow the same rule.
   */
  @IsOptional()
  @IsMoneyString()
  discount?: string;

  /**
   * The coupon this sale was rung with, if any.
   *
   * `discount` here is what the DEVICE calculated. It is recorded and compared
   * but NEVER trusted: the server recomputes the voucher's worth and raises a
   * reconciliation exception if the two disagree. See
   * `voucher-redemption.service.ts`'s header for why, and for what happens
   * when an offline till took a coupon the server then cannot redeem.
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => SaleVoucherDto)
  voucher?: SaleVoucherDto;

  /**
   * Which counter this sale was rung up under (three-tier channel pricing,
   * migration 249). Omitted defaults to `'walk_in'` — same as `sales.channel`'s
   * own `DEFAULT`, kept optional so an offline device queued against an
   * older app build (no channel picker yet) still posts a valid sale. The
   * cart's `lines[].unitPrice` must already be the price for THIS channel —
   * the server stores it as given and never re-derives it from `Product.price`.
   */
  @IsOptional()
  @IsIn(SALE_CHANNELS)
  channel?: SaleChannel;
}

export class ListSalesQueryDto {
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsUUID()
  shiftId?: string;

  @IsOptional()
  @IsISO8601()
  date?: string;

  @IsOptional()
  @IsEnum(SaleStatus)
  status?: SaleStatus;

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
