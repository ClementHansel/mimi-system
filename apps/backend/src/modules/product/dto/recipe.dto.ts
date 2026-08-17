import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsString, IsUUID, Matches, ValidateNested } from 'class-validator';

/** NUMERIC(14,3) decimal-string pattern (Qty wire type, CONTRACTS.md §0). */
const QTY_RE = /^\d+(\.\d{1,3})?$/;

export class RecipeLineDto {
  @IsUUID()
  itemId!: string;

  @IsString()
  @Matches(QTY_RE)
  qty!: string;

  @IsUUID()
  unitId!: string;
}

/** `PUT /api/products/:id/recipe` body (CONTRACTS.md §4.5, FR-POS-06) — full replace of the BOM. */
export class PutRecipeDto {
  @IsString()
  @Matches(QTY_RE)
  yieldQty!: string;

  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => RecipeLineDto)
  lines!: RecipeLineDto[];
}
