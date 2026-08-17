import { IsDateString } from 'class-validator';
import { FormatQueryDto } from './format.query';

/** `GET /api/reports/delivery-daily` query params (CONTRACTS.md §4.19, FR-LOG-04). */
export class DeliveryDailyQueryDto extends FormatQueryDto {
  @IsDateString()
  date!: string;
}
