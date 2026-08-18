import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import {
  ApprovalDocumentType,
  type ApprovalDetail,
  type Paginated,
  type RoleKey,
} from '@mimi/shared';
import type { RequestWithDbContext } from '../../common/guards/rls-context.guard';
import { ApprovalService } from './approvals.service';
import { ListPendingApprovalsQueryDto } from './dto/list-pending-approvals.query';
import type { PendingApprovalRow } from './types';

/**
 * The two kernel-owned approval endpoints (CONTRACTS.md §4.0). Every other
 * approval action (`approve`/`reject`/`amend`) is exposed **per document
 * type on the owning module** (`/api/replenishment/:id/approve`, etc. —
 * CONTRACTS §4.0: "so permissions and side effects stay module-local"); this
 * controller only serves the two read surfaces that are genuinely
 * cross-document: "my pending approvals" and one approval's detail/history.
 *
 * No `@RequirePermission()` — CONTRACTS marks both rows "(any; filtered to
 * caller's role+locations)": every authenticated user may call them, and the
 * response is naturally scoped by `ApprovalService` (role-eligibility +
 * location) rather than gated by a permission key.
 */
@Controller('approvals')
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalService) {}

  @Get('pending')
  async pending(
    @Req() req: RequestWithDbContext & Request,
    @Query() query: ListPendingApprovalsQueryDto,
  ): Promise<Paginated<PendingApprovalRow>> {
    const user = req.user!;
    return this.approvals.getPending(
      req.dbClient!,
      {
        userId: user.sub,
        roleKey: user.roleKey as RoleKey,
        locationIds: req.locationScope ?? null,
      },
      { documentType: query.documentType, page: query.page ?? 1, pageSize: query.pageSize ?? 50 },
    );
  }

  @Get(':documentType/:documentId')
  async detail(
    @Req() req: RequestWithDbContext,
    @Param('documentType') documentType: ApprovalDocumentType,
    @Param('documentId') documentId: string,
  ): Promise<ApprovalDetail> {
    const row = await this.approvals.getDetail(req.dbClient!, documentType, documentId);
    return {
      approvalId: row.approvalId,
      state: row.state,
      amount: row.amount,
      // null once the chain is finalised — the documented "complete" signal (see @mimi/shared ApprovalDetail).
      currentStep: row.currentStep,
      steps: row.steps.map((s) => ({
        stepNo: s.stepNo,
        approverRole: s.approverRole,
        state: s.state,
        actedBy: s.actedBy,
        actedAt: s.actedAt,
        reason: s.reason,
        offlineAuthorized: s.offlineAuthorized,
        reverificationStatus: s.reverificationStatus,
      })),
    };
  }
}
