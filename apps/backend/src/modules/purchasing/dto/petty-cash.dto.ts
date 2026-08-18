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

export class PettyCashLineDto {
  @IsString()
  description!: string;

  @IsOptional()
  @IsUUID()
  itemId?: string;

  @IsOptional()
  @IsUUID()
  storageAreaId?: string;

  @IsOptional()
  @IsString()
  @Matches(QTY_RE)
  qty?: string;

  @IsString()
  @Matches(MONEY_RE)
  amount!: string;

  @IsString()
  expenseCategory!: string;
}

export class CreatePettyCashDto {
  @IsUUID()
  locationId!: string;

  @IsDateString()
  purchaseDate!: string;

  @IsString()
  storeName!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PettyCashLineDto)
  lines!: PettyCashLineDto[];

  /** Wajib foto — bukti pembayaran (8.6.1). */
  @IsUUID()
  paymentProofAttachmentId!: string;

  /** Wajib foto — foto barang (8.6.1). */
  @IsUUID()
  goodsPhotoAttachmentId!: string;
}

export class ListPettyCashQueryDto {
  @IsOptional()
  @IsUUID()
  locationId?: string;

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

export class VerifyPettyCashDto {
  @IsOptional()
  @IsString()
  note?: string;
}

export class RejectPettyCashDto {
  @IsString()
  reason!: string;
}
