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
  can,
  ERR_CONFLICT,
  ERR_FORBIDDEN,
  ERR_LOCATION_OUT_OF_SCOPE,
  ERR_NOT_FOUND,
  ERR_REASON_REQUIRED,
  ERR_VALIDATION,
  isNegativeQty,
  isZeroQty,
  NONE_STATE,
  RoleKey,
  transition,
  type ApprovalDetail,
  type Paginated,
  type Replenishment,
  type ReplenishmentLine,
  type UUID,
} from '@mimi/shared';
import { ApprovalService, type CallerScope } from '../../kernel/approvals';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';
import { ApproveReplenishmentDto } from './dto/approve-replenishment.dto';
import { CreateReplenishmentDto } from './dto/create-replenishment.dto';
import { ListReplenishmentQueryDto } from './dto/list-replenishment.query';
import { RejectReplenishmentDto } from './dto/reject-replenishment.dto';
import { UpdateReplenishmentDto } from './dto/update-replenishment.dto';
import { WarehouseQueueQueryDto } from './dto/warehouse-queue.query';
import {
  ReplenishmentLineRow,
  ReplenishmentRepository,
  ReplenishmentRow,
} from './replenishment.repository';

/** `AuditRow[]` shape CONTRACTS.md §4.9's `GET /:id/history` returns — mirrors `kernel/audit`'s `AuditRow` (same table, same columns) without importing across that module's own file (no shared barrel exists for it). */
export interface ReplenishmentHistoryRow {
  id: UUID;
  userId: UUID | null;
  userName: string | null;
  roleKey: string | null;
  module: string;
  action: string;
  entityType: string;
  entityId: UUID | null;
  beforeValue: unknown;
  afterValue: unknown;
  reason: string | null;
  offlineAuthorized: boolean;
  occurredAt: string;
}

/**
 * M09 `replenishment` core service — FR-LOG-06..13 (CONTRACTS.md §4.9). Owns
 * the `draft → submitted → awaiting_approval → approved → processing` half
 * of the 9-state lifecycle; `shipped/received/completed` are advanced only
 * through `ReplenishmentAdvancementService` (M10's interface — see that
 * file), never written here directly.
 *
 * Every method takes the caller's own `PoolClient` (`request.dbClient`,
 * already RLS-scoped and mid-transaction by `RlsContextGuard`, same pattern
 * as `ApprovalService`/`StockLedgerService`). Mutating methods issue their
 * own trailing `COMMIT` on that SAME client (`RlsCleanupInterceptor` only
 * ever issues a `ROLLBACK` afterwards — a no-op once already committed, see
 * that file's header) — but every read needed to build the HTTP response
 * runs BEFORE that `COMMIT`, never after: `SET LOCAL ROLE app_user` and the
 * `app.*` session vars are transaction-scoped and revert the instant COMMIT
 * runs, so a query issued on this client after COMMIT would silently run
 * with NO role/session context at all — RLS would then hide every row
 * (nothing central, nothing self, nothing location-matched), and a
 * post-commit "read the row back" would 404 the very write that just
 * succeeded. Building the response first and committing last is not a
 * style preference here; it is the only ordering that is actually correct
 * under this codebase's per-request RLS session model (D-21/D-22).
 */
@Injectable()
export class ReplenishmentService {
  constructor(
    private readonly repo: ReplenishmentRepository,
    private readonly approvals: ApprovalService,
    private readonly syncEmit: SyncEmitService,
  ) {}

  // ── reads ──────────────────────────────────────────────────────────────

  async list(
    client: PoolClient,
    query: ListReplenishmentQueryDto,
  ): Promise<Paginated<Replenishment>> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;
    const { rows, total } = await this.repo.list(client, {
      locationId: query.locationId,
      status: query.status,
      from: query.from,
      to: query.to,
      page,
      pageSize,
    });
    return { rows: rows.map((r) => this.toResource(r, [], null)), total, page, pageSize };
  }

  async warehouseQueue(
    client: PoolClient,
    query: WarehouseQueueQueryDto,
  ): Promise<Paginated<Replenishment>> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;
    const { rows, total } = await this.repo.listWarehouseQueue(client, {
      status: query.status,
      page,
      pageSize,
    });
    return { rows: rows.map((r) => this.toResource(r, [], null)), total, page, pageSize };
  }

  async getById(client: PoolClient, id: UUID): Promise<Replenishment> {
    const row = await this.repo.findById(client, id);
    if (!row)
      throw new NotFoundException({
        code: ERR_NOT_FOUND,
        message: `Replenishment request ${id} not found`,
      });
    const lines = await this.repo.findLines(client, id);
    const approval = await this.loadApprovalDetail(client, id, row.status);
    return this.toResource(row, lines, approval);
  }

  async getHistory(client: PoolClient, id: UUID): Promise<ReplenishmentHistoryRow[]> {
    const row = await this.repo.findById(client, id);
    if (!row)
      throw new NotFoundException({
        code: ERR_NOT_FOUND,
        message: `Replenishment request ${id} not found`,
      });
    return this.repo.history(client, id);
  }

  // ── draft lifecycle ───────────────────────────────────────────────────

  async create(
    client: PoolClient,
    caller: CallerScope,
    dto: CreateReplenishmentDto,
  ): Promise<Replenishment> {
    this.assertLocationInScope(caller, dto.locationId);
    this.validateLines(dto.lines);

    const { id } = await this.repo.insertRequestWithNumber(client, {
      locationId: dto.locationId,
      source: dto.source ?? 'manual',
      requestedBy: caller.userId,
      neededBy: dto.neededBy ?? null,
      notes: null,
      clientId: null,
    });
    await this.repo.insertLines(client, id, dto.lines);

    const resource = await this.getById(client, id); // BEFORE commit — see class header.
    await client.query('COMMIT');
    return resource;
  }

  async update(
    client: PoolClient,
    caller: CallerScope,
    id: UUID,
    dto: UpdateReplenishmentDto,
  ): Promise<Replenishment> {
    const row = await this.repo.findByIdForUpdate(client, id);
    if (!row)
      throw new NotFoundException({
        code: ERR_NOT_FOUND,
        message: `Replenishment request ${id} not found`,
      });
    if (row.status !== 'draft') {
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: `Only a draft request can be edited (current status: ${row.status})`,
      });
    }
    this.assertLocationInScope(caller, row.locationId);

    if (dto.lines) {
      this.validateLines(dto.lines);
      await this.repo.deleteLines(client, id);
      await this.repo.insertLines(client, id, dto.lines);
    }
    if (dto.neededBy !== undefined) {
      await client.query(`UPDATE replenishment_requests SET needed_by = $2 WHERE id = $1`, [
        id,
        dto.neededBy,
      ]);
    }

    const resource = await this.getById(client, id);
    await client.query('COMMIT');
    return resource;
  }

  async remove(
    client: PoolClient,
    caller: CallerScope,
    id: UUID,
  ): Promise<{ id: UUID; deleted: true }> {
    const row = await this.repo.findByIdForUpdate(client, id);
    if (!row)
      throw new NotFoundException({
        code: ERR_NOT_FOUND,
        message: `Replenishment request ${id} not found`,
      });
    this.assertLocationInScope(caller, row.locationId);

    // Validates role + current-state eligibility for the `delete` edge
    // (§5.1 row 2) — the resulting `(deleted)` pseudo-state is never
    // persisted anywhere; the row itself is removed below.
    this.runTransition(row.status, 'delete', caller.roleKey);

    await this.repo.hardDelete(client, id);
    await client.query('COMMIT');
    return { id, deleted: true };
  }

  // ── submit → approval chain ────────────────────────────────────────────

  async submit(client: PoolClient, caller: CallerScope, id: UUID): Promise<Replenishment> {
    const row = await this.repo.findByIdForUpdate(client, id);
    if (!row)
      throw new NotFoundException({
        code: ERR_NOT_FOUND,
        message: `Replenishment request ${id} not found`,
      });
    this.assertLocationInScope(caller, row.locationId);
    if (row.status !== 'draft') {
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: `Only a draft request can be submitted (current status: ${row.status})`,
      });
    }

    // CONTRACTS.md §5.1 row 1 lists the "submit" edge as `draft --submit--> submitted`, but
    // `@mimi/shared`'s transcribed rule (state-machine.ts) keys it off `NONE_STATE` ('(none)') instead
    // of the literal string 'draft' — every OTHER replenishment rule (including this document type's
    // OWN `delete` edge, two lines below it in the same table) keys off real status strings. Reported
    // as a contract deviation for the architect/W1-B to reconcile (packages/shared is frozen/read-only
    // outside its own owner after G1 — not this agent's to edit). The state guard immediately above
    // does the REAL "is this actually a draft" check this module needs; `transition()` below is called
    // with the constant the DEPLOYED rule actually expects, purely for its role/reason gate — never to
    // re-derive "is this a draft", which the guard above already settled.
    const nextState = this.runTransition(NONE_STATE, 'submit', caller.roleKey);
    await this.repo.markSubmitted(client, id, nextState);
    // `submit()` never calls `transition()` itself (kernel/approvals/types.ts) — this module owns that
    // workflow-edge validation above; the engine's job here is purely the chain bookkeeping.
    await this.approvals.submit(client, {
      documentType: ApprovalDocumentType.REPLENISHMENT_REQUEST,
      documentId: id,
      requestedBy: row.requestedBy,
      amount: null, // FR-LOG-10/§5.1: unconditional 2-step chain (migration 069 seeds NULL/NULL thresholds), no amount routing.
      locationId: row.locationId,
    });

    const lines = await this.repo.findLines(client, id);
    await this.syncEmit.emit(client, {
      entity: 'replenishment_requests',
      op: 'submitted',
      entityId: id,
      locationId: row.locationId,
      actorUserId: caller.userId,
      data: {
        id,
        requestNumber: row.requestNumber,
        locationId: row.locationId,
        neededBy: row.neededBy,
        source: row.source,
        lines: lines.map((l) => ({
          itemId: l.itemId,
          qtyRequested: l.qtyRequested,
          unitId: l.itemId,
        })),
      },
    });

    const resource = await this.getById(client, id);
    await client.query('COMMIT');
    return resource;
  }

  // ── approve / reject (both chain steps share one endpoint each) ───────

  async approve(
    client: PoolClient,
    caller: CallerScope,
    id: UUID,
    dto: ApproveReplenishmentDto,
  ): Promise<Replenishment> {
    const row = await this.repo.findByIdForUpdate(client, id);
    if (!row)
      throw new NotFoundException({
        code: ERR_NOT_FOUND,
        message: `Replenishment request ${id} not found`,
      });

    const amendments = dto.amendments ?? [];
    if (amendments.length > 0 && !can(caller.roleKey as RoleKey, 'replenishment.amend')) {
      throw new ForbiddenException({
        code: ERR_FORBIDDEN,
        message: `Role '${caller.roleKey}' may not amend quantities (replenishment.amend required)`,
      });
    }
    if (amendments.length > 0) await this.validateAmendments(client, id, amendments);

    // FR-LOG-13's "reason for a reject or an amend" gate: with amendments present, `transition()`'s
    // `on_amend` rule (state-machine.ts) requires a non-empty reason — the per-LINE reasons are what
    // actually gets persisted (recoverable "from what, to what, why"); this concatenation only has to
    // satisfy the engine's own `reasonProvided` boolean, never re-derive the granular trail from it.
    const reasonForEngine =
      amendments.length > 0
        ? amendments.map((a) => `${a.lineId}: ${a.reason}`).join(' | ')
        : dto.note;

    const result = await this.approvals.approve(client, {
      documentType: ApprovalDocumentType.REPLENISHMENT_REQUEST,
      documentId: id,
      currentState: row.status,
      actorUserId: caller.userId,
      actorRole: caller.roleKey as RoleKey,
      reason: reasonForEngine,
      isAmendment: amendments.length > 0,
    });

    // This chain's two steps read genuinely distinct `from` states
    // (`submitted` then `awaiting_approval` — CONTRACTS.md §5.1, migration
    // 069 seeds BOTH steps with NULL/NULL thresholds, i.e. unconditional, no
    // escalation), so `result.nextState` is the correct real status at
    // EVERY step, not just the last one — persisting it unconditionally is
    // what makes `awaiting_approval` observable at all (FR-LOG-11's 9
    // states). `result.currentStep === null` is used ONLY to decide whether
    // THIS decision is the chain's FINAL one (which sync op to emit,
    // whether to backfill un-amended lines' `qty_approved`) — never to gate
    // whether the status write happens. A chain whose steps reuse ONE
    // status name across escalation levels (e.g. PURCHASE_ORDER's MGR→OWN
    // threshold step, both `pending_approval --approve--> approved`) MUST
    // gate the status WRITE itself on `currentStep === null` instead, since
    // `nextState` there would misleadingly read 'approved' after step 1
    // too — that is the exact failure this rule exists to prevent, and
    // getting it backwards would finalise such a chain after only one of
    // two required approvals.
    await this.repo.updateStatus(client, id, result.nextState);

    for (const a of amendments) {
      await this.repo.applyLineAmendment(client, a.lineId, a.qtyApproved, a.reason);
    }

    const isFinal = result.currentStep === null;
    if (isFinal) {
      await this.repo.fillDefaultApprovedQuantities(client, id);
    }

    await this.syncEmit.emit(client, {
      entity: 'replenishment_requests',
      op: isFinal ? 'warehouse_approved' : 'supervisor_approved',
      entityId: id,
      locationId: row.locationId,
      actorUserId: caller.userId,
      data: {
        id,
        note: dto.note,
        amendments: amendments.map((a) => ({
          lineId: a.lineId,
          qtyApproved: a.qtyApproved,
          reason: a.reason,
        })),
      },
    });

    const resource = await this.getById(client, id);
    await client.query('COMMIT');
    return resource;
  }

  async reject(
    client: PoolClient,
    caller: CallerScope,
    id: UUID,
    dto: RejectReplenishmentDto,
  ): Promise<Replenishment> {
    const row = await this.repo.findByIdForUpdate(client, id);
    if (!row)
      throw new NotFoundException({
        code: ERR_NOT_FOUND,
        message: `Replenishment request ${id} not found`,
      });

    const wasSupervisorStep = row.status === 'submitted';
    const result = await this.approvals.reject(client, {
      documentType: ApprovalDocumentType.REPLENISHMENT_REQUEST,
      documentId: id,
      currentState: row.status,
      actorUserId: caller.userId,
      actorRole: caller.roleKey as RoleKey,
      reason: dto.reason,
    });

    await this.repo.setRejectionReason(client, id, result.nextState, dto.reason);
    await this.syncEmit.emit(client, {
      entity: 'replenishment_requests',
      op: wasSupervisorStep ? 'supervisor_rejected' : 'warehouse_rejected',
      entityId: id,
      locationId: row.locationId,
      actorUserId: caller.userId,
      data: { id, reason: dto.reason },
    });

    const resource = await this.getById(client, id);
    await client.query('COMMIT');
    return resource;
  }

  async process(client: PoolClient, caller: CallerScope, id: UUID): Promise<Replenishment> {
    const row = await this.repo.findByIdForUpdate(client, id);
    if (!row)
      throw new NotFoundException({
        code: ERR_NOT_FOUND,
        message: `Replenishment request ${id} not found`,
      });

    const nextState = this.runTransition(row.status, 'process', caller.roleKey);
    await this.repo.updateStatus(client, id, nextState);
    await this.syncEmit.emit(client, {
      entity: 'replenishment_requests',
      op: 'fulfillment_started',
      entityId: id,
      locationId: row.locationId,
      actorUserId: caller.userId,
      data: { id },
    });

    const resource = await this.getById(client, id);
    await client.query('COMMIT');
    return resource;
  }

  // ── internals ──────────────────────────────────────────────────────────

  private toResource(
    row: ReplenishmentRow,
    lines: ReplenishmentLineRow[],
    approval: ApprovalDetail | null,
  ): Replenishment {
    return {
      id: row.id,
      requestNumber: row.requestNumber,
      locationId: row.locationId,
      locationName: row.locationName,
      status: row.status as Replenishment['status'],
      source: row.source,
      requestedBy: row.requestedByName ?? row.requestedBy,
      submittedAt: row.submittedAt,
      neededBy: row.neededBy,
      sjId: row.sjId,
      sjNumber: row.sjNumber,
      approval,
      lines: lines.map((l): ReplenishmentLine => ({
        id: l.id,
        itemId: l.itemId,
        itemName: l.itemName,
        unitCode: l.unitCode,
        qtyRequested: l.qtyRequested,
        qtyApproved: l.qtyApproved,
        qtyShipped: l.qtyShipped,
        qtyReceived: l.qtyReceived,
        amendReason: l.amendReason,
      })),
    };
  }

  private async loadApprovalDetail(
    client: PoolClient,
    id: UUID,
    status: string,
  ): Promise<ApprovalDetail | null> {
    if (status === 'draft') return null;
    try {
      const detail = await this.approvals.getDetail(
        client,
        ApprovalDocumentType.REPLENISHMENT_REQUEST,
        id,
      );
      return {
        approvalId: detail.approvalId,
        state: detail.state,
        amount: detail.amount,
        // null once the chain is finalised — the documented "complete" signal (see @mimi/shared ApprovalDetail).
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
      return null; // No approval row yet (shouldn't happen past 'draft') — never let a display concern break the read.
    }
  }

  private runTransition(currentState: string, action: string, actorRole: string): string {
    const result = transition({
      documentType: ApprovalDocumentType.REPLENISHMENT_REQUEST,
      currentState,
      action,
      actorRole: actorRole as RoleKey,
    });
    if (!result.ok) {
      if (result.code === 'ERR_APPROVAL_STEP_ROLE') {
        throw new ForbiddenException({ code: result.code, message: result.message });
      }
      throw new BadRequestException({ code: result.code, message: result.message });
    }
    return result.nextState;
  }

  private assertLocationInScope(caller: CallerScope, locationId: UUID): void {
    if (caller.locationIds === null) return; // central role
    if (!caller.locationIds.includes(locationId)) {
      throw new ForbiddenException({
        code: ERR_LOCATION_OUT_OF_SCOPE,
        message: `Location ${locationId} is outside your assigned scope`,
      });
    }
  }

  private validateLines(
    lines: readonly { itemId: UUID; qtyRequested: string; unitId: UUID }[],
  ): void {
    const seen = new Set<UUID>();
    for (const line of lines) {
      if (isZeroQty(line.qtyRequested) || isNegativeQty(line.qtyRequested)) {
        throw new BadRequestException({
          code: ERR_VALIDATION,
          message: `qtyRequested must be greater than 0 (item ${line.itemId})`,
        });
      }
      if (seen.has(line.itemId)) {
        throw new BadRequestException({
          code: ERR_VALIDATION,
          message: `Item ${line.itemId} appears more than once — one line per item`,
        });
      }
      seen.add(line.itemId);
    }
  }

  private async validateAmendments(
    client: PoolClient,
    requestId: UUID,
    amendments: readonly { lineId: UUID; qtyApproved: string; reason: string }[],
  ): Promise<void> {
    const lines = await this.repo.findLines(client, requestId);
    const byId = new Map(lines.map((l) => [l.id, l]));
    for (const a of amendments) {
      const line = byId.get(a.lineId);
      if (!line) {
        throw new BadRequestException({
          code: ERR_VALIDATION,
          message: `Line ${a.lineId} does not belong to request ${requestId}`,
        });
      }
      if (isNegativeQty(a.qtyApproved)) {
        throw new BadRequestException({
          code: ERR_VALIDATION,
          message: `qtyApproved must be >= 0 (line ${a.lineId})`,
        });
      }
      // FR-LOG-13, enforced HERE and not left to the engine's own `reasonProvided` gate: the engine
      // only ever sees the CONCATENATED multi-line string built below (`reasonForEngine`), which always
      // contains each line's non-blank `lineId` prefix even when the line's OWN `reason` is blank —
      // so a per-line empty reason would otherwise silently pass `transition()`'s non-empty check. This
      // per-line check is what actually guarantees "a reason is required for every amended line", the
      // named fraud-vector control this ticket is about.
      if (!a.reason || a.reason.trim().length === 0) {
        throw new BadRequestException({
          code: ERR_REASON_REQUIRED,
          message: `A reason is required to amend line ${a.lineId}`,
        });
      }
    }
  }
}
