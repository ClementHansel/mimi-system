import { ArrayMinSize, IsArray, IsIn, IsInt, IsNumberString, IsOptional, IsString, IsUUID } from 'class-validator';
import { AssetCondition } from '@mimi/shared';

/** `POST /api/assets/:id/jobs` — scheduled jobs are scheduler-born, only `corrective` is client-created. */
export class CreateJobDto {
  @IsIn(['corrective'])
  type!: 'corrective';

  @IsString()
  description!: string;

  @IsOptional()
  @IsUUID()
  assignedToEmployeeId?: string;
}

/** `POST /api/assets/jobs/:jobId/complete` — `proofAttachmentIds` (>=1) is FR-PMS-04's wajib-bukti-servis requirement. */
export class CompleteJobDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID('4', { each: true })
  proofAttachmentIds!: string[];

  @IsOptional()
  @IsNumberString()
  cost?: string;

  @IsOptional()
  @IsString()
  vendor?: string;

  @IsIn(Object.values(AssetCondition))
  conditionAfter!: AssetCondition;

  @IsOptional()
  @IsInt()
  odometerKm?: number;

  @IsOptional()
  @IsString()
  notes?: string;
}

/** `POST /api/assets/jobs/:jobId/verify` — Supervisor/Manager verifikasi. */
export class VerifyJobDto {
  @IsOptional()
  @IsString()
  note?: string;
}
