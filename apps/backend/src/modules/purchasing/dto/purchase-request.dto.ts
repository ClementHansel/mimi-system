import { Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';

const QTY_RE = /^\d+(\.\d{1,3})?$/;
const MONEY_RE = /^\d+(\.\d{1,2})?$/;

export class PurchaseRequestLineDto {
  @IsUUID()
  itemId!: string;

  @IsString()
  @Matches(QTY_RE)
  qty!: string;

  @IsUUID()
  unitId!: string;

  @IsOptional()
  @IsString()
  @Matches(MONEY_RE)
  estPrice?: string;

  @IsOptional()
  @IsUUID()
  suggestedSupplierId?: string;
}

export class CreatePurchaseRequestDto {
  @IsUUID()
  locationId!: string;

  @IsOptional()
  @IsDateString()
  neededBy?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PurchaseRequestLineDto)
  lines!: PurchaseRequestLineDto[];
}

export class ListPurchaseRequestQueryDto {
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number;
}

export class ApprovePurchaseRequestDto {
  @IsOptional()
  @IsString()
  note?: string;
}

export class RejectPurchaseRequestDto {
  @IsString()
  reason!: string;
}
