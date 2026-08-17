import { Type } from 'class-transformer';
import { ArrayMinSize, IsOptional, IsString, IsUUID, Matches, ValidateNested } from 'class-validator';

/** `Qty` wire format (CONTRACTS.md §0): a decimal string, up to 3 places, `NUMERIC(14,3)`. */
const QTY_PATTERN = /^-?\d{1,11}(\.\d{1,3})?$/;

export class OpnameLineInputDto {
  @IsUUID()
  storageAreaId!: string;

  @IsUUID()
  itemId!: string;

  @IsString()
  @Matches(QTY_PATTERN, { message: 'countedQty must be a decimal string with up to 3 places' })
  countedQty!: string;

  @IsOptional()
  @IsString()
  varianceReason?: string;
}

/** `PUT /api/stock-opname/:id/lines` — one batch = one storage area (CONTRACTS.md §4.8). */
export class UpsertOpnameLinesDto {
  @ValidateNested({ each: true })
  @Type(() => OpnameLineInputDto)
  @ArrayMinSize(1)
  lines!: OpnameLineInputDto[];
}
