import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsOptional, IsUUID, Matches, ValidateNested } from 'class-validator';

/** `NUMERIC(14,3)` decimal-string shape (D-10) — up to 3 fractional digits, optional leading `-` (min_qty/reorder_qty are never negative in practice, but the DB CHECK on `min_qty >= 0` is the real gate; this regex only rejects garbage like `"12"` won't fail — plain integers ARE valid decimal strings too, "-" is allowed here so a bad request reads as ERR_VALIDATION not a DB CHECK 500). */
const QTY_PATTERN = /^-?\d+(\.\d{1,3})?$/;

export class MinStockRuleUpsertLine {
  @IsUUID()
  itemId!: string;

  @Matches(QTY_PATTERN, { message: 'minQty must be a decimal string with up to 3 fractional digits, e.g. "12.500"' })
  minQty!: string;

  @IsOptional()
  @Matches(QTY_PATTERN, { message: 'reorderQty must be a decimal string with up to 3 fractional digits, e.g. "20.000"' })
  reorderQty?: string;
}

/** `PUT /api/inventory/min-stock` body (CONTRACTS.md §4.7) — bulk upsert, one location at a time. */
export class UpsertMinStockDto {
  @IsUUID()
  locationId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => MinStockRuleUpsertLine)
  rules!: MinStockRuleUpsertLine[];
}
