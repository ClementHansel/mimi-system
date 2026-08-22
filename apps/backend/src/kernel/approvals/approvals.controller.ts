import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import {
  ApprovalDocumentType,
  type ApprovalDetail,
  type Paginated,
  type RoleKey,
  type UUID,
} from '@mimi/shared';
import { Audited, RequirePermission } from '../../common/decorators';
import type { RequestWithDbContext } from '../../common/guards/rls-context.guard';
import { ApprovalCodeService, type IssuedCode } from './approval-code.service';
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
 * The two READS carry no `@RequirePermission()` — CONTRACTS marks both rows
 * "(any; filtered to caller's role+locations)": every authenticated user may
 * call them, and the response is naturally scoped by `ApprovalService`
 * (role-eligibility + location) rather than gated by a permission key.
 *
 * The third route (`POST :documentType/:documentId/code`, B-15) is a WRITE and
 * is gated, both by a permission key and by a step-eligibility check inside the
 * service. It lives here rather than on each owning module — unlike
 * approve/reject, whose side effects are module-local — because minting a code
 * has no side effect beyond the code itself, and one implementation is what
 * keeps every document type's authorization step identical.
 */
@Controller('approvals')
export class ApprovalsController {
  constructor(
    private readonly approvals: ApprovalService,
    private readonly codes: ApprovalCodeService,
  ) {}

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

  /**
   * B-15 — the approver authorises a document and receives a ONE-TIME code to
   * relay to whoever is holding it open (owner decision Q8, 2026-08-22). This
   * endpoint replaced `POST /auth/pin/verify`, which has been deleted: there is
   * no longer any way to ask the server whether a guessed PIN is correct.
   *
   * `@RequirePermission('approval.code.issue')` is the coarse gate. The real one
   * is inside `ApprovalCodeService.issue`, which refuses unless this caller is
   * an eligible approver for THIS document's current step (§5.2). A permission
   * key cannot express that, and restating the state machine in a grant table
   * would be a second copy to get wrong.
   *
   * `@Audited` matters more here than on most routes: issuing a code IS the
   * authorization act, so this row is the audit trail for "who approved it",
   * written whether or not the code is ever redeemed. The `@Audited` diff
   * captures the request, never the response, so the code itself is not
   * written to `audit_log`.
   */
  @Post(':documentType/:documentId/code')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('approval.code.issue')
  @Audited({ entityType: 'approvals', action: 'approval.code.issue' })
  async issueCode(
    @Req() req: RequestWithDbContext,
    @Param('documentType') documentType: ApprovalDocumentType,
    @Param('documentId') documentId: UUID,
  ): Promise<IssuedCode> {
    const result = await this.codes.issue(req.dbClient!, {
      documentType,
      documentId,
      approver: { userId: req.user!.sub as UUID, roleKey: req.user!.roleKey as RoleKey },
    });
    // The code row is a real write and this controller is one of the ones that
    // must commit its own transaction — see "THE BIG ONE" in docs/PROGRESS.md:
    // `RlsCleanupInterceptor` rolls back unconditionally, so a write that never
    // commits returns 200 and vanishes.
    await req.dbClient!.query('COMMIT');
    return result;
  }
}
