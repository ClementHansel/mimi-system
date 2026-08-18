/** Request DTOs — M02 `users` (CONTRACTS.md §4.2). Validated by the global `ValidationPipe`. */
import {
  ArrayUnique,
  IsArray,
  IsEmail,
  IsIn,
  IsOptional,
  IsPhoneNumber,
  IsString,
  IsUUID,
  Matches,
  MinLength,
} from 'class-validator';
import { RBAC_ROLE_ORDER, type RoleKey } from '@mimi/shared';

const ROLE_KEYS = RBAC_ROLE_ORDER as readonly string[];

/**
 * Query-string values arrive as plain strings — `active`/`page`/`pageSize`
 * are validated here as numeric/boolean-shaped strings and parsed to real
 * types in `UsersService.list` (avoids `class-transformer`'s unreliable
 * `Boolean('false') === true` / implicit-any-string-to-number pitfalls for
 * query DTOs).
 */
export class ListUsersQueryDto {
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsIn(ROLE_KEYS)
  roleKey?: RoleKey;

  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsIn(['true', 'false'])
  active?: 'true' | 'false';

  @IsOptional()
  @Matches(/^\d+$/)
  page?: string;

  @IsOptional()
  @Matches(/^\d+$/)
  pageSize?: string;
}

export class CreateUserDto {
  @IsString()
  @MinLength(3)
  username!: string;

  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsPhoneNumber()
  phone?: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsIn(ROLE_KEYS)
  roleKey!: RoleKey;

  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  locationIds!: string[];
}

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsPhoneNumber()
  phone?: string;
}

export class AssignRoleDto {
  @IsIn(ROLE_KEYS)
  roleKey!: RoleKey;
}

export class AssignLocationsDto {
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  locationIds!: string[];
}

export class ResetPasswordDto {
  @IsString()
  @MinLength(8)
  newPassword!: string;
}
