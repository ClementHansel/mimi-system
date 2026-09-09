import { IsIn, IsISO8601, IsNumber, IsOptional, IsString, IsUUID, Matches } from 'class-validator';
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

/**
 * `POST /api/hr/attendance/absences` — record that a rostered employee did not
 * turn up (MA-200).
 *
 * A no-show leaves no `attendance` row, so `PATCH :id` has nothing to correct;
 * this is the only path that creates one. `correctionReason` is mandatory for
 * the same reason it is on `CorrectAttendanceDto` — the row costs the employee
 * a day's pay through POUT-03, so FR-AUDIT-02 wants a stated reason and a
 * named author.
 */
export class MarkAbsentDto {
  @IsUUID()
  employeeId!: string;

  /** The rostered date, `YYYY-MM-DD` — a calendar day, never a timestamp. */
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date!: string;

  @IsString()
  correctionReason!: string;
}
