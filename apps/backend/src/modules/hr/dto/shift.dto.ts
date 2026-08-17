import { ArrayMinSize, IsArray, IsDateString, IsInt, IsOptional, IsString, IsUUID, Matches, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** `POST /api/hr/shifts` — CONTRACTS.md §4.14. */
export class CreateShiftDto {
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsString()
  name!: string;

  @Matches(HHMM, { message: 'startTime must be HH:mm' })
  startTime!: string;

  @Matches(HHMM, { message: 'endTime must be HH:mm' })
  endTime!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  breakMinutes?: number;
}

/** `PATCH /api/hr/shifts/:id` — partial. */
export class UpdateShiftDto {
  @IsOptional()
  @IsUUID()
  locationId?: string | null;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @Matches(HHMM, { message: 'startTime must be HH:mm' })
  startTime?: string;

  @IsOptional()
  @Matches(HHMM, { message: 'endTime must be HH:mm' })
  endTime?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  breakMinutes?: number;

  @IsOptional()
  isActive?: boolean;
}

export class RosterAssignmentDto {
  @IsUUID()
  employeeId!: string;

  @IsDateString()
  date!: string;

  /** `null` = libur (day off). */
  @IsOptional()
  @IsUUID()
  workShiftId?: string | null;
}

/** `PUT /api/hr/roster` — bulk upsert, CONTRACTS.md §4.14. */
export class UpsertRosterDto {
  @IsUUID()
  locationId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => RosterAssignmentDto)
  assignments!: RosterAssignmentDto[];
}
