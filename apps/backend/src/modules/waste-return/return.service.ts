import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  ApprovalDocumentType,
  ERR_CONFLICT,
  ERR_FORBIDDEN,
  ERR_NOT_FOUND,
  ERR_PHOTO_REQUIRED,
  ERR_VALIDATION,
  isNegativeQty,
  MovementType,
  ReturnDirection,
  ReturnStatus,
  RoleKey,
  SyncEntity,
  type Money,
  type Paginated,
  type Qty,
  type UUID,
} from '@mimi/shared';
import { ApprovalService } from '../../kernel/approvals/approvals.service';
import { StockLedgerService } from '../../kernel/stock-ledger/stock-ledger.service';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';
import { withWrite } from './db-tx';
import type { CompleteReturnDto, CreateReturnDto, ListReturnQueryDto, ReceiveReturnDto, ShipReturnDto } from './dto/return.dto';
import { ReturnRepository, type ReturnHeaderRow, type ReturnLineRow } from './return.repository';

export interface ActorContext {
  userId: UUID;
  roleKey: RoleKey;
  locationScope: readonly UUID[] | null;
}

export interface ReturnDetail {
  id: UUID;
  returnNumber: string;
  direction: ReturnDirection;
  fromLocationId: UUID;
  fromLocationName: string;
  toLocationName: string | null;
  supplierName: string | null;
  status: string;
  requestedBy: string;
  approvedBy: string | null;
  shippedAt: string | null;
  receivedAt: string | null;
  /** `lineId` — matches `POST /returns/:id/receive`'s request shape (`{lines:{lineId:UUID; ...}}`, CONTRACTS.md §4.12) so the UI has a stable key to receive against instead of falling back to `itemId` (which a return with two lines for the same item in different conditions cannot disambiguate). */
  lines: { lineId: UUID; itemId: UUID; itemName: string; storageAreaId: UUID; qty: string; condition: string; reason: string; qtyReceived: string | null }[];
  proofUrls: { shipped: string[]; received: string[] };
}

/**
 * M12 `waste-return` — returns, both directions (FR-WST-01..04, CONTRACTS.md
 * §4.12, §5.5/§5.6). `kernel/approvals`' `resolveDocumentContext()` reads
 * `returns.direction` itself to route step 1 (SPV for outlet→gudang, KGD for
 * gudang→supplier) — this service supplies the real `documentId` and never
 * re-derives that routing.
 */
@Injectable()
export class ReturnService {
  constructor(
    private readonly repo: ReturnRepository,
    private readonly approvals: ApprovalService,
    private readonly ledger: StockLedgerService,
    private readonly sync: SyncEmitService,
  ) {}

  async list(client: PoolClient, query: ListReturnQueryDto): Promise<Paginated<ReturnDetail>> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;
    const { rows, total } = await this.repo.listHeaders(client, { direction: query.direction, locationId: query.locationId, status: query.status, page, pageSize });
    const result: ReturnDetail[] = [];
    for (const row of rows) {
      const lines = await this.repo.findLines(client, row.id);
      result.push(await this.toDetail(client, row, lines));
    }
    return { rows: result, total, page, pageSize };
  }

  async getDetail(client: PoolClient, id: UUID): Promise<ReturnDetail> {
    const header = await this.requireHeader(client, id);
    const lines = await this.repo.findLines(client, id);
    return this.toDetail(client, header, lines);
  }

  async create(client: PoolClient, actor: ActorContext, dto: CreateReturnDto): Promise<ReturnDetail> {
    this.assertLocationInScope(actor, dto.fromLocationId);
    if (dto.direction === ReturnDirection.OUTLET_TO_WAREHOUSE && !dto.toLocationId) {
      throw new BadRequestException({ code: ERR_VALIDATION, message: 'toLocationId is required for outlet_to_warehouse returns' });
    }
    if (dto.direction === ReturnDirection.WAREHOUSE_TO_SUPPLIER && !dto.supplierId) {
      throw new BadRequestException({ code: ERR_VALIDATION, message: 'supplierId is required for warehouse_to_supplier returns' });
    }
    if (dto.photoAttachmentIds.length === 0) {
      throw new BadRequestException({ code: ERR_PHOTO_REQUIRED, message: 'At least one photo is wajib for a return' });
    }
    if (dto.lines.some((l) => !l.reason?.trim())) {
      throw new BadRequestException({ code: ERR_VALIDATION, message: 'Every return line needs a reason (FR-WST-01)' });
    }
    // `return_lines` carries `UNIQUE (return_id, item_id)` (migration block 081) — a return can only
    // ever hold ONE line per item, full stop, regardless of condition (some damaged + some expired for
    // the SAME item is not two lines, it is one line the caller must pick a single `condition`/`reason`
    // for, or split across two SEPARATE returns). Rejecting up front with a clear `ERR_VALIDATION`
    // here is strictly better than letting the caller hit a raw Postgres unique-violation on insert.
    const duplicateItemIds = dto.lines.map((l) => l.itemId).filter((itemId, idx, all) => all.indexOf(itemId) !== idx);
    if (duplicateItemIds.length > 0) {
      throw new BadRequestException({
        code: ERR_VALIDATION,
        message: `A return may only have one line per item — itemId(s) repeated: ${[...new Set(duplicateItemIds)].join(', ')}`,
      });
    }

    return withWrite(client, async () => {
      const returnNumber = await this.repo.nextReturnNumber(client);
      const id = await this.repo.insertHeader(client, {
        returnNumber, direction: dto.direction, fromLocationId: dto.fromLocationId,
        toLocationId: dto.toLocationId ?? null, supplierId: dto.supplierId ?? null, requestedBy: actor.userId,
      });

      for (const line of dto.lines) {
        const itemRes = await client.query<{ avg_cost: string }>(`SELECT avg_cost FROM items WHERE id = $1`, [line.itemId]);
        const unitCost = (itemRes.rows[0]?.avg_cost ?? '0.00') as Money;
        await this.repo.insertLine(client, {
          returnId: id, itemId: line.itemId, storageAreaId: line.storageAreaId, qty: line.qty as Qty,
          condition: line.condition, reason: line.reason, unitCost,
        });
      }

      for (const attachmentId of dto.photoAttachmentIds) {
        await client.query(`UPDATE attachments SET entity_type = 'return', entity_id = $2 WHERE id = $1 AND entity_id IS NULL`, [attachmentId, id]);
      }

      return this.getDetail(client, id);
    });
  }

  async submit(client: PoolClient, actor: ActorContext, id: UUID): Promise<ReturnDetail> {
    const header = await this.requireHeader(client, id);
    this.assertLocationInScope(actor, header.from_location_id);
    if (header.status !== ReturnStatus.DRAFT) {
      throw new ConflictException({ code: ERR_CONFLICT, message: `Return ${id} is '${header.status}', not 'draft'` });
    }

    return withWrite(client, async () => {
      await this.repo.setStatus(client, id, ReturnStatus.SUBMITTED);
      const lines = await this.repo.findLines(client, id);
      const totalValue = lines.reduce((sum, l) => sum + Number(l.qty) * Number(l.unit_cost), 0);

      const submitResult = await this.approvals.submit(client, {
        documentType: ApprovalDocumentType.RETURN,
        documentId: id,
        requestedBy: actor.userId,
        amount: totalValue.toFixed(2) as Money,
        locationId: header.from_location_id,
      });
      await this.repo.setApprovalId(client, id, submitResult.approvalId);

      const creationPhotoIds = await this.creationPhotoIds(client, id);
      await this.sync.emit(client, {
        entity: SyncEntity.RETURNS,
        op: 'submitted',
        entityId: id,
        locationId: header.from_location_id,
        actorUserId: actor.userId,
        data: {
          id, direction: header.direction, fromLocationId: header.from_location_id, toLocationId: header.to_location_id ?? undefined,
          supplierId: header.supplier_id ?? undefined,
          lines: lines.map((l) => ({ itemId: l.item_id, storageAreaId: l.storage_area_id, qty: l.qty, condition: l.condition, reason: l.reason })),
          photoAttachmentIds: creationPhotoIds,
        },
      });

      return this.getDetail(client, id);
    });
  }

  async approve(client: PoolClient, actor: ActorContext, id: UUID, note: string | undefined): Promise<ReturnDetail> {
    const header = await this.requireHeader(client, id);
    if (header.status !== ReturnStatus.SUBMITTED) {
      throw new ConflictException({ code: ERR_CONFLICT, message: `Return ${id} is '${header.status}', not 'submitted'` });
    }

    return withWrite(client, async () => {
      const decision = await this.approvals.approve(client, {
        documentType: ApprovalDocumentType.RETURN,
        documentId: id,
        currentState: header.status,
        actorUserId: actor.userId,
        actorRole: actor.roleKey,
        reason: note ?? null,
      });
      if (decision.currentStep === null) {
        await this.repo.setApproved(client, id, actor.userId, new Date().toISOString());
        await this.sync.emit(client, { entity: SyncEntity.RETURNS, op: 'approved', entityId: id, locationId: header.from_location_id, actorUserId: actor.userId, data: { note: note ?? undefined } });
      }
      return this.getDetail(client, id);
    });
  }

  async reject(client: PoolClient, actor: ActorContext, id: UUID, reason: string): Promise<ReturnDetail> {
    const header = await this.requireHeader(client, id);
    if (header.status !== ReturnStatus.SUBMITTED) {
      throw new ConflictException({ code: ERR_CONFLICT, message: `Return ${id} is '${header.status}', not 'submitted'` });
    }

    return withWrite(client, async () => {
      await this.approvals.reject(client, {
        documentType: ApprovalDocumentType.RETURN,
        documentId: id,
        currentState: header.status,
        actorUserId: actor.userId,
        actorRole: actor.roleKey,
        reason,
      });
      await this.repo.setRejected(client, id, reason);
      await this.sync.emit(client, { entity: SyncEntity.RETURNS, op: 'rejected', entityId: id, locationId: header.from_location_id, actorUserId: actor.userId, data: { reason } });
      return this.getDetail(client, id);
    });
  }

  async ship(client: PoolClient, actor: ActorContext, id: UUID, dto: ShipReturnDto): Promise<ReturnDetail> {
    const header = await this.requireHeader(client, id);
    if (header.status !== ReturnStatus.APPROVED) {
      throw new ConflictException({ code: ERR_CONFLICT, message: `Return ${id} is '${header.status}', not 'approved'` });
    }
    if (dto.proofAttachmentIds.length === 0) {
      throw new BadRequestException({ code: ERR_PHOTO_REQUIRED, message: 'At least one shipping proof photo is wajib (FR-WST-03)' });
    }

    return withWrite(client, async () => {
      const shippedAt = new Date().toISOString();
      const lines = await this.repo.findLines(client, id);
      const movements = lines.map((l) => ({
        locationId: header.from_location_id,
        storageAreaId: l.storage_area_id,
        itemId: l.item_id,
        movementType: MovementType.RETURN_OUT,
        qty: l.qty,
        unitCost: l.unit_cost,
        refType: 'return',
        refId: id,
        actorId: actor.userId,
        reason: l.reason,
        occurredAt: shippedAt,
      }));
      await this.ledger.post(client, movements, 'strict');

      await this.repo.setShipped(client, id, shippedAt);
      for (const attachmentId of dto.proofAttachmentIds) {
        await client.query(`UPDATE attachments SET entity_type = 'return', entity_id = $2, kind = 'return_proof' WHERE id = $1`, [attachmentId, id]);
      }

      // `returns.shipped_back` (@mimi/sync-protocol) is documented as the outlet leg only — the
      // supplier leg (warehouse_to_supplier) is class X for this specific fact (no device needs it).
      if (header.direction === ReturnDirection.OUTLET_TO_WAREHOUSE) {
        await this.sync.emit(client, {
          entity: SyncEntity.RETURNS, op: 'shipped_back', entityId: id, locationId: header.from_location_id, actorUserId: actor.userId,
          data: { proofAttachmentIds: dto.proofAttachmentIds },
        });
      }

      return this.getDetail(client, id);
    });
  }

  async receive(client: PoolClient, actor: ActorContext, id: UUID, dto: ReceiveReturnDto): Promise<ReturnDetail> {
    const header = await this.requireHeader(client, id);
    if (header.direction !== ReturnDirection.OUTLET_TO_WAREHOUSE) {
      throw new BadRequestException({ code: ERR_VALIDATION, message: 'Only outlet_to_warehouse returns are received at the warehouse' });
    }
    if (header.status !== ReturnStatus.IN_TRANSIT) {
      throw new ConflictException({ code: ERR_CONFLICT, message: `Return ${id} is '${header.status}', not 'in_transit'` });
    }
    if (dto.proofAttachmentIds.length === 0) {
      throw new BadRequestException({ code: ERR_PHOTO_REQUIRED, message: 'At least one receiving proof photo is wajib' });
    }

    return withWrite(client, async () => {
      const receivedAt = new Date().toISOString();
      for (const line of dto.lines) {
        const rl = await this.repo.findLineById(client, id, line.lineId);
        if (!rl) throw new NotFoundException({ code: ERR_NOT_FOUND, message: `Return line ${line.lineId} not found on return ${id}` });
        if (isNegativeQty(line.qtyReceived)) {
          throw new BadRequestException({ code: ERR_VALIDATION, message: `qtyReceived must be >= 0 for line ${line.lineId}` });
        }
        await this.repo.setLineReceived(client, line.lineId, line.qtyReceived as Qty);

        if (Number(line.qtyReceived) > 0) {
          await this.ledger.post(
            client,
            [{
              locationId: header.to_location_id!,
              storageAreaId: line.storageAreaId,
              itemId: rl.item_id,
              movementType: MovementType.RETURN_IN,
              qty: line.qtyReceived as Qty,
              unitCost: rl.unit_cost,
              refType: 'return',
              refId: id,
              actorId: actor.userId,
              occurredAt: receivedAt,
            }],
            'strict',
          );
        }
      }

      await this.repo.setReceived(client, id, actor.userId, receivedAt);
      for (const attachmentId of dto.proofAttachmentIds) {
        await client.query(`UPDATE attachments SET entity_type = 'return', entity_id = $2, kind = 'receiving_photo' WHERE id = $1`, [attachmentId, id]);
      }

      await this.sync.emit(client, {
        entity: SyncEntity.RETURNS, op: 'received_at_warehouse', entityId: id, locationId: header.to_location_id, actorUserId: actor.userId,
        data: { lines: dto.lines.map((l) => ({ lineId: l.lineId, qtyReceived: l.qtyReceived, storageAreaId: l.storageAreaId })), proofAttachmentIds: dto.proofAttachmentIds },
      });

      return this.getDetail(client, id);
    });
  }

  async complete(client: PoolClient, id: UUID, dto: CompleteReturnDto): Promise<ReturnDetail> {
    const header = await this.requireHeader(client, id);
    const expectedFromStatus = header.direction === ReturnDirection.OUTLET_TO_WAREHOUSE ? ReturnStatus.RECEIVED : ReturnStatus.IN_TRANSIT;
    if (header.status !== expectedFromStatus) {
      throw new ConflictException({ code: ERR_CONFLICT, message: `Return ${id} is '${header.status}', not '${expectedFromStatus}'` });
    }

    return withWrite(client, async () => {
      if (header.direction === ReturnDirection.WAREHOUSE_TO_SUPPLIER && dto.creditNoteRef) {
        await client.query(`UPDATE returns SET notes = COALESCE(notes, '') || $2 WHERE id = $1`, [id, ` [credit note: ${dto.creditNoteRef}]`]);
      }
      await this.repo.setCompleted(client, id);
      // No wire op exists for 'completed' (@mimi/sync-protocol: the supplier leg is class X, and the
      // outlet leg's completion is a cloud-side bookkeeping close, not a fact a device needs pushed).
      return this.getDetail(client, id);
    });
  }

  private async creationPhotoIds(client: PoolClient, returnId: UUID): Promise<UUID[]> {
    const res = await client.query<{ id: string }>(
      `SELECT id FROM attachments WHERE entity_type = 'return' AND entity_id = $1 AND kind NOT IN ('return_proof','receiving_photo')`,
      [returnId],
    );
    return res.rows.map((r) => r.id);
  }

  private async requireHeader(client: PoolClient, id: UUID): Promise<ReturnHeaderRow> {
    const header = await this.repo.findHeader(client, id);
    if (!header) throw new NotFoundException({ code: ERR_NOT_FOUND, message: `Return ${id} not found` });
    return header;
  }

  private assertLocationInScope(actor: ActorContext, locationId: UUID): void {
    if (actor.locationScope === null) return;
    if (!actor.locationScope.includes(locationId)) {
      throw new ForbiddenException({ code: ERR_FORBIDDEN, message: `Role '${actor.roleKey}' is not assigned to location ${locationId}` });
    }
  }

  private async toDetail(client: PoolClient, header: ReturnHeaderRow, lines: ReturnLineRow[]): Promise<ReturnDetail> {
    const proofUrls = await this.repo.proofUrls(client, header.id);
    return {
      id: header.id,
      returnNumber: header.return_number,
      direction: header.direction as ReturnDirection,
      fromLocationId: header.from_location_id,
      fromLocationName: header.from_location_name,
      toLocationName: header.to_location_name,
      supplierName: header.supplier_name,
      status: header.status,
      requestedBy: header.requested_by_name ?? header.requested_by,
      approvedBy: header.approved_by,
      shippedAt: header.shipped_at ? header.shipped_at.toISOString() : null,
      receivedAt: header.received_at ? header.received_at.toISOString() : null,
      lines: lines.map((l) => ({
        lineId: l.id, itemId: l.item_id, itemName: l.item_name, storageAreaId: l.storage_area_id,
        qty: l.qty, condition: l.condition, reason: l.reason, qtyReceived: l.qty_received,
      })),
      proofUrls,
    };
  }
}
