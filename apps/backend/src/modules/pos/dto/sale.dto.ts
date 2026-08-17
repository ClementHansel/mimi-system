import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { PaymentMethod, SaleStatus } from '@mimi/shared';
import { IsMoneyString, IsQtyString } from './common.dto';

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

  @IsOptional()
  @IsMoneyString()
  discount?: string;
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
