import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  addMoney,
  sumMoney,
  ERR_CONFLICT,
  ERR_NOT_FOUND,
  ERR_VALIDATION,
  isZeroQty,
  JournalEventType,
  MovementType,
  PettyCashStatus,
  SyncEntity,
  type Money,
  type Paginated,
  type Qty,
  type UUID,
} from '@mimi/shared';
import { formatDateOnly } from '../../common/date-only.util';
import { StockLedgerService } from '../../kernel/stock-ledger/stock-ledger.service';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';
import { PaymentVerificationsService } from '../accounting/payment-verifications.service';
import { EventBus } from '../../kernel/events/event-bus.service';
import { toWitaOccurredAt } from '../../common/wita-occurred-at.util';
import { withWrite } from './db-tx';
import type { CreatePettyCashDto, ListPettyCashQueryDto } from './dto/petty-cash.dto';
import {
  PettyCashRepository,
  type PettyCashHeaderRow,
  type PettyCashLineRow,
} from './petty-cash.repository';
import type { ActorContext } from './purchase-request.service';

export interface PettyCashDetail {
  id: UUID;
  pcNumber: string;
  locationId: UUID;
  purchasedBy: string;
  purchaseDate: string;
  storeName: string;
  totalAmount: Money;
  status: string;
  verifiedBy: string | null;
  photoUrls: string[];
  lines: {
    description: string;
    itemId: UUID | null;
    qty: string | null;
    amount: string;
    expenseCategory: string;
  }[];
}

/**
 * M11 `purchasing` — petty cash (PRD 8.6.1, CONTRACTS.md §4.11). NOT routed
 * through `kernel/approvals` — no `ApprovalDocumentType` member exists for
 * it (unlike PR/PO/waste/return): the wire vocabulary
 * (`@mimi/sync-protocol`'s `petty_cash` entity) only ever carries
 * `pending → verified/rejected`, a plain two-state ladder Finance/Manager
 * decide directly, matching CONTRACTS.md §4.11's endpoint table having no
 * `/submit` step for it.
 */
/**
 * A petty-cash line is STOCKABLE when it names an item, an area to put it in,
 * and a non-zero quantity — i.e. it became inventory rather than being spent.
 *
 * Extracted to one predicate because two places depend on the same answer: the
 * ledger loop that posts `purchase_in`, and the B-16 journal split between
 * JOUT-07 (direct purchase, Dr 1110) and JOUT-08 (petty cash expense, Dr
 * 6100). If those two ever disagreed, stock and the ledger would silently
 * describe different purchases.
 * Declared as a type GUARD, not a plain boolean: the inline check it replaced
 * was what narrowed `item_id`/`storage_area_id`/`qty` to non-null for the
 * ledger call below, and a boolean would push the loop back to non-null
 * assertions.
 */
type StockableLine = PettyCashLineRow & { item_id: string; storage_area_id: string; qty: Qty };

function isStockableLine(line: PettyCashLineRow): line is StockableLine {
  return !!line.item_id && !!line.storage_area_id && !!line.qty && !isZeroQty(line.qty);
}

@Injectable()
export class PettyCashService {
  constructor(
    private readonly repo: PettyCashRepository,
    private readonly ledger: StockLedgerService,
    private readonly sync: SyncEmitService,
    private readonly payments: PaymentVerificationsService,
    private readonly eventBus: EventBus,
  ) {}

  async list(
    client: PoolClient,
    query: ListPettyCashQueryDto,
  ): Promise<Paginated<PettyCashDetail>> {
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
    const result: PettyCashDetail[] = [];
    for (const row of rows) {
      const lines = await this.repo.findLines(client, row.id);
      result.push(await this.toDetail(client, row, lines));
    }
    return { rows: result, total, page, pageSize };
  }

  /**
   * B-11: `opts.id` is the id the DEVICE minted for a claim recorded while
   * offline (a supervisor buying onions during an outage). Supplying it makes a
   * replayed push a no-op instead of a duplicate claim against the cash float.
   */
  async create(
    client: PoolClient,
    actor: ActorContext,
    dto: CreatePettyCashDto,
    opts: { id?: UUID } = {},
  ): Promise<PettyCashDetail> {
    // Idempotency, only for a caller-supplied id.
    if (opts.id) {
      const existing = await this.repo.findHeader(client, opts.id);
      if (existing) {
        return this.toDetail(client, existing, await this.repo.findLines(client, opts.id));
      }
    }

    if (dto.lines.length === 0) {
      throw new BadRequestException({
        code: ERR_VALIDATION,
        message: 'A petty cash claim needs at least one line',
      });
    }

    return withWrite(client, async () => {
      let total: Money = '0.00' as Money;
      for (const line of dto.lines) total = addMoney(total, line.amount as Money);

      const pcNumber = await this.repo.nextPcNumber(client);
      const id = await this.repo.insertHeader(client, {
        id: opts.id,
        pcNumber,
        locationId: dto.locationId,
        purchasedBy: actor.userId,
        purchaseDate: dto.purchaseDate,
        storeName: dto.storeName,
        totalAmount: total,
      });

      const eventLines = [];
      for (const line of dto.lines) {
        await this.repo.insertLine(client, {
          pettyCashId: id,
          description: line.description,
          itemId: line.itemId ?? null,
          storageAreaId: line.storageAreaId ?? null,
          qty: (line.qty ?? null) as Qty | null,
          amount: line.amount as Money,
          expenseCategory: line.expenseCategory,
        });
        eventLines.push({
          description: line.description,
          itemId: line.itemId ?? null,
          storageAreaId: line.storageAreaId,
          qty: (line.qty ?? null) as Qty | null,
          amount: line.amount as Money,
          expenseCategory: line.expenseCategory,
        });
      }

      for (const attachmentId of [dto.paymentProofAttachmentId, dto.goodsPhotoAttachmentId]) {
        await client.query(
          `UPDATE attachments SET entity_type = 'petty_cash', entity_id = $2 WHERE id = $1 AND entity_id IS NULL`,
          [attachmentId, id],
        );
      }

      await this.sync.emit(client, {
        entity: SyncEntity.PETTY_CASH,
        op: 'recorded',
        entityId: id,
        locationId: dto.locationId,
        actorUserId: actor.userId,
        data: {
          id,
          locationId: dto.locationId,
          purchasedBy: actor.userId,
          purchaseDate: dto.purchaseDate,
          storeName: dto.storeName,
          lines: eventLines,
          paymentProofAttachmentId: dto.paymentProofAttachmentId,
          goodsPhotoAttachmentId: dto.goodsPhotoAttachmentId,
        },
      });

      const header = await this.requireHeader(client, id);
      const lines = await this.repo.findLines(client, id);
      return this.toDetail(client, header, lines);
    });
  }

  async verify(
    client: PoolClient,
    actor: ActorContext,
    id: UUID,
    note: string | undefined,
  ): Promise<PettyCashDetail> {
    const header = await this.requireHeader(client, id);
    if (header.status !== PettyCashStatus.PENDING) {
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: `Petty cash ${id} is '${header.status}', not 'pending'`,
      });
    }

    return withWrite(client, async () => {
      const verifiedAt = new Date().toISOString();
      await this.repo.setVerified(client, id, actor.userId, verifiedAt);

      const lines = await this.repo.findLines(client, id);
      for (const line of lines) {
        if (!isStockableLine(line)) continue;
        const costing = await this.repo.itemCosting(client, line.item_id);
        const unitCost =
          costing && Number(line.qty) > 0 ? this.perUnitCost(line.amount, line.qty) : line.amount;
        await this.ledger.post(
          client,
          [
            {
              locationId: header.location_id,
              storageAreaId: line.storage_area_id,
              itemId: line.item_id,
              movementType: MovementType.PURCHASE_IN,
              qty: line.qty,
              unitCost,
              refType: 'petty_cash',
              refId: id,
              actorId: actor.userId,
            },
          ],
          'strict',
        );
        if (costing) {
          const newAvg = this.computeMovingAverage(
            costing.qtyOnHand,
            costing.avgCost,
            line.qty,
            unitCost,
          );
          await this.repo.updateItemCost(client, line.item_id, newAvg, unitCost);
        }
      }

      // ── B-16 JOUT-07/JOUT-08 ────────────────────────────────────────────
      // One petty-cash slip can be BOTH: a supervisor buys 5kg of onions and
      // pays the parking attendant on the same trip. The stockable lines
      // became inventory (posted to the ledger above) and the rest was spent,
      // so they post as two different journal events, split by exactly the
      // same test the stock loop used — never by re-deciding what "stockable"
      // means, which is how the two halves would drift apart.
      const stockableTotal = sumMoney(lines.filter(isStockableLine).map((l) => l.amount as Money));
      const expenseTotal = sumMoney(
        lines.filter((l) => !isStockableLine(l)).map((l) => l.amount as Money),
      );
      const journalOccurredAt = toWitaOccurredAt();

      if (stockableTotal !== '0.00') {
        await this.eventBus.publish('journal.action', {
          eventType: JournalEventType.OUTLET_DIRECT_PURCHASE,
          documentType: 'petty_cash',
          documentId: id,
          locationId: header.location_id,
          amount: stockableTotal,
          // NOT `po_receipt`: this was paid out of the outlet's cash float, so
          // the credit is 1010 Kas Kecil, not 2000 Hutang Usaha. Getting this
          // context wrong silently books a payable that nobody owes.
          context: { source: 'petty_cash' },
          occurredAt: journalOccurredAt,
        });
      }

      if (expenseTotal !== '0.00') {
        await this.eventBus.publish('journal.action', {
          eventType: JournalEventType.OUTLET_PETTY_CASH,
          documentType: 'petty_cash',
          documentId: id,
          locationId: header.location_id,
          amount: expenseTotal,
          // No `expenseAccountCode`: mapping an expense category to a GL
          // account is called out as a future refinement in CONTRACTS §6.2,
          // and the engine already defaults to 6100. Passing a guessed code
          // would be worse than taking the documented default.
          context: {},
          occurredAt: journalOccurredAt,
        });
      }

      if (!header.payment_verification_id) {
        const pvId = await this.payments.createSystemVerification(
          client,
          { role: actor.roleKey, userId: actor.userId, locationIds: actor.locationScope ?? [] },
          {
            refType: 'petty_cash',
            refId: id,
            payeeType: 'other',
            payeeId: null,
            amount: header.total_amount,
            locationId: header.location_id,
            submittedBy: actor.userId,
            notes: header.store_name,
          },
        );
        await this.repo.setPaymentVerificationId(client, id, pvId);
      }

      await this.sync.emit(client, {
        entity: SyncEntity.PETTY_CASH,
        op: 'verified',
        entityId: id,
        locationId: header.location_id,
        actorUserId: actor.userId,
        data: { note: note ?? undefined },
      });

      const updated = await this.requireHeader(client, id);
      return this.toDetail(client, updated, lines);
    });
  }

  async reject(
    client: PoolClient,
    actor: ActorContext,
    id: UUID,
    reason: string,
  ): Promise<PettyCashDetail> {
    const header = await this.requireHeader(client, id);
    if (header.status !== PettyCashStatus.PENDING) {
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: `Petty cash ${id} is '${header.status}', not 'pending'`,
      });
    }

    return withWrite(client, async () => {
      await this.repo.setRejected(client, id, reason);
      await this.sync.emit(client, {
        entity: SyncEntity.PETTY_CASH,
        op: 'rejected',
        entityId: id,
        locationId: header.location_id,
        actorUserId: actor.userId,
        data: { reason },
      });
      const updated = await this.requireHeader(client, id);
      const lines = await this.repo.findLines(client, id);
      return this.toDetail(client, updated, lines);
    });
  }

  private perUnitCost(amount: Money, qty: Qty): Money {
    const q = Number(qty);
    if (q <= 0) return amount;
    return (Number(amount) / q).toFixed(2) as Money;
  }

  private computeMovingAverage(
    existingQty: Qty,
    existingAvgCost: Money,
    receivedQty: Qty,
    unitPrice: Money,
  ): Money {
    const existing = Number(existingQty);
    if (existing <= 0) return unitPrice;
    const received = Number(receivedQty);
    const total = existing + received;
    const avg =
      total > 0
        ? (existing * Number(existingAvgCost) + received * Number(unitPrice)) / total
        : Number(unitPrice);
    return avg.toFixed(2) as Money;
  }

  private async requireHeader(client: PoolClient, id: UUID): Promise<PettyCashHeaderRow> {
    const header = await this.repo.findHeader(client, id);
    if (!header)
      throw new NotFoundException({ code: ERR_NOT_FOUND, message: `Petty cash ${id} not found` });
    return header;
  }

  private async toDetail(
    client: PoolClient,
    header: PettyCashHeaderRow,
    lines: PettyCashLineRow[],
  ): Promise<PettyCashDetail> {
    const photoRes = await client.query<{ id: string }>(
      `SELECT id FROM attachments WHERE entity_type = 'petty_cash' AND entity_id = $1`,
      [header.id],
    );
    return {
      id: header.id,
      pcNumber: header.pc_number,
      locationId: header.location_id,
      purchasedBy: header.purchased_by_name ?? header.purchased_by,
      purchaseDate: formatDateOnly(header.purchase_date),
      storeName: header.store_name,
      totalAmount: header.total_amount,
      status: header.status,
      verifiedBy: header.verified_by ? (header.verified_by_name ?? header.verified_by) : null,
      photoUrls: photoRes.rows.map((r) => r.id),
      lines: lines.map((l) => ({
        description: l.description,
        itemId: l.item_id,
        qty: l.qty,
        amount: l.amount,
        expenseCategory: l.expense_category,
      })),
    };
  }
}
