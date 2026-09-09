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

  /**
   * Link this employee to a login, or `null` to unlink.
   *
   * `CreateEmployeeDto` has always carried this and `update` never did, which
   * left the link WRITE-ONCE and only at creation. Since `employees.user_id` is
   * the sole thing that makes `/me` work — absensi, slip gaji, cuti, pinjaman
   * and kontrak all read the employee behind the caller's account — any account
   * created after its employee record had a permanently dead Akun Saya, and the
   * empty screen's own advice ("Minta Admin SDM menghubungkan akun Anda dengan
   * data karyawan") named a repair no screen and no endpoint could perform.
   * Reported from production 2026-09-09 with `testing0001`/`testing0002`; 37
   * employees on that box had no login and could not be given one either.
   *
   * `null` unlinks deliberately: an account handed to a different person must be
   * detachable, or the only fix for a mis-link is SQL. `employees.user_id` is
   * UNIQUE, so one login maps to at most one employee and the swap has to be
   * unlink-then-link rather than two employees quietly sharing an account.
   */
  @IsOptional()
  @IsUUID()
  userId?: string | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => EmploymentChangeDto)
  employmentChange?: EmploymentChangeDto;
}
