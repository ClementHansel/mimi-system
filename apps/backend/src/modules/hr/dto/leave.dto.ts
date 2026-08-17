import { IsDateString, IsIn, IsOptional, IsString, IsUUID } from 'class-validator';
import { LeaveType } from '@mimi/shared';

/** `POST /api/hr/leaves` — CONTRACTS.md §4.14. */
export class SubmitLeaveDto {
  @IsUUID()
  clientId!: string;

  @IsIn(Object.values(LeaveType))
  type!: LeaveType;

  @IsDateString()
  startDate!: string;

  @IsDateString()
  endDate!: string;

  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @IsUUID()
  attachmentId?: string;
}

export class ApproveLeaveDto {
  @IsOptional()
  @IsString()
  note?: string;
}

export class RejectLeaveDto {
  @IsString()
  reason!: string;
}
