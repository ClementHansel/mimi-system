import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  ApprovalDocumentType,
  ERR_CONFLICT,
  ERR_FORBIDDEN,
  ERR_NOT_FOUND,
  ERR_PHOTO_REQUIRED,
  JournalEventType,
  LocationType,
  mulMoneyByQty,
  MovementType,
  RoleKey,
  SyncEntity,
  WasteStatus,
  type Paginated,
  type Qty,
  type UUID,
} from '@mimi/shared';
import { ApprovalService } from '../../kernel/approvals/approvals.service';
import { EventBus } from '../../kernel/events/event-bus.service';
import { StockLedgerService } from '../../kernel/stock-ledger/stock-ledger.service';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';
import { withWrite } from './db-tx';
import type {
  ApproveWasteDto,
  CreateWasteDto,
  ListWasteQueryDto,
  RejectWasteDto,
} from './dto/waste.dto';
import { WasteRepository, type WasteRecordRow } from './waste.repository';
import { toWitaOccurredAt } from '../../common/wita-occurred-at.util';

export interface ActorContext {
  userId: UUID;
  roleKey: RoleKey;
  locationScope: readonly UUID[] | null;
}

export interface WasteListRow {
  id: UUID;
  wasteNumber: string;
  batchId: UUID;
  locationName: string;
  storageAreaName: string;
  itemName: string;
  qty: string;
  unitCost: string;
  reason: string;
  status: string;
  reportedBy: string;
  photoUrls: string[];
  occurredAt: string;
}

/**
 * M12 `waste-return` — waste (FR-WST-01/02/04, CONTRACTS.md §4.12). One
 * `POST /api/waste` call creates a BATCH (`batch_id` shared, N
 * `waste_records` rows, CONTRACTS.md §1.9 comment). `kernel/approvals`'
 * `resolveDocumentContext()` reads a SINGLE `waste_records.id` (not
 * `batch_id`) to route step 1 by the record's own location type — so this
 * service submits/decides ONE approval PER RECORD in the batch (all sharing
 * the same location, so they always resolve the same eligible role), and
 * `/approve`/`/reject` on `:batchId` fan out to every sibling record's own
 * approval in the SAME transaction: either the whole batch's decisions land
 * atomically, or none do. The wire-facing sync event, by contrast, is
 * batch-grained (`@mimi/sync-protocol`'s `waste_records.reported/approved/
 * rejected` schemas carry `batchId`, not a per-record id) — emitted once per
 * batch action, independent of how many approval rows back it.
 */
@Injectable()
export class WasteService {
  constructor(
    private readonly repo: WasteRepository,
    private readonly approvals: ApprovalService,
    private readonly ledger: StockLedgerService,
    private readonly sync: SyncEmitService,
    private readonly eventBus: EventBus,
  ) {}

  async list(client: PoolClient, query: ListWasteQueryDto): Promise<Paginated<WasteListRow>> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;
    const { rows, total } = await this.repo.listRecords(client, {
      locationId: query.locationId,
      status: query.status,
      reason: query.reason,
      from: query.from,
      to: query.to,
      page,
      pageSize,
    });
    const result: WasteListRow[] = [];
    for (const row of rows) result.push(await this.toListRow(client, row));
    return { rows: result, total, page, pageSize };
  }

  async create(
    client: PoolClient,
    actor: ActorContext,
    dto: CreateWasteDto,
  ): Promise<WasteListRow[]> {
    this.assertLocationInScope(actor, dto.locationId);
    if (dto.photoAttachmentIds.length === 0) {
      throw new BadRequestException({
        code: ERR_PHOTO_REQUIRED,
        message: 'At least one photo is wajib for a waste report (FR-WST-01)',
      });
    }

    return withWrite(client, async () => {
      const batchId = randomUUID();
      const recordIds: string[] = [];
      for (const item of dto.items) {
        const wasteNumber = await this.repo.nextWasteNumber(client);
        const id = await this.repo.insertRecord(client, {
          wasteNumber,
          batchId,
          locationId: dto.locationId,
          storageAreaId: item.storageAreaId,
          itemId: item.itemId,
          qty: item.qty as Qty,
          reason: item.reason,
          reasonDetail: item.reasonDetail ?? null,
          reportedBy: actor.userId,
        });
        recordIds.push(id);
      }

      for (const attachmentId of dto.photoAttachmentIds) {
        await client.query(
          `UPDATE attachments SET entity_type = 'waste_record', entity_id = $2 WHERE id = $1 AND entity_id IS NULL`,
          [attachmentId, recordIds[0]],
        );
      }

      // Submit one approval per record (kernel/approvals is keyed per-document); every record shares
      // this batch's single location, so `resolveDocumentContext` resolves identically for each.
      for (let i = 0; i < recordIds.length; i++) {
        const value = mulMoneyByQty(
          await this.repo.itemAvgCost(client, dto.items[i]!.itemId),
          dto.items[i]!.qty as Qty,
        );
        const submitResult = await this.approvals.submit(client, {
          documentType: ApprovalDocumentType.WASTE,
          documentId: recordIds[i]!,
          requestedBy: actor.userId,
          amount: value,
          locationId: dto.locationId,
        });
        await this.repo.setApprovalId(client, recordIds[i]!, submitResult.approvalId);
      }

      await this.sync.emit(client, {
        entity: SyncEntity.WASTE_RECORDS,
        op: 'reported',
        entityId: batchId,
        locationId: dto.locationId,
        actorUserId: actor.userId,
        data: {
          batchId,
          locationId: dto.locationId,
          items: dto.items.map((it) => ({
            storageAreaId: it.storageAreaId,
            itemId: it.itemId,
            qty: it.qty as Qty,
            reason: it.reason,
            reasonDetail: it.reasonDetail ?? undefined,
          })),
          photoAttachmentIds: dto.photoAttachmentIds,
        },
      });

      const rows = await this.repo.findByBatch(client, batchId);
      return Promise.all(rows.map((r) => this.toListRow(client, r)));
    });
  }

  async approve(
    client: PoolClient,
    actor: ActorContext,
    batchId: UUID,
    dto: ApproveWasteDto,
  ): Promise<WasteListRow[]> {
    const records = await this.requireBatch(client, batchId);
    // Every record in a batch shares the SAME `location_id` (one `POST /api/waste` call is one
    // location, per this module's own doc comment) — one lookup for the whole batch, not one per
    // record. B-16 (JOUT-04/JGUD-05): the journal event depends on whether that location is an
    // outlet or a warehouse, read from the DB, never guessed from the location's name/code.
    const locationType = await this.locationType(client, records[0]!.location_id);
    const journalEventType =
      locationType === LocationType.WAREHOUSE
        ? JournalEventType.GUDANG_WASTE
        : JournalEventType.OUTLET_WASTE;

    return withWrite(client, async () => {
      for (const record of records) {
        if (record.status !== WasteStatus.PENDING) {
          throw new ConflictException({
            code: ERR_CONFLICT,
            message: `Waste record ${record.id} is '${record.status}', not 'pending'`,
          });
        }

        const decision = await this.approvals.approve(client, {
          documentType: ApprovalDocumentType.WASTE,
          documentId: record.id,
          currentState: record.status,
          actorUserId: actor.userId,
          actorRole: actor.roleKey,
          reason: dto.note ?? null,
        });
        if (decision.currentStep !== null) continue; // still awaiting a further step (SPV -> MGR above threshold)

        // WITA-labelled (not a bare UTC 'Z' string) so `PostingEngineService`'s `occurredAt.slice(0,10)`
        // lands the journal entry on the correct WITA business day (D-11) — this app's UTC-vs-WITA
        // off-by-one trap, hit twice already, applies to a point-in-time approval just as much as a
        // day aggregate.
        const approvedAt = toWitaOccurredAt();
        const unitCost = await this.repo.itemAvgCost(client, record.item_id);
        await this.repo.setUnitCost(client, record.id, unitCost);
        await this.repo.setApproved(client, record.id, actor.userId, approvedAt);

        await this.ledger.post(
          client,
          [
            {
              locationId: record.location_id,
              storageAreaId: record.storage_area_id,
              itemId: record.item_id,
              movementType: MovementType.WASTE_OUT,
              qty: record.qty,
              unitCost,
              refType: 'waste_record',
              refId: record.id,
              actorId: actor.userId,
              reason: record.reason_detail ?? record.reason,
              occurredAt: approvedAt,
            },
          ],
          'fact',
        );

        // B-16 JOUT-04/JGUD-05 — Dr 5100 Beban Waste / Cr 1110 or 1100 (CONTRACTS.md §6.2), valued
        // at the SAME qty × unit_cost as the stock movement just posted above (never re-derived).
        // `documentId` is the real `waste_records.id` — idempotent under the journal's
        // `UNIQUE (event_type, ref_type, ref_id) WHERE source='system'` against a replayed approval.
        await this.eventBus.publish('journal.action', {
          eventType: journalEventType,
          documentType: 'waste_record',
          documentId: record.id,
          locationId: record.location_id,
          amount: mulMoneyByQty(unitCost, record.qty),
          context: {},
          occurredAt: approvedAt,
        });
      }

      await this.sync.emit(client, {
        entity: SyncEntity.WASTE_RECORDS,
        op: 'approved',
        entityId: batchId,
        locationId: records[0]!.location_id,
        actorUserId: actor.userId,
        data: { note: dto.note ?? undefined },
      });

      const updated = await this.repo.findByBatch(client, batchId);
      return Promise.all(updated.map((r) => this.toListRow(client, r)));
    });
  }

  async reject(
    client: PoolClient,
    actor: ActorContext,
    batchId: UUID,
    dto: RejectWasteDto,
  ): Promise<WasteListRow[]> {
    const records = await this.requireBatch(client, batchId);

    return withWrite(client, async () => {
      for (const record of records) {
        if (record.status !== WasteStatus.PENDING) {
          throw new ConflictException({
            code: ERR_CONFLICT,
            message: `Waste record ${record.id} is '${record.status}', not 'pending'`,
          });
        }
        await this.approvals.reject(client, {
          documentType: ApprovalDocumentType.WASTE,
          documentId: record.id,
          currentState: record.status,
          actorUserId: actor.userId,
          actorRole: actor.roleKey,
          reason: dto.reason,
        });
        await this.repo.setRejected(client, record.id, dto.reason);
      }

      await this.sync.emit(client, {
        entity: SyncEntity.WASTE_RECORDS,
        op: 'rejected',
        entityId: batchId,
        locationId: records[0]!.location_id,
        actorUserId: actor.userId,
        data: { reason: dto.reason },
      });

      const updated = await this.repo.findByBatch(client, batchId);
      return Promise.all(updated.map((r) => this.toListRow(client, r)));
    });
  }

  /** B-16: JOUT-04 vs JGUD-05 turns on the waste's location TYPE, read from `locations` — never inferred from a code/name convention. */
  private async locationType(client: PoolClient, locationId: UUID): Promise<string> {
    const res = await client.query<{ type: string }>(`SELECT type FROM locations WHERE id = $1`, [
      locationId,
    ]);
    if (!res.rows[0])
      throw new NotFoundException({
        code: ERR_NOT_FOUND,
        message: `Location ${locationId} not found`,
      });
    return res.rows[0].type;
  }

  private async requireBatch(client: PoolClient, batchId: UUID): Promise<WasteRecordRow[]> {
    const records = await this.repo.findByBatch(client, batchId);
    if (records.length === 0)
      throw new NotFoundException({
        code: ERR_NOT_FOUND,
        message: `Waste batch ${batchId} not found`,
      });
    return records;
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

  private async toListRow(client: PoolClient, row: WasteRecordRow): Promise<WasteListRow> {
    const photos = await client.query<{ id: string }>(
      `SELECT id FROM attachments WHERE entity_type = 'waste_record' AND entity_id = $1`,
      [row.id],
    );
    return {
      id: row.id,
      wasteNumber: row.waste_number,
      batchId: row.batch_id,
      locationName: row.location_name,
      storageAreaName: row.storage_area_name,
      itemName: row.item_name,
      qty: row.qty,
      unitCost: row.unit_cost,
      reason: row.reason,
      status: row.status,
      reportedBy: row.reported_by_name ?? row.reported_by,
      photoUrls: photos.rows.map((r) => r.id),
      occurredAt: row.occurred_at.toISOString(),
    };
  }
}
