import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class ListActiveQueryDto {
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  active?: boolean;
}

/** `POST /api/delivery/drivers` body (D-14). */
export class CreateDriverDto {
  @IsString()
  @MaxLength(255)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  licenseNumber?: string;

  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @IsOptional()
  @IsUUID()
  userId?: string;
}

export class UpdateDriverDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  licenseNumber?: string;

  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

const VEHICLE_TYPES = ['van', 'truck', 'pickup', 'motorcycle'] as const;

/** `POST /api/delivery/vehicles` body (D-14). */
export class CreateVehicleDto {
  @IsString()
  @MaxLength(20)
  plateNumber!: string;

  @IsOptional()
  @IsIn(VEHICLE_TYPES)
  type?: (typeof VEHICLE_TYPES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(100)
  brand?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  model?: string;

  @IsOptional()
  @IsBoolean()
  hasFreezer?: boolean;
}

export class UpdateVehicleDto {
  @IsOptional()
  @IsString()
  @MaxLength(20)
  plateNumber?: string;

  @IsOptional()
  @IsIn(VEHICLE_TYPES)
  type?: (typeof VEHICLE_TYPES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(100)
  brand?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  model?: string;

  @IsOptional()
  @IsBoolean()
  hasFreezer?: boolean;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
