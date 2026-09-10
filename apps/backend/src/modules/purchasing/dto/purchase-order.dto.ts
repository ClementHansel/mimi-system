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

export class PurchaseOrderLineDto {
  @IsUUID()
  itemId!: string;

  @IsString()
  @Matches(QTY_RE)
  qtyOrdered!: string;

  @IsUUID()
  unitId!: string;

  @IsString()
  @Matches(MONEY_RE)
  unitPrice!: string;
}

export class CreatePurchaseOrderDto {
  @IsUUID()
  supplierId!: string;

  @IsUUID()
  locationId!: string;

  @IsOptional()
  @IsUUID()
  prId?: string;

  @IsDateString()
  orderDate!: string;

  @IsOptional()
  @IsDateString()
  expectedDate?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PurchaseOrderLineDto)
  lines!: PurchaseOrderLineDto[];

  @IsOptional()
  @IsString()
  notes?: string;
}

/**
 * Raises one payment voucher against a PO — a down payment before the goods
 * ship, or an instalment after (migration 268).
 *
 * No `isAdvance` field on purpose: whether this is uang muka is decided by
 * whether anything has been received yet, which the server knows and the
 * client must not be able to assert. Letting the caller claim it would let a
 * post-receipt payment route itself to 1130 Uang Muka and skip the payable
 * entirely.
 */
export class CreatePoPaymentDto {
  @IsString()
  @Matches(MONEY_RE)
  amount!: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class UpdatePurchaseOrderDto {
  @IsOptional()
  @IsDateString()
  orderDate?: string;

  @IsOptional()
  @IsDateString()
  expectedDate?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PurchaseOrderLineDto)
  lines?: PurchaseOrderLineDto[];

  @IsOptional()
  @IsString()
  notes?: string;
}

export class ListPurchaseOrderQueryDto {
  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

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

export class ApprovePurchaseOrderDto {
  @IsOptional()
  @IsString()
  note?: string;
}

export class RejectPurchaseOrderDto {
  @IsString()
  reason!: string;
}

export class CancelPurchaseOrderDto {
  @IsString()
  reason!: string;
}

export class PoReceiptLineDto {
  @IsUUID()
  poLineId!: string;

  @IsString()
  @Matches(QTY_RE)
  qtyReceived!: string;

  @IsUUID()
  storageAreaId!: string;

  @IsOptional()
  @IsString()
  conditionNotes?: string;
}

export class CreatePoReceiptDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PoReceiptLineDto)
  lines!: PoReceiptLineDto[];

  /** Wajib foto (FR-PO-04). */
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID('4', { each: true })
  photoAttachmentIds!: string[];

  @IsOptional()
  @IsString()
  notes?: string;
}
