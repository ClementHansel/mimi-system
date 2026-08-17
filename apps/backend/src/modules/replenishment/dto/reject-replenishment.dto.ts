import { IsNotEmpty, IsString } from 'class-validator';

/** `POST /api/replenishment/:id/reject` (CONTRACTS.md §4.9) — reason is mandatory (FR-LOG-13). */
export class RejectReplenishmentDto {
  @IsString()
  @IsNotEmpty()
  reason!: string;
}
