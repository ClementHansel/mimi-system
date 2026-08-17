import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { ApprovalDocumentType } from '@mimi/shared';

/** `GET /api/approvals/pending?documentType=&page=` — CONTRACTS.md §4.0. Pagination convention: §0 (`page`/`pageSize`, max 200). */
export class ListPendingApprovalsQueryDto {
  @IsOptional()
  @IsEnum(ApprovalDocumentType)
  documentType?: ApprovalDocumentType;

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
