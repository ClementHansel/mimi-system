/** Request DTOs — D-18 statutory payroll wizard (CONTRACTS.md §4.15). */
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

const MONEY_RE = /^\d+(\.\d{1,2})?$/;
const PCT_RE = /^\d+(\.\d{1,3})?$/;

export class BpjsRowDto {
  @IsIn(['kesehatan', 'jht', 'jkk', 'jkm', 'jp'])
  program!: 'kesehatan' | 'jht' | 'jkk' | 'jkm' | 'jp';

  @Matches(PCT_RE)
  employerPct!: string;

  @Matches(PCT_RE)
  employeePct!: string;

  @IsOptional()
  @Matches(MONEY_RE)
  salaryFloor?: string;

  @IsOptional()
  @Matches(MONEY_RE)
  salaryCap?: string;

  @IsDateString()
  effectiveFrom!: string;
}

export class PutBpjsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => BpjsRowDto)
  rows!: BpjsRowDto[];
}

export class TerRowDto {
  @IsIn(['A', 'B', 'C'])
  category!: 'A' | 'B' | 'C';

  @Matches(MONEY_RE)
  bracketMin!: string;

  @IsOptional()
  @Matches(MONEY_RE)
  bracketMax?: string;

  @Matches(PCT_RE)
  ratePct!: string;
}

export class PutTerDto {
  @IsDateString()
  effectiveFrom!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => TerRowDto)
  rows!: TerRowDto[];
}

export class PtkpRowDto {
  @IsString()
  @MinLength(1)
  ptkpCode!: string;

  @Matches(MONEY_RE)
  annualAmount!: string;

  @IsIn(['A', 'B', 'C'])
  terCategory!: 'A' | 'B' | 'C';
}

export class PutPtkpDto {
  @IsDateString()
  effectiveFrom!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PtkpRowDto)
  rows!: PtkpRowDto[];
}

export class Article17RowDto {
  @Matches(MONEY_RE)
  bracketMin!: string;

  @IsOptional()
  @Matches(MONEY_RE)
  bracketMax?: string;

  @Matches(PCT_RE)
  ratePct!: string;
}

export class PutArticle17Dto {
  @IsDateString()
  effectiveFrom!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => Article17RowDto)
  rows!: Article17RowDto[];
}

export class BpjsEnrollmentDto {
  @IsDateString()
  enrolledSince!: string;

  @IsOptional()
  @IsDateString()
  endedAt?: string | null;
}

export class TaxProfileDto {
  @IsOptional()
  @IsString()
  npwp?: string | null;

  @IsString()
  @MinLength(1)
  ptkpCode!: string;

  @IsInt()
  @Min(0)
  @Max(3)
  dependantsCount!: number;

  @IsOptional()
  bpjsEnrollments?: Record<string, { enrolledSince: string; endedAt: string | null }>;

  @IsOptional()
  @Matches(MONEY_RE)
  bpjsSalaryBase?: string;
}

export class EnableStatutoryDto {
  @IsBoolean()
  confirm!: true;
}

export class DisableStatutoryDto {
  @IsString()
  @MinLength(1)
  reason!: string;
}
