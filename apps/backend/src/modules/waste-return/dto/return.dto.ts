import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';
import { ReturnCondition, ReturnDirection } from '@mimi/shared';

const QTY_RE = /^\d+(\.\d{1,3})?$/;

export class ReturnLineDto {
  @IsUUID()
  itemId!: string;

  @IsUUID()
  storageAreaId!: string;

  @IsString()
  @Matches(QTY_RE)
  qty!: string;

  @IsIn(Object.values(ReturnCondition))
  condition!: ReturnCondition;

  @IsString()
  reason!: string;
}

export class CreateReturnDto {
  @IsIn(Object.values(ReturnDirection))
  direction!: ReturnDirection;

  @IsUUID()
  fromLocationId!: string;

  @IsOptional()
  @IsUUID()
  toLocationId?: string;

  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReturnLineDto)
  lines!: ReturnLineDto[];

  /** Wajib foto. */
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID('4', { each: true })
  photoAttachmentIds!: string[];
}

export class ListReturnQueryDto {
  @IsOptional()
  @IsIn(Object.values(ReturnDirection))
  direction?: ReturnDirection;

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

export class ApproveReturnDto {
  @IsOptional()
  @IsString()
  note?: string;
}

export class RejectReturnDto {
  @IsString()
  reason!: string;
}

export class ShipReturnDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID('4', { each: true })
  proofAttachmentIds!: string[];
}

export class ReceiveReturnLineDto {
  @IsUUID()
  lineId!: string;

  @IsString()
  @Matches(QTY_RE)
  qtyReceived!: string;

  @IsUUID()
  storageAreaId!: string;
}

export class ReceiveReturnDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReceiveReturnLineDto)
  lines!: ReceiveReturnLineDto[];

  @IsArray()
  @ArrayMinSize(1)
  @IsUUID('4', { each: true })
  proofAttachmentIds!: string[];
}

export class CompleteReturnDto {
  @IsOptional()
  @IsDateString()
  supplierAcceptedAt?: string;

  @IsOptional()
  @IsString()
  creditNoteRef?: string;
}
