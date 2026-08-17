import { IsOptional, IsString } from 'class-validator';

/** `POST /api/stock-opname/:id/approve` — online-only (§7.6). */
export class ApproveOpnameDto {
  @IsOptional()
  @IsString()
  note?: string;
}
