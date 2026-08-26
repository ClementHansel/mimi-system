import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';

/** NUMERIC(14,3) decimal-string pattern (Qty wire type, CONTRACTS.md §0). */
const QTY_RE = /^\d+(\.\d{1,3})?$/;

export class PackageLineDto {
  @IsUUID()
  memberProductId!: string;

  /** How many of this member one package contains — `2.000` for a two-piece bundle. */
  @IsString()
  @Matches(QTY_RE)
  qty!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

/**
 * `PUT /api/products/:id/package` body — full replace of the membership, the
 * same all-or-nothing shape `PUT .../recipe` uses.
 *
 * `ArrayMinSize(1)`: a package with no members is a sellable that consumes no
 * stock and shows an empty composition on the receipt. If someone wants that,
 * they want a plain product — which is `PATCH /products/:id { kind: 'product' }`,
 * an explicit choice rather than an accident of an empty form submit.
 */
export class PutPackageDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => PackageLineDto)
  lines!: PackageLineDto[];
}
