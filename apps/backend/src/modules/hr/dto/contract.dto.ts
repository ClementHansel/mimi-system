import { Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsNumberString,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Employment contract DTOs (W7). The four types are the Indonesian legal
 * shapes, not a free-text label:
 *
 *   pkwt       — fixed term (needs an end date)
 *   pkwtt      — permanent (must NOT have one)
 *   probation  — masa percobaan, capped at 3 months by law
 *   internship — magang / PKL
 *
 * The type↔term rule is validated in `ContractsService` (so the message names
 * the offending type) AND by a CHECK constraint in migration 230 (so no path
 * around the service can break it) — the expiry report is only as trustworthy
 * as those two together.
 */
export const CONTRACT_TYPES = ['pkwt', 'pkwtt', 'probation', 'internship'] as const;
export const CONTRACT_STATUSES = ['draft', 'active', 'expired', 'terminated'] as const;

export class CreateContractDto {
  @IsUUID()
  employeeId!: string;

  @IsIn(CONTRACT_TYPES)
  contractType!: (typeof CONTRACT_TYPES)[number];

  @IsString()
  @MaxLength(100)
  position!: string;

  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsNumberString()
  baseSalary?: string;

  @IsDateString()
  startDate!: string;

  /** Required for every type except `pkwtt`; see the file header. */
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsIn(CONTRACT_STATUSES)
  status?: (typeof CONTRACT_STATUSES)[number];

  @IsOptional()
  @IsDateString()
  signedAt?: string;

  /** The scanned, signed copy (an `attachments` row). */
  @IsOptional()
  @IsUUID()
  documentAttachmentId?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

/**
 * Every field optional: an omitted field means "leave it alone". `endDate` is
 * nullable so switching a PKWT to PKWTT can CLEAR the expiry, which `undefined`
 * could never express.
 */
export class UpdateContractDto {
  @IsOptional()
  @IsIn(CONTRACT_TYPES)
  contractType?: (typeof CONTRACT_TYPES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(100)
  position?: string;

  @IsOptional()
  @IsUUID()
  locationId?: string | null;

  @IsOptional()
  @IsNumberString()
  baseSalary?: string | null;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string | null;

  @IsOptional()
  @IsIn(CONTRACT_STATUSES)
  status?: (typeof CONTRACT_STATUSES)[number];

  @IsOptional()
  @IsDateString()
  signedAt?: string | null;

  @IsOptional()
  @IsUUID()
  documentAttachmentId?: string | null;

  @IsOptional()
  @IsString()
  notes?: string | null;
}

export const SIGNATURE_PARTIES = ['employee', 'company'] as const;
export const SIGNATURE_METHODS = ['wet_ink_scan', 'digital', 'in_person_witnessed'] as const;

/**
 * Records one party's signature (migration 252). `party: 'employee'` records
 * the contract's own employee; the person doing the recording is the
 * signature's `created_by`, never its subject — an employee cannot be made to
 * "sign" by someone else's say-so alone, this only records that they did.
 * `party: 'company'` records the CALLER (`req.user.sub`) as the company
 * signer — see `ContractsController.sign`'s doc comment for why there is no
 * separate "which user signed" field: the acting user IS the signer.
 */
export class SignContractDto {
  @IsIn(SIGNATURE_PARTIES)
  party!: (typeof SIGNATURE_PARTIES)[number];

  @IsIn(SIGNATURE_METHODS)
  method!: (typeof SIGNATURE_METHODS)[number];

  /** Defaults to now when omitted — e.g. backdating a scanned wet-ink signature. */
  @IsOptional()
  @IsDateString()
  signedAt?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class TerminateContractDto {
  /**
   * Mandatory. A contract ended early without a recorded reason is exactly the
   * record a later dispute turns on, and the DB CHECK refuses it anyway.
   */
  @IsString()
  reason!: string;

  /** Effective date; defaults to today (WITA) when omitted. */
  @IsOptional()
  @IsDateString()
  endDate?: string;
}

export class ListContractsQueryDto {
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @IsOptional()
  @IsIn(CONTRACT_STATUSES)
  status?: (typeof CONTRACT_STATUSES)[number];

  @IsOptional()
  @IsIn(CONTRACT_TYPES)
  contractType?: (typeof CONTRACT_TYPES)[number];

  /**
   * "What lapses in the next N days" — the one proactive question this table
   * exists to answer. Active, dated contracts only.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expiringWithinDays?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number;
}
