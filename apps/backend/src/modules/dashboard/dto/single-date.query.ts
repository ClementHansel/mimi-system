import { IsDateString, IsOptional } from 'class-validator';

/** `?date=` — a single WITA calendar date (`'YYYY-MM-DD'`), defaults to "today" (WITA) when omitted. Used by `/outlets` and `/outlet/:locationId`. */
export class SingleDateQueryDto {
  @IsOptional()
  @IsDateString({ strict: true })
  date?: string;
}
