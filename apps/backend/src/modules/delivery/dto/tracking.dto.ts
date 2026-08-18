import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsISO8601,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class PositionFixDto {
  /** Minted on the DEVICE, one per fix — the idempotency key that makes a
   * re-sent offline batch a no-op instead of a duplicated trail. */
  @IsUUID()
  clientId!: string;

  @IsLatitude()
  latitude!: number;

  @IsLongitude()
  longitude!: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  accuracyM?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  speedKph?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(359.99)
  headingDeg?: number;

  /** When the DEVICE took the fix, not when it was sent. An offline batch
   * flushed an hour late must still plot on the trail at the time it happened. */
  @IsISO8601()
  recordedAt!: string;
}

export class RecordPositionsDto {
  /**
   * Batched because the driver PWA queues fixes through dead zones and flushes
   * them together. Capped at 200 so a phone returning from a long offline
   * stretch sends several bounded requests rather than one huge body that is
   * more likely to time out on a weak connection and be retried whole.
   */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => PositionFixDto)
  positions!: PositionFixDto[];
}
