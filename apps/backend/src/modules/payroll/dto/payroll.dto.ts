import {
  IsArray,
  IsBoolean,
  IsIn,
  IsNumberString,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
} from 'class-validator';

/** `POST /api/payroll/periods` — CONTRACTS.md §4.15 (dates derived from the code). */
export class CreatePeriodDto {
  @Matches(/^\d{4}-\d{2}$/, { message: "periodCode must be 'YYYY-MM'" })
  periodCode!: string;
}

/** `POST /api/payroll/periods/:id/calculate` and `.../runs/:id/recalculate`. */
export class CalculatePeriodDto {
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  employeeIds?: string[];
}

/** `PATCH /api/payroll/runs/:id/lines/:lineId` — a manual override always needs a reason (FR-AUDIT-02). */
export class OverrideLineDto {
  @IsNumberString()
  amount!: string;

  @IsString()
  overrideReason!: string;
}

export class SubmitRunDto {}

export class ApproveRunDto {
  @IsOptional()
  @IsString()
  note?: string;
}

export class RejectRunDto {
  @IsString()
  reason!: string;
}

export class MarkPaidDto {
  @IsUUID()
  paymentVerificationId!: string;
}

export class SendSlipsDto {
  @IsArray()
  @IsIn(['email', 'whatsapp'], { each: true })
  channels!: ('email' | 'whatsapp')[];
}

// ── components ──────────────────────────────────────────────────────────────

export class CreateComponentDto {
  @IsString()
  code!: string;

  @IsString()
  name!: string;

  @IsIn(['earning', 'deduction'])
  type!: 'earning' | 'deduction';

  @IsIn(['fixed', 'per_day', 'per_hour', 'formula', 'manual'])
  calcMethod!: 'fixed' | 'per_day' | 'per_hour' | 'formula' | 'manual';

  @IsOptional()
  @IsNumberString()
  defaultAmount?: string;
}

export class UpdateComponentDto {
  @IsOptional()
  @IsNumberString()
  defaultAmount?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  name?: string;
}

export class EmployeeComponentAssignmentDto {
  @IsUUID()
  componentId!: string;

  @IsOptional()
  @IsNumberString()
  amount?: string | null;

  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  effectiveFrom!: string;
}

export class PutEmployeeComponentsDto {
  @IsArray()
  assignments!: EmployeeComponentAssignmentDto[];
}

// ── loans ────────────────────────────────────────────────────────────────────

export class CreateLoanDto {
  @IsUUID()
  employeeId!: string;

  @IsNumberString()
  principal!: string;

  @IsNumberString()
  monthlyInstallment!: string;

  @IsOptional()
  @IsString()
  reason?: string;
}

export class ApproveLoanDto {
  @IsOptional()
  @IsString()
  note?: string;
}

export class RejectLoanDto {
  @IsString()
  reason!: string;
}

// ── statutory (Amendment 1) ─────────────────────────────────────────────────

export class BpjsRowDto {
  @IsIn(['kesehatan', 'jht', 'jkk', 'jkm', 'jp'])
  program!: 'kesehatan' | 'jht' | 'jkk' | 'jkm' | 'jp';

  @IsNumberString()
  employerPct!: string;

  @IsNumberString()
  employeePct!: string;

  @IsOptional()
  @IsNumberString()
  salaryFloor?: string;

  @IsOptional()
  @IsNumberString()
  salaryCap?: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  effectiveFrom!: string;
}

export class PutBpjsDto {
  @IsArray()
  rows!: BpjsRowDto[];
}

export class TerRowDto {
  @IsIn(['A', 'B', 'C'])
  category!: 'A' | 'B' | 'C';

  @IsNumberString()
  bracketMin!: string;

  @IsOptional()
  @IsNumberString()
  bracketMax?: string;

  @IsNumberString()
  ratePct!: string;
}

export class PutTerDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  effectiveFrom!: string;

  @IsArray()
  rows!: TerRowDto[];
}

export class PtkpRowDto {
  @IsString()
  ptkpCode!: string;

  @IsNumberString()
  annualAmount!: string;

  @IsIn(['A', 'B', 'C'])
  terCategory!: 'A' | 'B' | 'C';
}

export class PutPtkpDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  effectiveFrom!: string;

  @IsArray()
  rows!: PtkpRowDto[];
}

export class Article17RowDto {
  @IsNumberString()
  bracketMin!: string;

  @IsOptional()
  @IsNumberString()
  bracketMax?: string;

  @IsNumberString()
  ratePct!: string;
}

export class PutArticle17Dto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  effectiveFrom!: string;

  @IsArray()
  rows!: Article17RowDto[];
}

export class BpjsEnrollmentDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  enrolledSince!: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  endedAt?: string | null;
}

export class PutTaxProfileDto {
  @IsOptional()
  @IsString()
  npwp?: string | null;

  @IsString()
  ptkpCode!: string;

  dependantsCount!: number;

  bpjsEnrollments!: Partial<Record<'kesehatan' | 'jht' | 'jkk' | 'jkm' | 'jp', BpjsEnrollmentDto>>;

  @IsOptional()
  @IsNumberString()
  bpjsSalaryBase?: string | null;
}

export class EnableStatutoryDto {
  @IsBoolean()
  confirm!: true;
}

export class DisableStatutoryDto {
  @IsString()
  reason!: string;
}
