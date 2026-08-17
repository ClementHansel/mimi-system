import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

/** `GET /api/replenishment/queue/warehouse` (CONTRACTS.md §4.9) — the warehouse work queue. */
export class WarehouseQueueQueryDto {
  @IsOptional()
  @IsIn(['awaiting_approval', 'approved', 'processing'])
  status?: 'awaiting_approval' | 'approved' | 'processing';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number = 50;
}
