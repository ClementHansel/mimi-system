import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsDateString, IsOptional, ValidateNested } from 'class-validator';
import { CreateReplenishmentLineDto } from './create-replenishment.dto';

/** `PATCH /api/replenishment/:id` — draft only (CONTRACTS.md §4.9). Supplying `lines` replaces the whole set (simplest correct semantics for a draft that has no fulfilment history yet). */
export class UpdateReplenishmentDto {
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateReplenishmentLineDto)
  lines?: CreateReplenishmentLineDto[];

  @IsOptional()
  @IsDateString({ strict: true })
  neededBy?: string;
}
