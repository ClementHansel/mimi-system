import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { IsQtyString } from '../qty.validator';

/**
 * One amended line (CONTRACTS.md §4.9 `POST /:id/approve`). `reason` is
 * REQUIRED here, per line — FR-LOG-13's fraud-vector concern ("who changed
 * what, from what, to what, and why") is about the qty change on THIS line
 * specifically, not a single blanket reason for the whole request.
 */
export class ReplenishmentAmendmentDto {
  @IsUUID()
  lineId!: string;

  @IsQtyString()
  qtyApproved!: string;

  @IsString()
  @IsNotEmpty()
  reason!: string;
}

/** `POST /api/replenishment/:id/approve` — one endpoint for both chain steps (CONTRACTS.md §4.9); which step applies is resolved from the document's own current status, not from anything in this body. */
export class ApproveReplenishmentDto {
  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReplenishmentAmendmentDto)
  amendments?: ReplenishmentAmendmentDto[];
}
