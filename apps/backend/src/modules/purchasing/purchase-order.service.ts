import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  addMoney,
  ApprovalDocumentType,
  clampMoneyToZero,
  compareMoney,
  compareQty,
  ERR_CONFLICT,
  ERR_NOT_FOUND,
  ERR_PHOTO_REQUIRED,
  ERR_VALIDATION,
  ERR_VARIANCE_REASON_REQUIRED,
  isNegativeMoney,
  isNegativeQty,
  isZeroMoney,
  isZeroQty,
  JournalEventType,
  JournalSystemEventType,
  MovementType,
  minMoney,
  mulMoneyByQty,
  PoPaymentState,
  PurchaseOrderStatus,
  subMoney,
  sumMoney,
  ZERO_MONEY,
  type ApprovalDetail,
  type Money,
  type Paginated,
  type PaymentStatus,
  type Qty,
  type UUID,
} from '@mimi/shared';
import { formatDateOnly } from '../../common/date-only.util';
import { toWitaOccurredAt } from '../../common/wita-occurred-at.util';
import { ApprovalService } from '../../kernel/approvals/approvals.service';
import { EventBus } from '../../kernel/events/event-bus.service';
import { StockLedgerService } from '../../kernel/stock-ledger/stock-ledger.service';
import { PaymentVerificationsService } from '../accounting/payment-verifications.service';
import { withWrite } from './db-tx';
import type {
  CreatePoPaymentDto,
  CreatePoReceiptDto,
  CreatePurchaseOrderDto,
  ListPurchaseOrderQueryDto,
  UpdatePurchaseOrderDto,
} from './dto/purchase-order.dto';
import {
  PurchaseOrderRepository,
  type PoHeaderRow,
  type PoLineRow,
} from './purchase-order.repository';
import { PurchaseRequestService } from './purchase-request.service';
import type { ActorContext } from './purchase-request.service';

export interface PurchaseOrderListRow {
  id: UUID;
  poNumber: string;
  supplierId: UUID;
  supplierName: string;
  locationId: UUID;
  status: string;
  orderDate: string;
  expectedDate: string | null;
  total: Money;
  /**
   * CONTRACTS.md §4.11's `PurchaseOrder.approval`. `null` unconditionally on
   * LIST rows (`toListRow`, never fetched — this field's real value requires
   * a per-document `kernel/approvals` round trip and a list endpoint can
   * return dozens of rows; `modules/replenishment`'s `list()`/`toResource(r,
   * [], null)` sets the same precedent for the same reason). Populated for
   * real on `getDetail`'s single-document `toDetail` below.
   */
  approval: ApprovalDetail | null;
  /**
   * CONTRACTS.md §4.11's `PurchaseOrder.paymentStatus` — the linked
   * `payment_verifications.status` (LEFT JOIN in `PurchaseOrderRepository`'s
   * `HEADER_SELECT`, so unlike `approval` this one IS populated on list rows
   * too: it's a single scalar column, not a multi-row chain, so there's no
   * N+1 cost to avoid). `'rejected'` is a real status a linked PV can reach
   * (`PaymentVerificationsService.reject()`) but isn't a `PaymentStatus`
   * enum member (`@mimi/shared` only has pending/verified/paid) — same
   * widened type `PaymentVerification.status` already uses in
   * `packages/shared/src/interfaces/index.ts`.
   */
  paymentStatus: PaymentStatus | 'rejected' | null;
  /**
   * Migration 268 — how much of THIS ORDER is paid, aggregated over every
   * voucher pointing at it. `paymentStatus` above describes a single voucher's
   * ladder position and cannot answer the question once a PO has a DP plus
   * instalments: a paid DP and an untouched balance leaves the first voucher
   * reading `paid` over an order that is nowhere near settled.
   *
   * `null` carries the same meaning it does on `paymentStatus`: the caller is
   * not allowed to see this PO's vouchers, which is NOT the same as there
   * being none. Rendering it as "Belum Dibayar" would state a falsehood.
   */
  payment: PoPaymentSummary | null;
}

/** The money position of one purchase order (migration 268). All fields are absolute, never deltas. */
export interface PoPaymentSummary {
  state: PoPaymentState;
  /** The order's own total — what `paidTotal` is measured against. */
  orderTotal: Money;
  /** Σ of vouchers that reached `paid`, advances included. */
  paidTotal: Money;
  /** Σ of vouchers still `pending`/`verified`. Money committed, not yet gone. */
  inFlightTotal: Money;
  /** `orderTotal - paidTotal`, floored at zero — what may still be raised as a new voucher. */
  outstanding: Money;
  /** Σ of PAID down payments. */
  advancePaid: Money;
  /** The part of `advancePaid` that receiving has NOT yet reclassified into the payable. */
  advanceUnapplied: Money;
}

export interface PurchaseOrderDetail extends PurchaseOrderListRow {
  paymentTermsDays: number;
  subtotal: Money;
  tax: Money;
  prId: UUID | null;
  cancelReason: string | null;
  notes: string | null;
  lines: {
    id: UUID;
    itemId: UUID;
    itemName: string;
    unitCode: string;
    qtyOrdered: string;
    unitPrice: string;
    lineTotal: string;
    qtyReceived: string;
    qtyDifference: string;
  }[];
}

/**
 * M11 `purchasing` — purchase orders + receiving (FR-PO-01..04, CONTRACTS.md
 * §4.11, §5.3). PO chain is MGR → OWN above threshold via `kernel/approvals`.
 * Receiving posts `purchase_in` through `StockLedgerService` ('strict' mode
 * — a PO receipt is an interactive, online-only action, never a replayed
 * offline fact) and recomputes the item's moving-average cost + appends
 * `supplier_price_history` itself (D-04: `StockLedgerService` only owns
 * `stock_balances`/`stock_movements`, never `items.avg_cost`).
 *
 * `PurchaseOrderStatus` and `po_receipts`/`purchase_orders` are ALL class X
 * in `@mimi/sync-protocol`'s authority matrix (`direction: 'none'`) — never
 * call `SyncEmitService` for them (see `purchase-request.service.ts`'s doc
 * comment for the full reasoning; identical here).
 */
@Injectable()
export class PurchaseOrderService {
  constructor(
    private readonly repo: PurchaseOrderRepository,
    private readonly approvals: ApprovalService,
    private readonly ledger: StockLedgerService,
    private readonly payments: PaymentVerificationsService,
    private readonly prService: PurchaseRequestService,
    private readonly eventBus: EventBus,
  ) {}

  async list(
    client: PoolClient,
    query: ListPurchaseOrderQueryDto,
  ): Promise<Paginated<PurchaseOrderListRow>> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;
    const { rows, total } = await this.repo.listHeaders(client, {
      supplierId: query.supplierId,
      status: query.status,
      from: query.from,
      to: query.to,
      page,
      pageSize,
    });
    return { rows: rows.map((r) => this.toListRow(r)), total, page, pageSize };
  }

  async getDetail(client: PoolClient, id: UUID): Promise<PurchaseOrderDetail> {
    const header = await this.requireHeader(client, id);
    const lines = await this.repo.findLines(client, id);
    return this.toDetail(client, header, lines);
  }

  async create(
    client: PoolClient,
    actor: ActorContext,
    dto: CreatePurchaseOrderDto,
  ): Promise<PurchaseOrderDetail> {
    if (dto.lines.length === 0) {
      throw new BadRequestException({
        code: ERR_VALIDATION,
        message: 'A purchase order needs at least one line',
      });
    }

    return withWrite(client, async () => {
      const poNumber = await this.repo.nextPoNumber(client);
      const id = await this.repo.insertHeader(client, {
        poNumber,
        supplierId: dto.supplierId,
        locationId: dto.locationId,
        prId: dto.prId ?? null,
        orderDate: dto.orderDate,
        expectedDate: dto.expectedDate ?? null,
        paymentTermsDays: 0,
        createdBy: actor.userId,
        notes: dto.notes ?? null,
      });

      let subtotal: Money = '0.00' as Money;
      for (const line of dto.lines) {
        const lineTotal = mulMoneyByQty(line.unitPrice as Money, line.qtyOrdered as Qty);
        subtotal = addMoney(subtotal, lineTotal);
        await this.repo.insertLine(client, {
          poId: id,
          itemId: line.itemId,
          unitId: line.unitId,
          qtyOrdered: line.qtyOrdered as Qty,
          unitPrice: line.unitPrice as Money,
          lineTotal,
        });
      }
      await this.repo.setTotals(client, id, subtotal, '0.00' as Money, subtotal);

      if (dto.prId) {
        await this.prService.markConverted(client, dto.prId);
      }

      return this.getDetail(client, id);
    });
  }

  async update(
    client: PoolClient,
    id: UUID,
    dto: UpdatePurchaseOrderDto,
  ): Promise<PurchaseOrderDetail> {
    const header = await this.requireHeader(client, id);
    if (header.status !== PurchaseOrderStatus.DRAFT) {
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: `PO ${id} is '${header.status}' — only a draft PO can be edited`,
      });
    }

    return withWrite(client, async () => {
      if (dto.orderDate || dto.expectedDate !== undefined) {
        await client.query(
          `UPDATE purchase_orders SET order_date = COALESCE($2, order_date), expected_date = $3, notes = COALESCE($4, notes), updated_at = NOW() WHERE id = $1`,
          [
            id,
            dto.orderDate ?? null,
            dto.expectedDate ?? header.expected_date,
            dto.notes ?? header.notes,
          ],
        );
      } else if (dto.notes !== undefined) {
        await client.query(
          `UPDATE purchase_orders SET notes = $2, updated_at = NOW() WHERE id = $1`,
          [id, dto.notes],
        );
      }

      if (dto.lines) {
        await this.repo.deleteLines(client, id);
        let subtotal: Money = '0.00' as Money;
        for (const line of dto.lines) {
          const lineTotal = mulMoneyByQty(line.unitPrice as Money, line.qtyOrdered as Qty);
          subtotal = addMoney(subtotal, lineTotal);
          await this.repo.insertLine(client, {
            poId: id,
            itemId: line.itemId,
            unitId: line.unitId,
            qtyOrdered: line.qtyOrdered as Qty,
            unitPrice: line.unitPrice as Money,
            lineTotal,
          });
        }
        await this.repo.setTotals(client, id, subtotal, '0.00' as Money, subtotal);
      }

      return this.getDetail(client, id);
    });
  }

  async submit(client: PoolClient, actor: ActorContext, id: UUID): Promise<PurchaseOrderDetail> {
    const header = await this.requireHeader(client, id);
    if (header.status !== PurchaseOrderStatus.DRAFT) {
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: `PO ${id} is '${header.status}', not 'draft'`,
      });
    }

    return withWrite(client, async () => {
      await this.repo.setStatus(client, id, PurchaseOrderStatus.PENDING_APPROVAL);
      const submitResult = await this.approvals.submit(client, {
        documentType: ApprovalDocumentType.PURCHASE_ORDER,
        documentId: id,
        requestedBy: actor.userId,
        amount: header.total,
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
    note: string | undefined,
  ): Promise<PurchaseOrderDetail> {
    const header = await this.requireHeader(client, id);
    if (header.status !== PurchaseOrderStatus.PENDING_APPROVAL) {
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: `PO ${id} is '${header.status}', not 'pending_approval'`,
      });
    }

    return withWrite(client, async () => {
      const decision = await this.approvals.approve(client, {
        documentType: ApprovalDocumentType.PURCHASE_ORDER,
        documentId: id,
        currentState: header.status,
        actorUserId: actor.userId,
        actorRole: actor.roleKey,
        reason: note ?? null,
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
    reason: string,
  ): Promise<PurchaseOrderDetail> {
    const header = await this.requireHeader(client, id);
    if (header.status !== PurchaseOrderStatus.PENDING_APPROVAL) {
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: `PO ${id} is '${header.status}', not 'pending_approval'`,
      });
    }

    return withWrite(client, async () => {
      // §5.3: PO reject returns the document to `draft` (editable), NOT a terminal `rejected` state.
      await this.approvals.reject(client, {
        documentType: ApprovalDocumentType.PURCHASE_ORDER,
        documentId: id,
        currentState: header.status,
        actorUserId: actor.userId,
        actorRole: actor.roleKey,
        reason,
      });
      await this.repo.setStatus(client, id, PurchaseOrderStatus.DRAFT);
      return this.getDetail(client, id);
    });
  }

  async issue(client: PoolClient, id: UUID): Promise<PurchaseOrderDetail> {
    const header = await this.requireHeader(client, id);
    if (header.status !== PurchaseOrderStatus.APPROVED) {
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: `PO ${id} is '${header.status}', not 'approved'`,
      });
    }
    return withWrite(client, async () => {
      await this.repo.setStatus(client, id, PurchaseOrderStatus.ISSUED);
      return this.getDetail(client, id);
    });
  }

  async cancel(client: PoolClient, id: UUID, reason: string): Promise<PurchaseOrderDetail> {
    const header = await this.requireHeader(client, id);
    if (
      header.status === PurchaseOrderStatus.RECEIVED ||
      header.status === PurchaseOrderStatus.CLOSED ||
      header.status === PurchaseOrderStatus.CANCELLED
    ) {
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: `PO ${id} is '${header.status}' — only a pre-received PO can be cancelled`,
      });
    }
    return withWrite(client, async () => {
      await this.repo.setCancelled(client, id, reason);
      return this.getDetail(client, id);
    });
  }

  async close(client: PoolClient, id: UUID): Promise<PurchaseOrderDetail> {
    const header = await this.requireHeader(client, id);
    if (header.status !== PurchaseOrderStatus.RECEIVED) {
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: `PO ${id} is '${header.status}', not 'received'`,
      });
    }
    // NO payment gate (owner-decided 2026-09-10). Closing used to require the
    // single linked voucher to read 'paid', which under instalment terms held
    // a fully-received PO open for as long as the last termin took — the
    // warehouse's record of "these goods are done" hostage to Finance's
    // calendar. Any unpaid balance stays visible and collectable where it
    // belongs: as 2000 Hutang Supplier, and as `payment.outstanding` on this
    // PO, which `close` does not touch. A closed PO can still be paid.
    return withWrite(client, async () => {
      await this.repo.setStatus(client, id, PurchaseOrderStatus.CLOSED);
      return this.getDetail(client, id);
    });
  }

  /**
   * Raises a voucher against a PO for `amount` — the down payment suppliers
   * demand before they will process the order, and every instalment after it
   * (migration 268).
   *
   * Only from `issued` onward (owner-decided 2026-09-10): an approved-but-
   * unissued PO has not actually been placed with anyone, and money must not
   * leave for an order the supplier has never seen. Cancelled/closed are
   * excluded for the obvious reason; `received` is NOT — the last instalment
   * of a fully-delivered order is the most ordinary case there is.
   *
   * The voucher is an ADVANCE exactly when nothing has been received yet, and
   * that flag is what routes it to 1130 Uang Muka instead of 2000 Hutang and
   * to the Owner-at-any-amount approval chain. Once goods are in, the payable
   * exists and an ordinary `supplier_payment` settles it.
   *
   * This does NOT pay anything. It creates a `pending` voucher that Finance
   * still has to attach proof to, verify, and pay — the same ladder every
   * other payment climbs. Purchasing may ask for money; only Finance moves it.
   */
  async payAdvance(
    client: PoolClient,
    actor: ActorContext,
    id: UUID,
    dto: CreatePoPaymentDto,
  ): Promise<PurchaseOrderDetail> {
    const header = await this.requireHeader(client, id);
    const payable: string[] = [
      PurchaseOrderStatus.ISSUED,
      PurchaseOrderStatus.PARTIALLY_RECEIVED,
      PurchaseOrderStatus.RECEIVED,
      PurchaseOrderStatus.CLOSED,
    ];
    if (!payable.includes(header.status)) {
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: `PO ${id} is '${header.status}' — a PO can only be paid once it is issued to the supplier`,
      });
    }

    const summary = summarisePayment(header);
    if (!summary) {
      // Cannot see the existing vouchers, so cannot know what is still owed —
      // and raising a voucher blind is how the PO gets paid twice.
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: `PO ${id}'s payment history is not visible to this role`,
      });
    }

    if (isNegativeMoney(dto.amount) || isZeroMoney(dto.amount)) {
      throw new BadRequestException({
        code: ERR_VALIDATION,
        message: 'amount must be greater than zero',
      });
    }
    // Guarded against the COMMITTED total, in-flight vouchers included: two
    // instalments queued at 60% each must not both be raisable just because
    // neither has been paid yet.
    const room = clampMoneyToZero(
      subMoney(subMoney(header.total, summary.paidTotal), summary.inFlightTotal),
    );
    if (compareMoney(dto.amount, room) > 0) {
      throw new BadRequestException({
        code: ERR_VALIDATION,
        message: `amount ${dto.amount} exceeds the ${room} still unpaid and unclaimed on PO ${header.po_number}`,
      });
    }

    const isAdvance = header.status === PurchaseOrderStatus.ISSUED;

    return withWrite(client, async () => {
      const pvId = await this.payments.createSystemVerification(
        client,
        { role: actor.roleKey, userId: actor.userId, locationIds: actor.locationScope ?? [] },
        {
          refType: 'purchase_order',
          refId: id,
          payeeType: 'supplier',
          payeeId: header.supplier_id,
          amount: dto.amount,
          locationId: header.location_id,
          submittedBy: actor.userId,
          notes: dto.notes ?? `PO ${header.po_number}`,
          isAdvance,
        },
      );
      // Only ever the FIRST voucher, so the pre-268 read paths (and migration
      // 220's RLS discriminator) keep pointing somewhere real. Later vouchers
      // are found through `ref_id`.
      if (!header.payment_verification_id) {
        await this.repo.setPaymentVerificationId(client, id, pvId);
      }
      return this.getDetail(client, id);
    });
  }

  // ── FR-PO-02/03/04: receiving ────────────────────────────────────────────

  async receive(
    client: PoolClient,
    actor: ActorContext,
    id: UUID,
    dto: CreatePoReceiptDto,
  ): Promise<PurchaseOrderDetail> {
    const header = await this.requireHeader(client, id);
    if (
      header.status !== PurchaseOrderStatus.ISSUED &&
      header.status !== PurchaseOrderStatus.PARTIALLY_RECEIVED
    ) {
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: `PO ${id} is '${header.status}' — only issued/partially_received POs can be received`,
      });
    }
    if (dto.photoAttachmentIds.length === 0) {
      throw new BadRequestException({
        code: ERR_PHOTO_REQUIRED,
        message: 'At least one receiving photo is wajib (FR-PO-04)',
      });
    }

    return withWrite(client, async () => {
      const receiptNumber = await this.repo.nextReceiptNumber(client);
      const receiptId = await this.repo.insertReceipt(client, {
        receiptNumber,
        poId: id,
        receivedBy: actor.userId,
        notes: dto.notes ?? null,
      });

      // B-16 JGUD-01 (`gudang_purchase`, CONTRACTS.md §6.2) — Dr 1100 Persediaan
      // Gudang / Cr 2000 Hutang Supplier, valued at `Σ receipt_line.qty_received
      // × po_line.unit_price` for THIS receipt only (never the PO's cumulative
      // total — a partially-received PO posts each receipt as its own entry).
      const receivedLineValues: Money[] = [];

      for (const line of dto.lines) {
        const poLine = await this.repo.findLineById(client, id, line.poLineId);
        if (!poLine)
          throw new NotFoundException({
            code: ERR_NOT_FOUND,
            message: `PO line ${line.poLineId} not found on PO ${id}`,
          });

        if (isNegativeQty(line.qtyReceived)) {
          throw new BadRequestException({
            code: ERR_VALIDATION,
            message: `qtyReceived must be >= 0 for line ${line.poLineId}`,
          });
        }
        const remaining = subMoneyLikeQty(poLine.qty_ordered, poLine.qty_received);
        const discrepancy = compareQty(line.qtyReceived, remaining) !== 0;
        if (discrepancy && !line.conditionNotes?.trim()) {
          throw new BadRequestException({
            code: ERR_VARIANCE_REASON_REQUIRED,
            message: `conditionNotes is required when qtyReceived differs from qty still due for line ${line.poLineId} (FR-PO-03)`,
          });
        }

        const area = await this.repo.storageAreaCheck(client, line.storageAreaId);
        if (!area)
          throw new NotFoundException({
            code: ERR_NOT_FOUND,
            message: `Storage area ${line.storageAreaId} not found or inactive`,
          });

        await this.repo.insertReceiptLine(client, {
          poReceiptId: receiptId,
          poLineId: line.poLineId,
          storageAreaId: line.storageAreaId,
          qtyReceived: line.qtyReceived as Qty,
          conditionNotes: line.conditionNotes ?? null,
        });

        if (!isZeroQty(line.qtyReceived)) {
          receivedLineValues.push(mulMoneyByQty(poLine.unit_price, line.qtyReceived as Qty));

          const costing = await this.repo.getItemCosting(client, poLine.item_id);
          await this.ledger.post(
            client,
            [
              {
                locationId: header.location_id,
                storageAreaId: line.storageAreaId,
                itemId: poLine.item_id,
                movementType: MovementType.PURCHASE_IN,
                qty: line.qtyReceived as Qty,
                unitCost: poLine.unit_price,
                refType: 'po_receipt',
                refId: receiptId,
                actorId: actor.userId,
              },
            ],
            'strict',
          );

          const newAvgCost = this.computeMovingAverage(
            costing.qtyOnHand,
            costing.avgCost,
            line.qtyReceived as Qty,
            poLine.unit_price,
          );
          await this.repo.updateItemCost(client, poLine.item_id, newAvgCost, poLine.unit_price);
          await this.repo.appendPriceHistory(client, {
            supplierId: header.supplier_id,
            itemId: poLine.item_id,
            price: poLine.unit_price,
            effectiveDate: formatDateOnly(new Date()),
            recordedBy: actor.userId,
          });

          await this.repo.incrementLineReceived(client, poLine.id, line.qtyReceived as Qty);
        }
      }

      const receiptTotal =
        receivedLineValues.length > 0 ? sumMoney(receivedLineValues) : ZERO_MONEY;
      if (receiptTotal !== ZERO_MONEY && receiptTotal !== '0.00') {
        await this.eventBus.publish('journal.action', {
          eventType: JournalEventType.GUDANG_PURCHASE,
          documentType: 'po_receipt',
          documentId: receiptId,
          locationId: header.location_id,
          amount: receiptTotal,
          context: {},
          occurredAt: toWitaOccurredAt(),
        });
      }

      // Recompute PO status from the fully up-to-date lines (post-increment).
      const lines = await this.repo.findLines(client, id);
      const fullyReceived = lines.every((l) => compareQty(l.qty_received, l.qty_ordered) >= 0);
      await this.repo.setStatus(
        client,
        id,
        fullyReceived ? PurchaseOrderStatus.RECEIVED : PurchaseOrderStatus.PARTIALLY_RECEIVED,
      );

      // ── What this receipt owes, and what a down payment already covers ──
      //
      // Two things were wrong here before migration 268, and they compound:
      //
      //   1. The voucher was raised for `header.total` — the WHOLE PO — on the
      //      first receipt. JGUD-01 above credits 2000 Hutang Supplier for
      //      THIS RECEIPT only, so a PO delivered in two halves asked Finance
      //      to pay 100% against a 50% payable, and paying it drove Hutang
      //      Supplier negative by the difference.
      //   2. `if (!header.payment_verification_id)` made it write-once, so the
      //      second half of that same PO never became payable at all.
      //
      // Both are replaced by: each receipt raises a voucher for exactly what
      // that receipt accrued, less whatever paid uang muka is still sitting
      // unapplied in 1130. The advance is consumed first and only up to what
      // this receipt earned, which is what keeps a DP honest across partial
      // deliveries.
      const summary = summarisePayment(header);
      if (receiptTotal !== ZERO_MONEY && receiptTotal !== '0.00' && summary) {
        const offset = minMoney(receiptTotal, summary.advanceUnapplied);
        if (!isZeroMoney(offset)) {
          await this.repo.applyAdvance(client, id, offset);
          // Dr 2000 / Cr 1130 — no cash moves. The down payment stops being a
          // claim on undelivered goods and becomes settlement of the payable
          // the JGUD-01 entry above just created.
          await this.eventBus.publish('journal.action', {
            eventType: JournalSystemEventType.SUPPLIER_ADVANCE_OFFSET,
            documentType: 'po_receipt',
            documentId: receiptId,
            locationId: header.location_id,
            amount: offset,
            context: {},
            occurredAt: toWitaOccurredAt(),
          });
        }

        const stillOwed = subMoney(receiptTotal, offset);
        if (!isZeroMoney(stillOwed)) {
          const pvId = await this.payments.createSystemVerification(
            client,
            { role: actor.roleKey, userId: actor.userId, locationIds: actor.locationScope ?? [] },
            {
              refType: 'purchase_order',
              refId: id,
              payeeType: 'supplier',
              payeeId: header.supplier_id,
              amount: stillOwed,
              locationId: header.location_id,
              submittedBy: actor.userId,
              notes: `PO ${header.po_number} — ${receiptNumber}`,
            },
          );
          if (!header.payment_verification_id) {
            await this.repo.setPaymentVerificationId(client, id, pvId);
          }
        }
      }

      for (const attachmentId of dto.photoAttachmentIds) {
        await client.query(
          `UPDATE attachments SET entity_type = 'po_receipt', entity_id = $2 WHERE id = $1 AND entity_id IS NULL`,
          [attachmentId, receiptId],
        );
      }

      return this.getDetail(client, id);
    });
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
    const existingValue = existing * Number(existingAvgCost);
    const receivedValue = received * Number(unitPrice);
    const total = existing + received;
    const avg = total > 0 ? (existingValue + receivedValue) / total : Number(unitPrice);
    return avg.toFixed(2) as Money;
  }

  private async requireHeader(client: PoolClient, id: UUID): Promise<PoHeaderRow> {
    const header = await this.repo.findHeader(client, id);
    if (!header)
      throw new NotFoundException({
        code: ERR_NOT_FOUND,
        message: `Purchase order ${id} not found`,
      });
    return header;
  }

  private toListRow(row: PoHeaderRow): PurchaseOrderListRow {
    return {
      id: row.id,
      poNumber: row.po_number,
      supplierId: row.supplier_id,
      supplierName: row.supplier_name,
      locationId: row.location_id,
      status: row.status,
      orderDate: formatDateOnly(row.order_date),
      expectedDate: row.expected_date ? formatDateOnly(row.expected_date) : null,
      total: row.total,
      approval: null, // see field doc comment — real value populated only by `toDetail`.
      paymentStatus: (row.payment_status as PaymentStatus | 'rejected' | null) ?? null,
      payment: summarisePayment(row),
    };
  }

  private async toDetail(
    client: PoolClient,
    header: PoHeaderRow,
    lines: PoLineRow[],
  ): Promise<PurchaseOrderDetail> {
    const approval = await this.loadApprovalDetail(client, header);
    return {
      ...this.toListRow(header),
      approval,
      paymentTermsDays: header.payment_terms_days,
      subtotal: header.subtotal,
      tax: header.tax,
      prId: header.pr_id,
      cancelReason: header.cancel_reason,
      notes: header.notes,
      lines: lines.map((l) => ({
        id: l.id,
        itemId: l.item_id,
        itemName: l.item_name,
        unitCode: l.unit_code,
        qtyOrdered: l.qty_ordered,
        unitPrice: l.unit_price,
        lineTotal: l.line_total,
        qtyReceived: l.qty_received,
        qtyDifference: subMoneyLikeQty(l.qty_ordered, l.qty_received),
      })),
    };
  }

  /**
   * CONTRACTS.md §4.11's `PurchaseOrder.approval` — mirrors
   * `ReplenishmentService.loadApprovalDetail`/`RunsService.toRunApi`'s
   * identical pattern (`kernel/approvals`'s per-document detail round trip,
   * never a hand-rolled join). Guarded on `approval_id` rather than a status
   * string: a draft PO that was submitted, rejected back to draft, and never
   * resubmitted still HAS an approval_id (§5.3 reject returns the doc to
   * 'draft', not a terminal state) whose chain the UI can legitimately show.
   */
  private async loadApprovalDetail(
    client: PoolClient,
    header: PoHeaderRow,
  ): Promise<ApprovalDetail | null> {
    if (!header.approval_id) return null;
    try {
      const detail = await this.approvals.getDetail(
        client,
        ApprovalDocumentType.PURCHASE_ORDER,
        header.id,
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
      return null; // No approval row yet / lookup failed — never let a display concern break the read.
    }
  }
}

/** Qty subtraction for the `qtyOrdered - qtyReceived` difference (FR-PO-03) — never negative on the wire. */
function subMoneyLikeQty(a: Qty, b: Qty): Qty {
  const diff = Number(a) - Number(b);
  return (diff > 0 ? diff : 0).toFixed(3) as Qty;
}

/**
 * The PO's money position, aggregated over every voucher pointing at it
 * (migration 268).
 *
 * Returns `null` — "not available" rather than "nothing paid" — when the PO
 * carries a `payment_verification_id` but the caller can see no vouchers.
 * That combination can only mean RLS filtered them out (migration 220 grants
 * fulfilment roles a narrow location-scoped read; other roles get none), and
 * the sums would otherwise read 0.00 and render as a confident "Belum Dibayar"
 * over an order that may be fully settled. `PurchaseOrdersPanel` already has
 * the "belum tersedia" branch and a test guarding it; this keeps feeding it.
 */
function summarisePayment(row: PoHeaderRow): PoPaymentSummary | null {
  if (row.payment_verification_id && row.voucher_count === 0) return null;

  const paidTotal = row.paid_total;
  const outstanding = clampMoneyToZero(subMoney(row.total, paidTotal));
  const state = isZeroMoney(paidTotal)
    ? PoPaymentState.UNPAID
    : compareMoney(paidTotal, row.total) >= 0
      ? PoPaymentState.PAID
      : PoPaymentState.PARTIAL;

  return {
    state,
    orderTotal: row.total,
    paidTotal,
    inFlightTotal: row.in_flight_total,
    outstanding,
    advancePaid: row.advance_paid,
    // Floored: `advance_applied` should never exceed `advance_paid`, but a
    // negative here would silently become an extra offset at the next receipt.
    advanceUnapplied: clampMoneyToZero(subMoney(row.advance_paid, row.advance_applied)),
  };
}
