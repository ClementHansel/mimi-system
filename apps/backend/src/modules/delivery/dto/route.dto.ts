import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/** One stop in the dispatcher's planned order. Position in the array IS the
 * stop order — the client never sends `dropSeq`, because two sources of truth
 * for "which is stop 3" is exactly how a route ends up numbered 1, 2, 2, 4. */
export class PlanRouteStopDto {
  @IsUUID()
  dropId!: string;

  /**
   * Per-stop delivery brief. Omit the field to leave any existing brief
   * untouched (the service COALESCEs), or send an empty string to clear it —
   * a dispatcher reordering stops should not silently wipe notes they wrote
   * yesterday just because the reorder payload did not repeat them.
   */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  deliveryInstructions?: string;
}

export class PlanRouteDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PlanRouteStopDto)
  stops!: PlanRouteStopDto[];
}

export class SetDropInstructionsDto {
  /** Null clears the brief. Distinct from omitting it in `PlanRouteStopDto`:
   * this endpoint's whole purpose is to set this one field, so a missing value
   * can only mean "clear". */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  deliveryInstructions?: string | null;
}
