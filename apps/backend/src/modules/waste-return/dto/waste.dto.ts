import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';
import { WasteReason } from '@mimi/shared';

const QTY_RE = /^\d+(\.\d{1,3})?$/;

export class WasteItemDto {
  @IsUUID()
  storageAreaId!: string;

  @IsUUID()
  itemId!: string;

  @IsString()
  @Matches(QTY_RE)
  qty!: string;

  @IsIn(Object.values(WasteReason))
  reason!: WasteReason;

  @IsOptional()
  @IsString()
  reasonDetail?: string;
}

export class CreateWasteDto {
  @IsUUID()
  locationId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => WasteItemDto)
  items!: WasteItemDto[];

  /** Wajib foto (FR-WST-01) — at least one. */
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID('4', { each: true })
  photoAttachmentIds!: string[];
}

export class ListWasteQueryDto {
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
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

export class ApproveWasteDto {
  @IsOptional()
  @IsString()
  note?: string;
}

export class RejectWasteDto {
  @IsString()
  reason!: string;
}
