/** Request DTOs — M20 `settings` (CONTRACTS.md §4.20). */
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDefined,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ApprovalMode, RBAC_ROLE_ORDER, type RoleKey } from '@mimi/shared';

const ROLE_KEYS = RBAC_ROLE_ORDER as readonly string[];
const APPROVAL_MODES = Object.values(ApprovalMode) as readonly string[];

export class ListSettingsQueryDto {
  @IsOptional()
  @IsString()
  prefix?: string;
}

export class PutSettingDto {
  @IsDefined()
  value!: unknown;
}

export class ChainStepDto {
  @IsInt()
  @Min(1)
  stepNo!: number;

  @IsIn(ROLE_KEYS)
  approverRole!: RoleKey;

  @IsOptional()
  @IsString()
  minAmount?: string;

  @IsOptional()
  @IsString()
  maxAmount?: string;
}

export class PutApprovalChainDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ChainStepDto)
  steps!: ChainStepDto[];
}

/** D-23 — `PUT /api/settings/approval-modes/:documentType`. Owner-only (`settings.approval_mode.manage`). */
export class PutApprovalModeDto {
  @IsIn(APPROVAL_MODES)
  mode!: ApprovalMode;
}

/**
 * `PUT /api/settings/email` — a tenant's own SMTP (migration 264).
 *
 * `password` is OPTIONAL on purpose: the GET returns a mask, so a client
 * editing only the port sends no password and the stored one is kept.
 */
export class PutEmailSettingsDto {
  @IsString()
  @MaxLength(255)
  host!: string;

  @IsInt()
  @Min(1)
  @Max(65535)
  port!: number;

  @IsBoolean()
  secure!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  username?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  password?: string;

  @IsEmail()
  @MaxLength(255)
  fromEmail!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  fromName?: string;

  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;
}
