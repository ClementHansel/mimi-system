/** Request DTOs — M01 `auth` (CONTRACTS.md §4.1). Validated by the global `ValidationPipe` (`main.ts`). */
import { IsIn, IsOptional, IsString, IsUUID, Length, Matches, MinLength } from 'class-validator';

export class LoginDto {
  @IsString()
  @MinLength(1)
  username!: string;

  @IsString()
  @MinLength(1)
  password!: string;

  @IsOptional()
  @IsUUID()
  deviceId?: string;
}

export class RefreshDto {
  @IsString()
  @MinLength(1)
  refreshToken!: string;
}

export class LogoutDto {
  @IsString()
  @MinLength(1)
  refreshToken!: string;
}

export class SetPinDto {
  @IsString()
  @MinLength(1)
  currentPassword!: string;

  @IsString()
  @Length(6, 6)
  @Matches(/^\d{6}$/, { message: 'pin must be exactly 6 digits' })
  pin!: string;
}

export class VerifyPinDto {
  @IsUUID()
  userId!: string;

  @IsString()
  @Length(6, 6)
  @Matches(/^\d{6}$/, { message: 'pin must be exactly 6 digits' })
  pin!: string;

  @IsIn(['pos_override', 'approval'])
  context!: 'pos_override' | 'approval';
}

export class OfflineCredentialRefreshDto {
  @IsUUID()
  deviceId!: string;
}

export class RevokeCredentialDto {
  @IsString()
  @MinLength(1)
  reason!: string;
}
