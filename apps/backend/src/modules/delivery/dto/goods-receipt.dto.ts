import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  ValidateNested,
} from 'class-validator';

const QTY_RE = /^-?\d+(\.\d{1,3})?$/;

export class GoodsReceiptLineDto {
  @IsUUID()
  itemId!: string;

  @IsUUID()
  storageAreaId!: string;

  @IsString()
  @Matches(QTY_RE)
  qtyExpected!: string;

  @IsString()
  @Matches(QTY_RE)
  qtyReceived!: string;

  @IsOptional()
  @IsString()
  discrepancyReason?: string;
}

/**
 * `POST /api/delivery/goods-receipts` body — NOT in CONTRACTS.md §4.10's
 * literal endpoint table (only `goods_receipts`' DDL + its sync op
 * `recorded` are specified there); added here because BUILD-PLAN's Definition
 * of Done requires a blind receipt (`unmatched_delivery`) to be recordable
 * and reconcilable, and PRD 8.6.1's supplier-direct-to-outlet receiving needs
 * SOME online entry point. See the module report for the full justification
 * — flagged as a contract addition, not a silent scope change.
 */
export class CreateGoodsReceiptDto {
  @IsUUID()
  locationId!: string;

  @IsIn(['supplier_direct', 'unmatched_delivery'])
  receiptType!: 'supplier_direct' | 'unmatched_delivery';

  /** Optional link, e.g. a suspected `sj_drops.id` for a blind/unmatched receipt (C6 reconciliation). */
  @IsOptional()
  @IsUUID()
  refId?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => GoodsReceiptLineDto)
  lines!: GoodsReceiptLineDto[];

  /** Wajib foto. */
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID('4', { each: true })
  photoAttachmentIds!: string[];

  @IsOptional()
  @IsString()
  notes?: string;
}
