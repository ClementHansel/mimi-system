import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  ApprovalDocumentType,
  ERR_CONFLICT,
  ERR_FORBIDDEN,
  ERR_NOT_FOUND,
  ERR_VALIDATION,
  PurchaseRequestStatus,
  RoleKey,
  type ApprovalDetail,
  type Money,
  type Paginated,
  type Qty,
  type UUID,
} from '@mimi/shared';
import { formatDateOnly } from '../../common/date-only.util';
import { ApprovalService } from '../../kernel/approvals/approvals.service';
import { withWrite } from './db-tx';
import type {
  ApprovePurchaseRequestDto,
  CreatePurchaseRequestDto,
  ListPurchaseRequestQueryDto,
  RejectPurchaseRequestDto,
} from './dto/purchase-request.dto';
import { PurchaseRequestRepository } from './purchase-request.repository';

export interface ActorContext {
  userId: UUID;
  roleKey: RoleKey;
  locationScope: readonly UUID[] | null;
}

export interface PurchaseRequestListRow {
  id: UUID;
  prNumber: string;
  locationName: string;
  status: string;
  requestedBy: string;
  neededBy: string | null;
  lineCount: number;
}

export interface PurchaseRequestDetail {
  id: UUID;
  prNumber: string;
  locationId: UUID;
  locationName: string;
  status: string;
  requestedBy: string;
  neededBy: string | null;
  rejectionReason: string | null;
  notes: string | null;
  /**
   * CONTRACTS.md §4.11: `GET /api/purchasing/requests/:id` → "PR with lines
   * + `ApprovalDetail`" — DETAIL only (the list row's documented shape,
   * `{id; prNumber; locationName; status; requestedBy; neededBy;
   * lineCount}`, has no such field, so `PurchaseRequestListRow` above
   * intentionally omits it). Populated via `loadApprovalDetail` below,
   * mirroring `PurchaseOrderService`'s identical fix in this same ticket.
   */
  approval: ApprovalDetail | null;
  lines: {
    id: UUID;
    itemId: UUID;
    itemName: string;
    unitId: UUID;
    unitCode: string;
    qty: string;
    estPrice: string;
    suggestedSupplierId: UUID | null;
  }[];
}

/**
 * M11 `purchasing` — purchase requests (F-PUR-01, CONTRACTS.md §4.11, §5.3).
 * PR chain is a single-step MGR approve/reject via `kernel/approvals` — never
 * hand-rolled here.
 *
 * NO `SyncEmitService` here on purpose: `@mimi/sync-protocol`'s authority
 * matrix declares `purchase_requests` (and `purchase_orders`/`po_receipts`)
 * class X — `direction: 'none'`, `ops: []` (CONTRACTS.md §5.3: "class X —
 * online surfaces" for the whole PR→PO chain except petty cash). Calling
 * `SyncEmitService.emit()` for an unregistered `(entity, op)` pair throws —
 * these documents are desk-only, never wire-eligible, so this module never
 * calls it for them.
 */
@Injectable()
export class PurchaseRequestService {
  constructor(
    private readonly repo: PurchaseRequestRepository,
    private readonly approvals: ApprovalService,
  ) {}

  async list(
    client: PoolClient,
    query: ListPurchaseRequestQueryDto,
  ): Promise<Paginated<PurchaseRequestListRow>> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;
    const { rows, total } = await this.repo.listHeaders(client, {
      locationId: query.locationId,
      status: query.status,
      page,
      pageSize,
    });
    const result: PurchaseRequestListRow[] = [];
    for (const row of rows) {
      const lineCount = await this.repo.lineCount(client, row.id);
      result.push({
        id: row.id,
        prNumber: row.pr_number,
        locationName: row.location_name,
        status: row.status,
        requestedBy: row.requested_by_name ?? row.requested_by,
        neededBy: row.needed_by ? formatDateOnly(row.needed_by) : null,
        lineCount,
      });
    }
    return { rows: result, total, page, pageSize };
  }

  async getDetail(client: PoolClient, id: UUID): Promise<PurchaseRequestDetail> {
    const header = await this.requireHeader(client, id);
    const lines = await this.repo.findLines(client, id);
    return this.toDetail(client, header, lines);
  }

  async create(
    client: PoolClient,
    actor: ActorContext,
    dto: CreatePurchaseRequestDto,
  ): Promise<PurchaseRequestDetail> {
    this.assertLocationInScope(actor, dto.locationId);
    if (dto.lines.length === 0) {
      throw new BadRequestException({
        code: ERR_VALIDATION,
        message: 'A purchase request needs at least one line',
      });
    }

    return withWrite(client, async () => {
      const prNumber = await this.repo.nextPrNumber(client);
      const id = await this.repo.insertHeader(client, {
        prNumber,
        locationId: dto.locationId,
        requestedBy: actor.userId,
        neededBy: dto.neededBy ?? null,
      });
      for (const line of dto.lines) {
        await this.repo.insertLine(client, {
          prId: id,
          itemId: line.itemId,
          unitId: line.unitId,
          qty: line.qty as Qty,
          estPrice: (line.estPrice ?? '0.00') as Money,
          suggestedSupplierId: line.suggestedSupplierId ?? null,
        });
      }

      return this.getDetail(client, id);
    });
  }

  async submit(client: PoolClient, actor: ActorContext, id: UUID): Promise<PurchaseRequestDetail> {
    const header = await this.requireHeader(client, id);
    this.assertLocationInScope(actor, header.location_id);
    if (header.status !== PurchaseRequestStatus.DRAFT) {
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: `PR ${id} is '${header.status}', not 'draft'`,
      });
    }

    return withWrite(client, async () => {
      await this.repo.setStatus(client, id, PurchaseRequestStatus.SUBMITTED);

      const amount = await this.repo.estimatedTotal(client, id);
      const submitResult = await this.approvals.submit(client, {
        documentType: ApprovalDocumentType.PURCHASE_REQUEST,
        documentId: id,
        requestedBy: actor.userId,
        amount,
        locationId: header.location_id,
      });
      await this.repo.setApprovalId(client, id, submitResult.approvalId);

      return this.getDetail(client, id);
    });
  }

  async approve(
    client: PoolClient,
    actor: ActorContext,
    id: UUID,
    dto: ApprovePurchaseRequestDto,
  ): Promise<PurchaseRequestDetail> {
    const header = await this.requireHeader(client, id);
    if (header.status !== PurchaseRequestStatus.SUBMITTED) {
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: `PR ${id} is '${header.status}', not 'submitted'`,
      });
    }

    return withWrite(client, async () => {
      const decision = await this.approvals.approve(client, {
        documentType: ApprovalDocumentType.PURCHASE_REQUEST,
        documentId: id,
        currentState: header.status,
        actorUserId: actor.userId,
        actorRole: actor.roleKey,
        reason: dto.note ?? null,
      });
      if (decision.currentStep !== null) return this.getDetail(client, id);

      await this.repo.setStatus(client, id, decision.nextState);
      return this.getDetail(client, id);
    });
  }

  async reject(
    client: PoolClient,
    actor: ActorContext,
    id: UUID,
    dto: RejectPurchaseRequestDto,
  ): Promise<PurchaseRequestDetail> {
    const header = await this.requireHeader(client, id);
    if (header.status !== PurchaseRequestStatus.SUBMITTED) {
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: `PR ${id} is '${header.status}', not 'submitted'`,
      });
    }

    return withWrite(client, async () => {
      const decision = await this.approvals.reject(client, {
        documentType: ApprovalDocumentType.PURCHASE_REQUEST,
        documentId: id,
        currentState: header.status,
        actorUserId: actor.userId,
        actorRole: actor.roleKey,
        reason: dto.reason,
      });
      await this.repo.setRejection(client, id, decision.nextState, dto.reason);
      return this.getDetail(client, id);
    });
  }

  /** Marks a PR `converted` — called by `PurchaseOrderService.create` when `prId` is supplied. */
  async markConverted(client: PoolClient, prId: UUID): Promise<void> {
    await this.repo.setStatus(client, prId, PurchaseRequestStatus.CONVERTED);
  }

  private async requireHeader(client: PoolClient, id: UUID) {
    const header = await this.repo.findHeader(client, id);
    if (!header)
      throw new NotFoundException({
        code: ERR_NOT_FOUND,
        message: `Purchase request ${id} not found`,
      });
    return header;
  }

  private assertLocationInScope(actor: ActorContext, locationId: UUID): void {
    if (actor.locationScope === null) return;
    if (!actor.locationScope.includes(locationId)) {
      throw new ForbiddenException({
        code: ERR_FORBIDDEN,
        message: `Role '${actor.roleKey}' is not assigned to location ${locationId}`,
      });
    }
  }

  private async toDetail(
    client: PoolClient,
    header: Awaited<ReturnType<PurchaseRequestRepository['findHeader']>>,
    lines: Awaited<ReturnType<PurchaseRequestRepository['findLines']>>,
  ): Promise<PurchaseRequestDetail> {
    const h = header!;
    const approval = await this.loadApprovalDetail(client, h);
    return {
      id: h.id,
      prNumber: h.pr_number,
      locationId: h.location_id,
      locationName: h.location_name,
      status: h.status,
      requestedBy: h.requested_by_name ?? h.requested_by,
      neededBy: h.needed_by ? formatDateOnly(h.needed_by) : null,
      rejectionReason: h.rejection_reason,
      notes: h.notes,
      approval,
      lines: lines.map((l) => ({
        id: l.id,
        itemId: l.item_id,
        itemName: l.item_name,
        unitId: l.unit_id,
        unitCode: l.unit_code,
        qty: l.qty,
        estPrice: l.est_price,
        suggestedSupplierId: l.suggested_supplier_id,
      })),
    };
  }

  /** CONTRACTS.md §4.11's PR-detail `ApprovalDetail` — see `PurchaseOrderService.loadApprovalDetail`'s doc comment for the shared reasoning (identical pattern, one-step chain here per this module's header doc). */
  private async loadApprovalDetail(
    client: PoolClient,
    header: NonNullable<Awaited<ReturnType<PurchaseRequestRepository['findHeader']>>>,
  ): Promise<ApprovalDetail | null> {
    if (!header.approval_id) return null;
    try {
      const detail = await this.approvals.getDetail(
        client,
        ApprovalDocumentType.PURCHASE_REQUEST,
        header.id,
      );
      return {
        approvalId: detail.approvalId,
        state: detail.state,
        amount: detail.amount,
        currentStep: detail.currentStep,
        steps: detail.steps.map((s) => ({
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
    } catch {
      return null;
    }
  }
}
