import { IsNotEmpty, IsString } from 'class-validator';

/** `POST /api/stock-opname/:id/reject` — reason required (CONTRACTS.md §4.8). */
export class RejectOpnameDto {
  @IsString()
  @IsNotEmpty()
  reason!: string;
}
