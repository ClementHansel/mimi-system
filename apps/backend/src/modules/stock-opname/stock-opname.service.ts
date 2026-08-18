import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  absQty,
  ApprovalDocumentType,
  ERR_CONFLICT,
  ERR_DISPUTES_OPEN,
  ERR_FORBIDDEN,
  ERR_NOT_FOUND,
  ERR_VALIDATION,
  ERR_VARIANCE_REASON_REQUIRED,
  isNegativeQty,
  isZeroQty,
  MovementType,
  OpnameStatus,
  RoleKey,
  subQty,
  SyncEntity,
  type Money,
  type Opname,
  type OpnameLine,
  type Paginated,
  type Qty,
  type UUID,
} from '@mimi/shared';
import { ApprovalService } from '../../kernel/approvals/approvals.service';
import { StockLedgerService } from '../../kernel/stock-ledger/stock-ledger.service';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';
import { SyncConflictsRepository } from '../../kernel/sync/sync-conflicts.repository';
import { SyncEventsRepository } from '../../kernel/sync/sync-events.repository';
import type { ApproveOpnameDto } from './dto/approve-opname.dto';
import type { CreateOpnameDto } from './dto/create-opname.dto';
import type { ListOpnameQueryDto } from './dto/list-opname.query';
import type { RejectOpnameDto } from './dto/reject-opname.dto';
import type { ResolveOpnameLineDto } from './dto/resolve-line.dto';
import type { UpsertOpnameLinesDto } from './dto/upsert-lines.dto';
import {
  StockOpnameRepository,
  type OpnameHeaderRow,
  type OpnameLineRow,
} from './stock-opname.repository';
import { withWrite } from './db-tx';

export interface ActorContext {
  userId: UUID;
  roleKey: RoleKey;
  /** `null` = unrestricted central role; otherwise the caller's exact `user_locations` scope (`RlsContextGuard`'s `req.locationScope`). */
  locationScope: readonly UUID[] | null;
}

interface AreaCountedLine {
  itemId: UUID;
  systemQty: Qty;
  countedQty: Qty;
  varianceReason?: string | null;
}

/**
 * M08 `stock-opname` (FR-SO-01..04, CONTRACTS.md §4.8). Delegates the
 * approve/reject lifecycle to `kernel/approvals` (D-08) — `ApprovalService`
 * reads `stock_opname`'s own `location_type` via `resolveDocumentContext()`
 * to route step 1 to Supervisor (outlet) or Kepala Gudang (warehouse); this
 * service never re-implements that routing. Adjustment posting goes through
 * `StockLedgerService.post(..., 'fact')` (D-07) — never writes
 * `stock_balances`/`stock_movements` directly, and uses `'fact'` mode
 * because a physical count's correction is exactly the case D-17a carves
 * out as legitimately allowed to drive a balance negative (a further
 * movement between the snapshot and the approval landing first, e.g.).
 */
@Injectable()
export class StockOpnameService {
  constructor(
    private readonly repo: StockOpnameRepository,
    private readonly approvals: ApprovalService,
    private readonly ledger: StockLedgerService,
    private readonly sync: SyncEmitService,
    private readonly conflicts: SyncConflictsRepository,
    private readonly events: SyncEventsRepository,
  ) {}

  // ── reads ────────────────────────────────────────────────────────────────

  async list(client: PoolClient, query: ListOpnameQueryDto): Promise<Paginated<Opname>> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;
    const { rows, total } = await this.repo.listHeaders(client, {
      locationId: query.locationId,
      status: query.status,
      from: query.from,
      to: query.to,
      page,
      pageSize,
    });

    const result: Opname[] = [];
    for (const row of rows) {
      const summary = await this.repo.lineSummary(client, row.id);
      const disputedCount = await this.countDisputedLines(client, row.id);
      result.push(this.toOpname(row, summary.lineCount, summary.totalVarianceValue, disputedCount));
    }
    return { rows: result, total, page, pageSize };
  }

  async getDetail(client: PoolClient, id: UUID): Promise<Opname & { lines: OpnameLine[] }> {
    const header = await this.requireHeader(client, id);
    const lineRows = await this.repo.findLines(client, id);
    const disputedKeys = await this.disputedLineKeys(client, id);
    const summary = await this.repo.lineSummary(client, id);
    const opname = this.toOpname(
      header,
      summary.lineCount,
      summary.totalVarianceValue,
      disputedKeys.size,
    );
    return { ...opname, lines: lineRows.map((r) => this.toOpnameLine(r, disputedKeys)) };
  }

  // ── FR-SO-01: create (targets a location, optionally one storage area — D-15) ──

  async create(
    client: PoolClient,
    actor: ActorContext,
    dto: CreateOpnameDto,
  ): Promise<Opname & { lines: OpnameLine[] }> {
    this.assertLocationInScope(actor, dto.locationId);

    if (dto.storageAreaId) {
      const areaLocationId = await this.storageAreaLocationId(client, dto.storageAreaId);
      if (areaLocationId !== dto.locationId) {
        throw new BadRequestException({
          code: ERR_VALIDATION,
          message: `storageAreaId ${dto.storageAreaId} does not belong to locationId ${dto.locationId}`,
        });
      }
    }

    return withWrite(client, async () => {
      const opnameNumber = await this.repo.nextOpnameNumber(client);
      const id = await this.repo.insertOpname(client, {
        opnameNumber,
        locationId: dto.locationId,
        storageAreaId: dto.storageAreaId ?? null,
        countedBy: actor.userId,
      });

      const header = await this.requireHeader(client, id);
      await this.sync.emit(client, {
        entity: SyncEntity.STOCK_OPNAME,
        op: 'opened',
        entityId: id,
        locationId: dto.locationId,
        actorUserId: actor.userId,
        data: {
          id,
          opnameNumber,
          locationId: dto.locationId,
          storageAreaId: dto.storageAreaId ?? null,
          countedBy: actor.userId,
          startedAt: header.started_at,
        },
      });

      return this.getDetail(client, id);
    });
  }

  // ── FR-SO-02: per-storage-area counts, variance + mandatory reason ──────────

  async upsertLines(
    client: PoolClient,
    actor: ActorContext,
    opnameId: UUID,
    dto: UpsertOpnameLinesDto,
  ): Promise<OpnameLine[]> {
    const header = await this.requireHeader(client, opnameId);
    this.assertLocationInScope(actor, header.location_id);

    if (header.status !== OpnameStatus.COUNTING) {
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: `Opname ${opnameId} is '${header.status}', not 'counting' — lines can only be recorded while counting`,
      });
    }

    const storageAreaId = dto.lines[0]!.storageAreaId;
    if (dto.lines.some((l) => l.storageAreaId !== storageAreaId)) {
      throw new BadRequestException({
        code: ERR_VALIDATION,
        message:
          'A single PUT /lines batch must target exactly one storage area (CONTRACTS.md §4.8)',
      });
    }
    if (header.storage_area_id && header.storage_area_id !== storageAreaId) {
      throw new BadRequestException({
        code: ERR_VALIDATION,
        message: `Opname ${opnameId} is scoped to storage area ${header.storage_area_id}`,
      });
    }

    const areaLocationId = await this.storageAreaLocationId(client, storageAreaId);
    if (areaLocationId !== header.location_id) {
      throw new BadRequestException({
        code: ERR_VALIDATION,
        message: `storageAreaId ${storageAreaId} does not belong to opname ${opnameId}'s location`,
      });
    }

    return withWrite(client, async () => {
      const eventLines: AreaCountedLine[] = [];
      const lineIds: UUID[] = [];
      for (const line of dto.lines) {
        const existing = await this.repo.findLineByKey(
          client,
          opnameId,
          line.storageAreaId,
          line.itemId,
        );
        const systemQty =
          existing?.system_qty ??
          (await this.repo.currentSystemQty(
            client,
            header.location_id,
            line.storageAreaId,
            line.itemId,
          ));
        const diffQty = subQty(line.countedQty, systemQty);
        const lineId = await this.repo.upsertLine(client, {
          opnameId,
          storageAreaId: line.storageAreaId,
          itemId: line.itemId,
          systemQty,
          countedQty: line.countedQty,
          diffQty,
          varianceReason: line.varianceReason ?? null,
        });
        lineIds.push(lineId);
        eventLines.push({
          itemId: line.itemId,
          systemQty,
          countedQty: line.countedQty,
          varianceReason: line.varianceReason ?? null,
        });
      }

      await this.sync.emit(client, {
        entity: SyncEntity.STOCK_OPNAME,
        op: 'area_counted',
        entityId: opnameId,
        locationId: header.location_id,
        actorUserId: actor.userId,
        data: { opnameId, storageAreaId, lines: eventLines },
      });

      const disputedKeys = await this.disputedLineKeys(client, opnameId);
      const result: OpnameLine[] = [];
      for (const lineId of lineIds) {
        const row = await this.repo.findLineById(client, opnameId, lineId);
        if (row) result.push(this.toOpnameLine(row, disputedKeys));
      }
      return result;
    });
  }

  /** Resolves a C1 double-count dispute (SYNC-PROTOCOL §5.2) — `opname.approve` (an approver adjudicates, not the counter). */
  async resolveLine(
    client: PoolClient,
    actor: ActorContext,
    opnameId: UUID,
    lineId: UUID,
    dto: ResolveOpnameLineDto,
  ): Promise<OpnameLine> {
    const header = await this.requireHeader(client, opnameId);
    const line = await this.repo.findLineById(client, opnameId, lineId);
    if (!line)
      throw new NotFoundException({
        code: ERR_NOT_FOUND,
        message: `Opname line ${lineId} not found on opname ${opnameId}`,
      });

    const openConflicts = await this.conflicts.findOpen(client, {
      kind: 'double_count',
      entity: 'stock_opname',
      entityId: opnameId,
    });
    const conflict = openConflicts.find((c) => {
      const detail = (c.detail ?? {}) as Record<string, unknown>;
      return detail.itemId === line.item_id && detail.storageAreaId === line.storage_area_id;
    });
    if (!conflict) {
      throw new NotFoundException({
        code: ERR_NOT_FOUND,
        message: `No open double-count dispute for opname line ${lineId}`,
      });
    }
    if (
      dto.chosenEventId !== conflict.winner_event_id &&
      dto.chosenEventId !== conflict.loser_event_id
    ) {
      throw new BadRequestException({
        code: ERR_VALIDATION,
        message: `chosenEventId must be one of the two conflicting events (${conflict.winner_event_id}, ${conflict.loser_event_id})`,
      });
    }

    const chosenEvent = await this.events.findByEventId(client, dto.chosenEventId);
    if (
      !chosenEvent ||
      chosenEvent.entity !== 'stock_opname' ||
      chosenEvent.entity_id !== opnameId ||
      chosenEvent.op !== 'area_counted'
    ) {
      throw new BadRequestException({
        code: ERR_VALIDATION,
        message: `chosenEventId ${dto.chosenEventId} is not a valid stock_opname.area_counted event for this opname`,
      });
    }
    const payloadData = (chosenEvent.payload as { data?: unknown } | undefined)?.data as
      { lines?: unknown } | undefined;
    const chosenLines = Array.isArray(payloadData?.lines)
      ? (payloadData!.lines as Record<string, unknown>[])
      : [];
    const chosenLine = chosenLines.find((l) => l.itemId === line.item_id);
    if (!chosenLine || typeof chosenLine.countedQty !== 'string') {
      throw new BadRequestException({
        code: ERR_VALIDATION,
        message: `chosenEventId ${dto.chosenEventId}'s payload has no line for item ${line.item_id}`,
      });
    }

    const countedQty = chosenLine.countedQty as Qty;
    const diffQty = subQty(countedQty, line.system_qty);
    const varianceReason =
      (typeof chosenLine.varianceReason === 'string' ? chosenLine.varianceReason : null) ??
      (isZeroQty(diffQty) ? null : dto.reason);

    return withWrite(client, async () => {
      await this.repo.updateLineForResolution(client, lineId, {
        countedQty,
        diffQty,
        varianceReason,
      });

      const resolutionEvent = await this.sync.emit(client, {
        entity: SyncEntity.STOCK_OPNAME,
        op: 'area_counted',
        entityId: opnameId,
        locationId: header.location_id,
        actorUserId: actor.userId,
        data: {
          opnameId,
          storageAreaId: line.storage_area_id,
          lines: [{ itemId: line.item_id, systemQty: line.system_qty, countedQty, varianceReason }],
        },
      });
      await this.conflicts.resolve(
        client,
        conflict.id,
        actor.userId,
        dto.reason,
        resolutionEvent.eventId,
      );

      const disputedKeys = await this.disputedLineKeys(client, opnameId);
      const updated = await this.repo.findLineById(client, opnameId, lineId);
      return this.toOpnameLine(updated!, disputedKeys);
    });
  }

  // ── FR-SO-02: submit (reason-on-variance + no open disputes gate) ──────────

  async submit(
    client: PoolClient,
    actor: ActorContext,
    opnameId: UUID,
  ): Promise<Opname & { lines: OpnameLine[] }> {
    const header = await this.requireHeader(client, opnameId);
    this.assertLocationInScope(actor, header.location_id);

    if (header.status !== OpnameStatus.COUNTING) {
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: `Opname ${opnameId} is '${header.status}', not 'counting'`,
      });
    }

    const openDisputes = await this.conflicts.findOpen(client, {
      kind: 'double_count',
      entity: 'stock_opname',
      entityId: opnameId,
    });
    if (openDisputes.length > 0) {
      throw new BadRequestException({
        code: ERR_DISPUTES_OPEN,
        message: `Opname ${opnameId} has ${openDisputes.length} open double-count dispute(s) — resolve via /lines/:lineId/resolve first`,
      });
    }

    const missingReasons = await this.repo.countLinesMissingReason(client, opnameId);
    if (missingReasons > 0) {
      throw new BadRequestException({
        code: ERR_VARIANCE_REASON_REQUIRED,
        message: `${missingReasons} line(s) have a non-zero variance but no varianceReason`,
      });
    }

    const summary = await this.repo.lineSummary(client, opnameId);
    if (summary.lineCount === 0) {
      throw new BadRequestException({
        code: ERR_VALIDATION,
        message: `Opname ${opnameId} has no counted lines`,
      });
    }

    return withWrite(client, async () => {
      await this.repo.markSubmitted(client, opnameId);

      const submitResult = await this.approvals.submit(client, {
        documentType: ApprovalDocumentType.STOCK_OPNAME,
        documentId: opnameId,
        requestedBy: actor.userId,
        amount: summary.totalVarianceValue,
        locationId: header.location_id,
      });
      await this.repo.setApprovalId(client, opnameId, submitResult.approvalId);

      await this.sync.emit(client, {
        entity: SyncEntity.STOCK_OPNAME,
        op: 'submitted',
        entityId: opnameId,
        locationId: header.location_id,
        actorUserId: actor.userId,
        data: { opnameId, submittedAt: new Date().toISOString() },
      });

      return this.getDetail(client, opnameId);
    });
  }

  // ── FR-SO-03/04: approve (posts stock_adjustments through the ledger) ──────

  async approve(
    client: PoolClient,
    actor: ActorContext,
    opnameId: UUID,
    dto: ApproveOpnameDto,
  ): Promise<Opname & { lines: OpnameLine[] }> {
    const header = await this.requireHeader(client, opnameId);

    if (header.status !== OpnameStatus.SUBMITTED) {
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: `Opname ${opnameId} is '${header.status}', not 'submitted'`,
      });
    }

    return withWrite(client, async () => {
      const decision = await this.approvals.approve(client, {
        documentType: ApprovalDocumentType.STOCK_OPNAME,
        documentId: opnameId,
        currentState: header.status,
        actorUserId: actor.userId,
        actorRole: actor.roleKey,
        reason: dto.note ?? null,
      });

      // Escalating chain (SPV/KGD → MGR above threshold): `nextState` reads the
      // same ('adjusted') at every step — `currentStep === null` is the ONLY
      // signal the chain is actually finished (kernel report guidance). An
      // intermediate step persists nothing on our own row; the document stays
      // 'submitted' until the final decider acts. Even so, `approvals.approve`
      // above already wrote this step's decision row — that write MUST commit
      // too, so the early return still happens INSIDE `withWrite`.
      if (decision.currentStep !== null) {
        return this.getDetail(client, opnameId);
      }

      const approvedAt = new Date().toISOString();
      await this.repo.finalizeDecision(client, opnameId, {
        status: decision.nextState,
        approvedBy: actor.userId,
        approvedAt,
      });
      await this.postAdjustments(client, actor, opnameId, header, approvedAt);

      await this.sync.emit(client, {
        entity: SyncEntity.STOCK_OPNAME,
        op: 'approved',
        entityId: opnameId,
        locationId: header.location_id,
        actorUserId: actor.userId,
        data: { opnameId, approvedBy: actor.userId, approvedAt },
      });

      return this.getDetail(client, opnameId);
    });
  }

  async reject(
    client: PoolClient,
    actor: ActorContext,
    opnameId: UUID,
    dto: RejectOpnameDto,
  ): Promise<Opname & { lines: OpnameLine[] }> {
    const header = await this.requireHeader(client, opnameId);

    if (header.status !== OpnameStatus.SUBMITTED) {
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: `Opname ${opnameId} is '${header.status}', not 'submitted'`,
      });
    }

    return withWrite(client, async () => {
      const decision = await this.approvals.reject(client, {
        documentType: ApprovalDocumentType.STOCK_OPNAME,
        documentId: opnameId,
        currentState: header.status,
        actorUserId: actor.userId,
        actorRole: actor.roleKey,
        reason: dto.reason,
      });

      await this.repo.finalizeDecision(client, opnameId, {
        status: decision.nextState,
        approvedBy: null,
        approvedAt: null,
      });

      await this.sync.emit(client, {
        entity: SyncEntity.STOCK_OPNAME,
        op: 'rejected',
        entityId: opnameId,
        locationId: header.location_id,
        actorUserId: actor.userId,
        data: { opnameId, reason: dto.reason },
      });

      return this.getDetail(client, opnameId);
    });
  }

  async cancel(
    client: PoolClient,
    actor: ActorContext,
    opnameId: UUID,
  ): Promise<{ id: UUID; status: string }> {
    const header = await this.requireHeader(client, opnameId);
    this.assertLocationInScope(actor, header.location_id);

    if (header.status !== OpnameStatus.DRAFT && header.status !== OpnameStatus.COUNTING) {
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: `Opname ${opnameId} is '${header.status}' — only draft/counting opnames can be cancelled`,
      });
    }

    return withWrite(client, async () => {
      await this.repo.setStatus(client, opnameId, OpnameStatus.CANCELLED);
      await this.sync.emit(client, {
        entity: SyncEntity.STOCK_OPNAME,
        op: 'cancelled',
        entityId: opnameId,
        locationId: header.location_id,
        actorUserId: actor.userId,
        data: { opnameId },
      });

      return { id: opnameId, status: OpnameStatus.CANCELLED };
    });
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async postAdjustments(
    client: PoolClient,
    actor: ActorContext,
    opnameId: UUID,
    header: OpnameHeaderRow,
    approvedAt: string,
  ): Promise<void> {
    const lines = await this.repo.findLines(client, opnameId);
    let index = 0;
    for (const line of lines) {
      if (isZeroQty(line.diff_qty)) continue;
      index += 1;

      const adjustmentNumber = `${header.opname_number}-ADJ${index}`;
      const adjustmentId = await this.repo.insertAdjustment(client, {
        adjustmentNumber,
        locationId: header.location_id,
        storageAreaId: line.storage_area_id,
        itemId: line.item_id,
        qtyDelta: line.diff_qty,
        unitCost: line.unit_cost,
        reason: line.variance_reason ?? `Stock opname ${header.opname_number}`,
        opnameId,
        createdBy: header.counted_by,
        approvedBy: actor.userId,
      });

      const direction: 'shortage' | 'overage' = isNegativeQty(line.diff_qty)
        ? 'shortage'
        : 'overage';
      const movementType =
        direction === 'shortage' ? MovementType.ADJUSTMENT_OUT : MovementType.ADJUSTMENT_IN;
      const qty = absQty(line.diff_qty);

      // D-17a: adjustment is the one movement type legitimately allowed to
      // drive a balance negative — 'fact' mode applies unconditionally and
      // opens a `stock_reconciliations` exception instead of rejecting.
      await this.ledger.post(
        client,
        [
          {
            locationId: header.location_id,
            storageAreaId: line.storage_area_id,
            itemId: line.item_id,
            movementType,
            qty,
            unitCost: line.unit_cost,
            refType: 'stock_adjustment',
            refId: adjustmentId,
            actorId: actor.userId,
            reason: line.variance_reason,
            occurredAt: approvedAt,
          },
        ],
        'fact',
      );

      await this.sync.emit(client, {
        entity: SyncEntity.STOCK_ADJUSTMENTS,
        op: 'posted',
        entityId: adjustmentId,
        locationId: header.location_id,
        actorUserId: actor.userId,
        data: {
          id: adjustmentId,
          locationId: header.location_id,
          storageAreaId: line.storage_area_id,
          itemId: line.item_id,
          qtyDelta: line.diff_qty,
          unitCost: line.unit_cost,
          reason: line.variance_reason ?? `Stock opname ${header.opname_number}`,
          source: 'opname',
          direction,
          opnameId,
        },
      });
    }
  }

  private async requireHeader(client: PoolClient, id: UUID): Promise<OpnameHeaderRow> {
    const header = await this.repo.findHeader(client, id);
    if (!header)
      throw new NotFoundException({ code: ERR_NOT_FOUND, message: `Stock opname ${id} not found` });
    return header;
  }

  private async storageAreaLocationId(
    client: PoolClient,
    storageAreaId: UUID,
  ): Promise<UUID | undefined> {
    const res = await client.query<{ location_id: UUID }>(
      `SELECT location_id FROM storage_areas WHERE id = $1`,
      [storageAreaId],
    );
    return res.rows[0]?.location_id;
  }

  private assertLocationInScope(actor: ActorContext, locationId: UUID): void {
    if (actor.locationScope === null) return; // central role — unrestricted
    if (!actor.locationScope.includes(locationId)) {
      throw new ForbiddenException({
        code: ERR_FORBIDDEN,
        message: `Role '${actor.roleKey}' is not assigned to location ${locationId}`,
      });
    }
  }

  private async disputedLineKeys(client: PoolClient, opnameId: UUID): Promise<Set<string>> {
    const openConflicts = await this.conflicts.findOpen(client, {
      kind: 'double_count',
      entity: 'stock_opname',
      entityId: opnameId,
    });
    const keys = new Set<string>();
    for (const c of openConflicts) {
      const detail = (c.detail ?? {}) as Record<string, unknown>;
      if (typeof detail.storageAreaId === 'string' && typeof detail.itemId === 'string') {
        keys.add(`${detail.storageAreaId}:${detail.itemId}`);
      }
    }
    return keys;
  }

  private async countDisputedLines(client: PoolClient, opnameId: UUID): Promise<number> {
    return (await this.disputedLineKeys(client, opnameId)).size;
  }

  private toOpname(
    row: OpnameHeaderRow,
    lineCount: number,
    totalVarianceValue: Money,
    disputedCount: number,
  ): Opname {
    return {
      id: row.id,
      opnameNumber: row.opname_number,
      locationId: row.location_id,
      locationName: row.location_name,
      storageAreaId: row.storage_area_id,
      status: row.status as OpnameStatus,
      // `counted_by_name` is a LEFT JOIN to `users` (RLS: central-or-self)
      // — a scoped approver reading a count made by someone else legally
      // cannot see that user row. Fall back to the raw id rather than
      // `null`, since `Opname.countedBy` is non-nullable (FR-SO-01: who).
      countedBy: row.counted_by_name ?? row.counted_by,
      startedAt: row.started_at,
      submittedAt: row.submitted_at,
      // Same RLS-visibility caveat as `countedBy` — never let a name gap read as "nobody approved this."
      approvedBy: row.approved_by ? (row.approved_by_name ?? row.approved_by) : null,
      approvedAt: row.approved_at,
      totalVarianceValue,
      lineCount,
      disputedCount,
    };
  }

  private toOpnameLine(row: OpnameLineRow, disputedKeys: ReadonlySet<string>): OpnameLine {
    return {
      id: row.id,
      storageAreaId: row.storage_area_id,
      storageAreaName: row.storage_area_name,
      itemId: row.item_id,
      itemName: row.item_name,
      unitCode: row.unit_code,
      systemQty: row.system_qty,
      countedQty: row.counted_qty,
      diffQty: row.diff_qty,
      varianceReason: row.variance_reason,
      disputed: disputedKeys.has(`${row.storage_area_id}:${row.item_id}`),
    };
  }
}
