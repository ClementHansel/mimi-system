import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

/**
 * `GET /api/inventory/history/:itemId` query params (CONTRACTS.md §4.7).
 * `locationId` is required here (unlike the other §4.7 read endpoints): a
 * day-by-day "closing balance" narrative is only meaningful anchored to one
 * location — summing several locations' closings would still add up
 * arithmetically, but the story the endpoint tells ("outlet X's stock of item
 * Y over time") stops being a single coherent series once several locations'
 * histories are folded into one.
 */
export class HistoryQueryDto {
  @IsUUID()
  locationId!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  days?: number;
}
