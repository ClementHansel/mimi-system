import { IsIn, IsISO8601, IsNumber, IsOptional, IsString, IsUUID } from 'class-validator';
import { AttendanceStatus } from '@mimi/shared';

/** `POST /api/hr/attendance/check-in` and `/check-out` — identical shape, CONTRACTS.md §4.14. */
export class CheckAttendanceDto {
  @IsUUID()
  clientId!: string;

  @IsUUID()
  locationId!: string;

  @IsString()
  lat!: string;

  @IsString()
  lng!: string;

  @IsNumber()
  accuracyM!: number;

  /** wajib — StorageService-backed selfie attachment (FR-HR-01). */
  @IsUUID()
  selfieAttachmentId!: string;

  @IsOptional()
  @IsUUID()
  deviceId?: string;

  @IsOptional()
  @IsISO8601()
  at?: string;
}

/** `PATCH /api/hr/attendance/:id` — HR manual correction, FR-AUDIT-02. */
export class CorrectAttendanceDto {
  @IsOptional()
  @IsIn(Object.values(AttendanceStatus))
  status?: AttendanceStatus;

  @IsOptional()
  @IsISO8601()
  checkInAt?: string;

  @IsOptional()
  @IsISO8601()
  checkOutAt?: string;

  @IsString()
  correctionReason!: string;
}
