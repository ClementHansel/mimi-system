import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsDefined,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ANOMALY_DETECTORS, type AnomalyDetectorKey } from '../anomalies/anomaly.types';

const DETECTORS = ANOMALY_DETECTORS as readonly string[];

/** `GET /api/dashboard/anomalies?from&to[&locationId][&includeReviewed]` */
export class AnomaliesQueryDto {
  @IsDateString({ strict: true })
  from!: string;

  @IsDateString({ strict: true })
  to!: string;

  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  includeReviewed?: boolean;
}

/** `GET /api/dashboard/anomalies/drilldown` — the finding's `ref`, plus the window. */
export class AnomalyDrillQueryDto {
  @IsIn(DETECTORS)
  detector!: AnomalyDetectorKey;

  @IsDateString({ strict: true })
  from!: string;

  @IsDateString({ strict: true })
  to!: string;

  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsDateString({ strict: true })
  date?: string;

  @IsOptional()
  @IsUUID()
  productId?: string;

  @IsOptional()
  @IsUUID()
  itemId?: string;

  @IsOptional()
  @IsUUID()
  opnameId?: string;

  @IsOptional()
  @IsUUID()
  runId?: string;

  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @IsOptional()
  @IsUUID()
  accountId?: string;
}

/** `POST /api/dashboard/anomalies/review` */
export class AnomalyReviewDto {
  @IsIn(DETECTORS)
  detector!: AnomalyDetectorKey;

  @IsString()
  @MinLength(1)
  @MaxLength(300)
  fingerprint!: string;

  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;

  /** `false` un-reviews. */
  @IsOptional()
  @IsBoolean()
  reviewed?: boolean;
}

/** `PUT /api/dashboard/anomalies/thresholds` — `{ thresholds: { <detector>: { <param>: number } } }`, validated per field by the service. */
export class PutAnomalyThresholdsDto {
  @IsDefined()
  @IsObject()
  thresholds!: Record<string, unknown>;
}
