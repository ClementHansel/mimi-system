import { IsISO8601, IsOptional, IsUUID } from 'class-validator';

/** `GET /api/pos/catalog?locationId=` — CONTRACTS.md §4.13, FR-POS-01. */
export class CatalogQueryDto {
  @IsOptional()
  @IsUUID()
  locationId?: string;
}

/** `GET /api/pos/daily-stock?locationId=&date=` — CONTRACTS.md §4.13, FR-POS-06. */
export class DailyStockQueryDto {
  @IsUUID()
  locationId!: string;

  @IsISO8601()
  date!: string;
}
