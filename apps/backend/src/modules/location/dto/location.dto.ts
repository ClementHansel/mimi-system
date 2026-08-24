import { Type } from 'class-transformer';
import {
  ValidateIf,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  Validate,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from 'class-validator';
import { LocationType } from '@mimi/shared';

/** Decimal-string pattern for NUMERIC(9,6) lat/lng — optional leading `-`, at least one digit. */
const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

/**
 * `code` appears in Surat Jalan and receipt document numbers (CONTRACTS.md
 * §4.3) — uppercase-only so a printed document never shows a code that looks
 * different from the master-data record an admin typed. Uniqueness is
 * enforced by the DB's `locations.code` UNIQUE constraint (migration 002);
 * immutability after creation is enforced in `LocationService.update()`, not
 * here, because `UpdateLocationDto.code` must still be WHITELISTED (an
 * unchanged `code` echoed back by an edit form must not 400).
 */
const CODE_RE = /^[A-Z0-9_-]+$/;

/**
 * Range check for a NUMERIC(9,6) lat/lng string. Runs only when a value is
 * present — `@IsOptional()` on the field already skips undefined/null, but a
 * plain string still needs `Number.isFinite` because `Number('')` is `0`
 * (would otherwise pass) and `Number('abc')` is `NaN` (already caught by
 * `@Matches(DECIMAL_RE)`, but this stays defensive as a standalone check).
 */
@ValidatorConstraint({ name: 'decimalInRange' })
class DecimalInRangeConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    if (value === undefined || value === null || value === '') return true;
    if (typeof value !== 'string') return false;
    const [min, max] = args.constraints as [number, number];
    const n = Number(value);
    return Number.isFinite(n) && n >= min && n <= max;
  }

  defaultMessage(args: ValidationArguments): string {
    const [min, max] = args.constraints as [number, number];
    return `${args.property} must be between ${min} and ${max}`;
  }
}

function IsDecimalInRange(min: number, max: number) {
  return Validate(DecimalInRangeConstraint, [min, max]);
}

/**
 * Rejects the (0, 0) "null island" coordinate pair — the single most common
 * bad-data shape (a blank map picker, a form submitted before geolocation
 * resolved) and one that silently breaks clock-in for the whole location
 * rather than failing loudly. Only fires once BOTH fields are present and
 * parse to exactly zero; a request touching only one of the two fields is
 * left to whatever the other one already is in the DB (the service layer's
 * problem, not a single-object DTO's).
 */
@ValidatorConstraint({ name: 'notNullIsland' })
class NotNullIslandConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const obj = args.object as { latitude?: string | null; longitude?: string | null };
    if (
      obj.latitude == null ||
      obj.longitude == null ||
      obj.latitude === '' ||
      obj.longitude === ''
    )
      return true;
    const lat = Number(obj.latitude);
    const lng = Number(obj.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return true; // other validators cover this
    return !(lat === 0 && lng === 0);
  }

  defaultMessage(): string {
    return 'latitude/longitude cannot both be 0 (null island) — check the coordinates, this almost always means the geolocation capture failed silently';
  }
}

/** `GET /api/locations?type=&city=&active=&page=` (CONTRACTS.md §4.3). */
export class ListLocationsQueryDto {
  @IsOptional()
  @IsIn(Object.values(LocationType))
  type?: LocationType;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  active?: boolean;

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

/** `POST /api/locations` body (CONTRACTS.md §4.3). */
export class CreateLocationDto {
  @IsString()
  @MaxLength(20)
  @Matches(CODE_RE)
  code!: string;

  @IsString()
  @MaxLength(255)
  name!: string;

  @IsIn(Object.values(LocationType))
  type!: LocationType;

  @IsString()
  @MaxLength(100)
  city!: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @IsOptional()
  @IsString()
  @Matches(DECIMAL_RE)
  @IsDecimalInRange(-90, 90)
  @Validate(NotNullIslandConstraint)
  latitude?: string;

  @IsOptional()
  @IsString()
  @Matches(DECIMAL_RE)
  @IsDecimalInRange(-180, 180)
  longitude?: string;

  /**
   * Attendance geofence radius in metres, or NULL to INHERIT the
   * `hr.geofence_radius_m` default (200 m — migration 229). Nullable on
   * purpose: `undefined` (omitted) means "leave it as it is", and without an
   * explicit null there would be no way to remove an override once set.
   */
  @IsOptional()
  @ValidateIf((o: { geofenceRadiusM?: number | null }) => o.geofenceRadiusM !== null)
  @IsInt()
  @Min(0)
  geofenceRadiusM?: number | null;
}

/**
 * `PATCH /api/locations/:id` body — partial of `CreateLocationDto`
 * (CONTRACTS.md §4.3).
 *
 * `code` stays here (rather than being dropped) so an edit form that echoes
 * the location's UNCHANGED code back in its PATCH body — which is exactly
 * what the admin form does — is not rejected outright by the global
 * `forbidNonWhitelisted` ValidationPipe. `LocationService.update()` is what
 * actually enforces immutability: it 400s only when the submitted `code`
 * differs from the stored one.
 */
export class UpdateLocationDto {
  @IsOptional()
  @IsString()
  @MaxLength(20)
  @Matches(CODE_RE)
  code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsIn(Object.values(LocationType))
  type?: LocationType;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string;

  @IsOptional()
  @IsString()
  address?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string | null;

  @IsOptional()
  @IsString()
  @Matches(DECIMAL_RE)
  @IsDecimalInRange(-90, 90)
  @Validate(NotNullIslandConstraint)
  latitude?: string | null;

  @IsOptional()
  @IsString()
  @Matches(DECIMAL_RE)
  @IsDecimalInRange(-180, 180)
  longitude?: string | null;

  /**
   * Attendance geofence radius in metres, or NULL to INHERIT the
   * `hr.geofence_radius_m` default (200 m — migration 229). Nullable on
   * purpose: `undefined` (omitted) means "leave it as it is", and without an
   * explicit null there would be no way to remove an override once set.
   */
  @IsOptional()
  @ValidateIf((o: { geofenceRadiusM?: number | null }) => o.geofenceRadiusM !== null)
  @IsInt()
  @Min(0)
  geofenceRadiusM?: number | null;
}
