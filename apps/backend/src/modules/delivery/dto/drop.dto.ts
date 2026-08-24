import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { TempLogStage } from '@mimi/shared';

const TEMP_RE = /^-?\d+(\.\d{1})?$/;

export class DepartDropDto {
  @IsOptional()
  @IsISO8601()
  at?: string;

  @IsOptional()
  @IsString()
  @Matches(TEMP_RE)
  tempC?: string;
}

export class SealCheckDto {
  @IsUUID()
  sealId!: string;

  @IsIn(['verified_intact', 'broken'])
  status!: 'verified_intact' | 'broken';

  @IsOptional()
  @IsString()
  notes?: string;
}

export class ArriveDropDto {
  @IsOptional()
  @IsISO8601()
  at?: string;

  /** Required when the parent SJ's shipment type is `frozen` (D-14) — see `drop.service.ts`. */
  @IsOptional()
  @IsString()
  @Matches(TEMP_RE)
  tempC?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => SealCheckDto)
  sealCheck?: SealCheckDto;
}

export class ReceiveLineDto {
  @IsUUID()
  lineId!: string;

  @IsString()
  @Matches(/^-?\d+(\.\d{1,3})?$/)
  qtyReceived!: string;

  @IsUUID()
  receivedStorageAreaId!: string;

  @IsOptional()
  @IsString()
  discrepancyReason?: string;
}

/** `POST /api/delivery/drops/:dropId/receive` body — FR-LOG-14/15/16. Photo is wajib. */
export class ReceiveDropDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReceiveLineDto)
  lines!: ReceiveLineDto[];

  /** Wajib foto (FR-LOG-15) — at least one. */
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID('4', { each: true })
  photoAttachmentIds!: string[];

  @IsUUID()
  signatureAttachmentId!: string;

  @IsOptional()
  @IsString()
  @Matches(TEMP_RE)
  tempC?: string;

  @IsOptional()
  @IsString()
  discrepancyNotes?: string;
}

export class FailDropDto {
  @IsString()
  @MaxLength(500)
  reason!: string;

  /**
   * Wajib foto for the failure — the shuttered gate, the wrong address.
   *
   * Optional, and that is a compromise rather than an oversight. `receive`
   * mandates photos because a driver who reaches an open outlet can always take
   * one. A failure is often exactly the case where they cannot: no signal, a
   * dead battery at the end of a run. Refusing to record the failure at all is
   * worse than recording it without a picture, because the alternative a driver
   * reaches for is not "try harder", it is "mark it delivered".
   *
   * The UI asks for it every time and the report flags failures that arrive
   * without one.
   */
  @IsOptional()
  @IsUUID()
  photoAttachmentId?: string;
}

/** `POST /api/delivery/drops/:dropId/skip` — defer this drop within today's run. */
export class SkipDropDto {
  /**
   * Required, unlike most notes fields. The whole operational value of a skip
   * is the pattern it reveals — an outlet skipped every Friday is telling you
   * something — and a pattern of empty reasons reveals nothing.
   */
  @IsString()
  @MaxLength(500)
  reason!: string;
}

/** `POST /api/delivery/temperature-logs` body (D-14, OBJ-03). */
export class CreateTemperatureLogDto {
  @IsUUID()
  sjId!: string;

  @IsOptional()
  @IsUUID()
  dropId?: string;

  @IsIn(Object.values(TempLogStage))
  stage!: TempLogStage;

  @IsString()
  @Matches(TEMP_RE)
  tempC!: string;
}
