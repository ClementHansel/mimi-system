import { Type } from 'class-transformer';
import {
  ArrayMinSize,
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

/**
 * PR edit (owner, 2026-08-21: "PR should be editable"). Every field optional:
 * a PATCH that sends only `neededBy` must move only `neededBy` — an omitted
 * `notes` is "leave it alone", not "blank it".
 *
 * `lines`, when present, REPLACES the whole set (see
 * `PurchaseRequestRepository.deleteLines` for why replace beats diff here). An
 * empty array is rejected: a purchase request with nothing on it is not a
 * document, and deleting the PR is a different intent with a different button.
 */
export class UpdatePurchaseRequestDto {
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsDateString()
  neededBy?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PurchaseRequestLineDto)
  lines?: PurchaseRequestLineDto[];
}

/**
 * Convert an outlet's replenishment request into a draft PR (owner: "a place to
 * see requests from stores properly and able to convert that to PR"). The
 * request supplies the lines; the office supplies the DESTINATION, because
 * where goods are received is a warehouse decision, not the outlet's.
 */
export class CreatePurchaseRequestFromReplenishmentDto {
  @IsUUID()
  replenishmentId!: string;

  @IsUUID()
  locationId!: string;

  @IsOptional()
  @IsDateString()
  neededBy?: string;

  @IsOptional()
  @IsString()
  notes?: string;
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
