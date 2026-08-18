import {
  IsDateString,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { EmploymentStatus } from '@mimi/shared';

export class EmploymentChangeDto {
  @IsString()
  position!: string;

  @IsUUID()
  locationId!: string;

  @IsString()
  baseSalary!: string;

  @IsDateString()
  startDate!: string;
}

/** `POST /api/hr/employees` — CONTRACTS.md §4.14. */
export class CreateEmployeeDto {
  @IsString()
  employeeNumber!: string;

  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  nik?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsDateString()
  joinDate!: string;

  @IsString()
  position!: string;

  @IsUUID()
  locationId!: string;

  @IsString()
  baseSalary!: string;

  @IsOptional()
  @IsString()
  bankName?: string;

  @IsOptional()
  @IsString()
  bankAccountNumber?: string;

  @IsOptional()
  @IsString()
  bankAccountName?: string;

  @IsOptional()
  @IsUUID()
  userId?: string;
}

/** `PATCH /api/hr/employees/:id` — partial + optional `employmentChange` (appends `employments`). */
export class UpdateEmployeeDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  nik?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsDateString()
  birthDate?: string;

  @IsOptional()
  @IsIn(Object.values(EmploymentStatus))
  employmentStatus?: EmploymentStatus;

  @IsOptional()
  @IsString()
  bankName?: string;

  @IsOptional()
  @IsString()
  bankAccountNumber?: string;

  @IsOptional()
  @IsString()
  bankAccountName?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => EmploymentChangeDto)
  employmentChange?: EmploymentChangeDto;
}
