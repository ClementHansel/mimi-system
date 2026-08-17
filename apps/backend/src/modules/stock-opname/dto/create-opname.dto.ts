import { IsOptional, IsUUID } from 'class-validator';

/** `POST /api/stock-opname` (CONTRACTS.md §4.8, FR-SO-01). */
export class CreateOpnameDto {
  @IsUUID()
  locationId!: string;

  /** Omit to count the whole location (lines carry their own area, D-15). */
  @IsOptional()
  @IsUUID()
  storageAreaId?: string;
}
