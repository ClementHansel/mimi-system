import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import { ShiftStatus } from '@mimi/shared';
import { IsMoneyString } from './common.dto';

/** `POST /api/pos/shifts/open` — CONTRACTS.md §4.13. */
export class OpenShiftDto {
  @IsUUID()
  clientId!: string;

  @IsUUID()
  locationId!: string;

  @IsOptional()
  @IsUUID()
  deviceId?: string;

  @IsMoneyString()
  openingCash!: string;

  @IsOptional()
  @IsISO8601()
  openedAt?: string;
}

/** `POST /api/pos/shifts/:id/close`. Cloud recomputes `expectedCash`/`cashVariance` — never trusts a client-declared total. */
export class CloseShiftDto {
  @IsMoneyString()
  closingCashCounted!: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsISO8601()
  closedAt?: string;
}

export class ShiftsCurrentQueryDto {
  @IsOptional()
  @IsUUID()
  deviceId?: string;

  @IsOptional()
  @IsUUID()
  locationId?: string;
}

export class ListShiftsQueryDto {
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsISO8601()
  date?: string;

  @IsOptional()
  @IsEnum(ShiftStatus)
  status?: ShiftStatus;

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
