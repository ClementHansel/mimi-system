import { IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsPositive, IsString } from 'class-validator';

/** `POST /api/assets/:id/schedules` — CONTRACTS.md §4.16 (FR-PMS-02). */
export class CreateScheduleDto {
  @IsString()
  name!: string;

  @IsIn(['days', 'months'])
  intervalType!: 'days' | 'months';

  @IsInt()
  @IsPositive()
  intervalValue!: number;

  @IsDateString()
  nextDueAt!: string;

  @IsOptional()
  @IsInt()
  reminderDaysBefore?: number;
}

/** `PATCH /api/assets/schedules/:scheduleId` — partial. */
export class UpdateScheduleDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsIn(['days', 'months'])
  intervalType?: 'days' | 'months';

  @IsOptional()
  @IsInt()
  @IsPositive()
  intervalValue?: number;

  @IsOptional()
  @IsDateString()
  nextDueAt?: string;

  @IsOptional()
  @IsDateString()
  lastDoneAt?: string;

  @IsOptional()
  @IsInt()
  reminderDaysBefore?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
