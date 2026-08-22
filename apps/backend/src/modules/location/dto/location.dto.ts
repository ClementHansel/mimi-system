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
} from 'class-validator';
import { LocationType } from '@mimi/shared';

/** Decimal-string pattern for NUMERIC(9,6) lat/lng — optional leading `-`, at least one digit. */
const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

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
  latitude?: string;

  @IsOptional()
  @IsString()
  @Matches(DECIMAL_RE)
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

/** `PATCH /api/locations/:id` body — partial of `CreateLocationDto` (CONTRACTS.md §4.3). */
export class UpdateLocationDto {
  @IsOptional()
  @IsString()
  @MaxLength(20)
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
  latitude?: string | null;

  @IsOptional()
  @IsString()
  @Matches(DECIMAL_RE)
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
