import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { OnlineOrderStatus, OnlinePlatform, SettlementStatus } from '@mimi/shared';
import { IsMoneyString, IsQtyString } from './common.dto';

export class OnlineOrderItemDto {
  @IsUUID()
  productId!: string;

  @IsQtyString()
  qty!: string;
}

/** `POST /api/pos/online-orders` — CONTRACTS.md §4.13, FR-POS-05/07. `netReceived` must equal gross−discount−fees (`ERR_NET_MISMATCH`, `@mimi/shared`'s cart module). */
export class CreateOnlineOrderDto {
  @IsUUID()
  clientId!: string;

  @IsUUID()
  locationId!: string;

  @IsEnum(OnlinePlatform)
  platform!: OnlinePlatform;

  @IsString()
  orderRef!: string;

  @IsISO8601()
  orderDate!: string;

  @IsMoneyString()
  grossAmount!: string;

  @IsMoneyString()
  discountAmount!: string;

  @IsMoneyString()
  platformFee!: string;

  @IsMoneyString()
  otherFee!: string;

  @IsMoneyString()
  netReceived!: string;

  @IsEnum(OnlineOrderStatus)
  status!: OnlineOrderStatus;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OnlineOrderItemDto)
  items?: OnlineOrderItemDto[];

  @IsOptional()
  @IsUUID()
  shiftId?: string;
}

export class ListOnlineOrdersQueryDto {
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsEnum(OnlinePlatform)
  platform?: OnlinePlatform;

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  @IsOptional()
  @IsEnum(SettlementStatus)
  settlement?: SettlementStatus;

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
