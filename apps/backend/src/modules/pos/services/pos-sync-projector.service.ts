import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  OnlineOrderStatus,
  OnlinePlatform,
  PaymentMethod,
  VoidRefundType,
  type Money,
  type Qty,
  type SaleChannel,
  type UUID,
} from '@mimi/shared';
import type { SyncEventEnvelope } from '@mimi/sync-protocol';
import type { ProjectionContext, SyncProjector } from '../../../kernel/sync/sync-projector.types';
import { PosShiftService } from './pos-shift.service';
import { PosSaleService } from './pos-sale.service';
import { PosVoidRefundService } from './pos-void-refund.service';
import { PosOnlineOrderService } from './pos-online-order.service';

// ── Defensive payload.data readers — field names verbatim from
// packages/sync-protocol/src/schema/registry.ts's GROUP_6_SCHEMAS. Never
// throw on a merely-unexpected shape: `isRegisteredPayloadKey`/
// `validatePayloadData` already ran in `sync-ingest.service.ts`'s
// `checkAuthority` before this event was ever marked `applied` — by the time
// a projector sees it, the shape is supposed to be valid. These stay
// defensive anyway (never trust two independent readings of the same JSONB
// to agree without checking) and report an explicit error rather than
// dereferencing `undefined`. ──────────────────────────────────────────────

function obj(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

interface ShiftOpenedPayload {
  clientId: UUID;
  locationId: UUID;
  deviceId: UUID | null;
  openingCash: Money;
  openedAt: string;
  shiftNumber?: string;
}
function readShiftOpened(data: unknown): ShiftOpenedPayload | undefined {
  const d = obj(data);
  const clientId = str(d.clientId);
  const locationId = str(d.locationId);
  const openingCash = str(d.openingCash);
  const openedAt = str(d.openedAt);
  if (!clientId || !locationId || !openingCash || !openedAt) return undefined;
  return {
    clientId,
    locationId,
    deviceId: str(d.deviceId) ?? null,
    openingCash,
    openedAt,
    shiftNumber: str(d.shiftNumber),
  };
}

interface ShiftClosedPayload {
  closingCashCounted: Money;
  notes?: string;
  closedAt?: string;
}
function readShiftClosed(data: unknown): ShiftClosedPayload | undefined {
  const d = obj(data);
  const closingCashCounted = str(d.closingCashCounted);
  if (!closingCashCounted) return undefined;
  return { closingCashCounted, notes: str(d.notes), closedAt: str(d.closedAt) };
}

interface SaleLinePayload {
  productId: UUID;
  qty: Qty;
  unitPrice: Money;
  discount?: Money;
}
interface SalePaymentPayload {
  method: PaymentMethod;
  amount: Money;
  reference?: string;
  proofAttachmentId?: UUID;
}
/** `sales.channel`'s CHECK constraint values, verbatim (migration 249) — same list `sale.dto.ts`'s `SALE_CHANNELS` validates against on the REST path. */
const SALE_CHANNELS: readonly SaleChannel[] = ['walk_in', 'gofood', 'shopeefood'];

interface SaleCompletedPayload {
  clientId: UUID;
  locationId: UUID;
  shiftId: UUID;
  occurredAt: string;
  lines: SaleLinePayload[];
  payments: SalePaymentPayload[];
  discount?: Money;
  receiptNumber?: string;
  /** Absent on a payload queued by a pre-channel-pricing app build — `applySaleFact` defaults it to `'walk_in'`. */
  channel?: SaleChannel;
  /** Absent on a payload queued by a pre-voucher app build, and on any sale rung without a coupon. */
  voucher?: { code: string; discount?: Money; offlineAccepted: boolean };
}
function readSaleCompleted(data: unknown): SaleCompletedPayload | undefined {
  const d = obj(data);
  const clientId = str(d.clientId);
  const locationId = str(d.locationId);
  const shiftId = str(d.shiftId);
  const occurredAt = str(d.occurredAt);
  const linesRaw = Array.isArray(d.lines) ? d.lines : undefined;
  const paymentsRaw = Array.isArray(d.payments) ? d.payments : undefined;
  if (!clientId || !locationId || !shiftId || !occurredAt || !linesRaw || !paymentsRaw)
    return undefined;
  const channelRaw = str(d.channel);
  // Present but not one of the three known values is a malformed payload, not "absent" — fail the
  // whole read rather than silently coercing a corrupt channel to the walk-in default.
  if (channelRaw !== undefined && !SALE_CHANNELS.includes(channelRaw as SaleChannel))
    return undefined;
  const channel = channelRaw as SaleChannel | undefined;

  const lines: SaleLinePayload[] = [];
  for (const raw of linesRaw) {
    const lo = obj(raw);
    const productId = str(lo.productId);
    const qty = str(lo.qty);
    const unitPrice = str(lo.unitPrice);
    if (!productId || !qty || !unitPrice) return undefined;
    lines.push({ productId, qty, unitPrice, discount: str(lo.discount) });
  }

  const payments: SalePaymentPayload[] = [];
  for (const raw of paymentsRaw) {
    const po = obj(raw);
    const method = str(po.method);
    const amount = str(po.amount);
    if (!method || !amount || !Object.values(PaymentMethod).includes(method as PaymentMethod))
      return undefined;
    payments.push({
      method: method as PaymentMethod,
      amount,
      reference: str(po.reference),
      proofAttachmentId: str(po.proofAttachmentId),
    });
  }

  /**
   * The voucher block is OPTIONAL and its absence is the normal case, so a
   * missing key reads as `undefined` rather than failing the payload. But a
   * PRESENT block with no usable `code` is a malformed payload, not "absent" —
   * failing the whole read there matches exactly how `channel` above treats a
   * present-but-invalid value, and for the same reason: silently discarding a
   * coupon a customer handed over would lose money with no trace, which is the
   * one outcome this whole path is arranged to prevent.
   *
   * `offlineAccepted` defaults to FALSE when omitted. That is the conservative
   * direction: a sale that does not claim it was rung offline is treated as
   * online, so `pos.voucher_offline`'s gate is not consulted and the coupon is
   * simply verified normally. Defaulting the other way would let a payload
   * suppress verification by omitting a field.
   */
  let voucher: SaleCompletedPayload['voucher'];
  if (d.voucher !== undefined && d.voucher !== null) {
    const vo = obj(d.voucher);
    const voucherCode = str(vo.code);
    if (!voucherCode) return undefined;
    voucher = {
      code: voucherCode,
      discount: str(vo.discount),
      offlineAccepted: vo.offlineAccepted === true,
    };
  }

  return {
    clientId,
    locationId,
    shiftId,
    occurredAt,
    lines,
    payments,
    discount: str(d.discount),
    receiptNumber: str(d.receiptNumber),
    channel,
    voucher,
  };
}

interface VoidRequestedPayload {
  clientId: UUID;
  type: VoidRefundType;
  reason: string;
  amount?: Money;
}
function readVoidRequested(data: unknown): VoidRequestedPayload | undefined {
  const d = obj(data);
  const clientId = str(d.clientId);
  const type = str(d.type);
  const reason = str(d.reason);
  if (
    !clientId ||
    !reason ||
    !type ||
    !Object.values(VoidRefundType).includes(type as VoidRefundType)
  )
    return undefined;
  return { clientId, type: type as VoidRefundType, reason, amount: str(d.amount) };
}

interface OnlineOrderRecordedPayload {
  clientId: UUID;
  locationId: UUID;
  platform: OnlinePlatform;
  orderRef: string;
  orderDate: string;
  grossAmount: Money;
  discountAmount: Money;
  platformFee: Money;
  otherFee: Money;
  netReceived: Money;
  status: OnlineOrderStatus;
  items?: { productId: UUID; qty: Qty }[];
  shiftId?: UUID;
}
function readOnlineOrderRecorded(data: unknown): OnlineOrderRecordedPayload | undefined {
  const d = obj(data);
  const clientId = str(d.clientId);
  const locationId = str(d.locationId);
  const platform = str(d.platform);
  const orderRef = str(d.orderRef);
  const orderDate = str(d.orderDate);
  const grossAmount = str(d.grossAmount);
  const discountAmount = str(d.discountAmount);
  const platformFee = str(d.platformFee);
  const otherFee = str(d.otherFee);
  const netReceived = str(d.netReceived);
  const status = str(d.status);
  if (
    !clientId ||
    !locationId ||
    !platform ||
    !Object.values(OnlinePlatform).includes(platform as OnlinePlatform) ||
    !orderRef ||
    !orderDate ||
    !grossAmount ||
    !discountAmount ||
    !platformFee ||
    !otherFee ||
    !netReceived ||
    !status
  ) {
    return undefined;
  }
  const itemsRaw = Array.isArray(d.items) ? d.items : undefined;
  const items = itemsRaw
    ?.map((raw) => {
      const io = obj(raw);
      const productId = str(io.productId);
      const qty = str(io.qty);
      return productId && qty ? { productId, qty } : undefined;
    })
    .filter((x): x is { productId: UUID; qty: Qty } => !!x);
  return {
    clientId,
    locationId,
    platform: platform as OnlinePlatform,
    orderRef,
    orderDate,
    grossAmount,
    discountAmount,
    platformFee,
    otherFee,
    netReceived,
    status: status as OnlineOrderStatus,
    items,
    shiftId: str(d.shiftId),
  };
}

/**
 * `PosSyncProjector` — the domain-projection hook for every push-class event
 * M13 owns (`kernel/sync/sync-projector.types.ts`). Registered from
 * `pos.module.ts`'s `OnModuleInit` against `SyncProjectorRegistry`.
 *
 * **Refactor, per coordinator feedback (W3-09 found the same trap first):**
 * this file does NOT reimplement `sales`/`pos_shifts`/`void_refunds`/
 * `online_orders` writes — it parses `event.payload.data` into the shape
 * each `Pos*Service`'s shared "apply core" already expects
 * (`PosSaleService.applySaleFact`, `PosShiftService.applyShiftOpened`/
 * `close`, `PosVoidRefundService.requestVoid`/`applyVoidApprovedOffline`/
 * `applyVoidExecuted`, `PosOnlineOrderService.applyOnlineOrderFact`) and
 * calls it with `mode: 'fact'` where stock posting is involved. That is what
 * guarantees an offline-synced fact and an online REST one produce
 * IDENTICAL rows — including the payment-status ladder, which is computed
 * by the exact same `paymentStatusForMethod()` both paths route through
 * inside `applySaleFact`, never a parallel copy in this file.
 *
 * FOUR non-negotiables, per the coordinator's brief:
 *  1. **`'fact'` mode, always, for every stock post reachable from here**
 *     (D-17a) — enforced inside each service's shared core when it detects
 *     it's being called with an explicit `id`/from this projector (see e.g.
 *     `PosSaleService.postUsage`'s `mode === 'fact'` branch), never
 *     `'strict'`. A replayed sale/void/online-order really happened; it must
 *     never be rejected for driving a balance negative.
 *  2. **Idempotent regardless of the registry's own dedupe.** Every shared
 *     apply core checks for an existing row by `id` (this projector always
 *     supplies `event.entityId`) OR `client_id` before writing anything —
 *     safe to call twice for the exact same event, and safe against a
 *     REST-path duplicate of the same client action.
 *  3. **`context.isConflictLoser`** — `sales`/`pos_shifts` are never
 *     conflict-checked at all (SYNC-PROTOCOL: "no conflict possible, dedupe
 *     by eventId"); `void_refunds.approved_offline` skips the flip entirely
 *     on a lost C3 decision race; `online_orders.recorded` still writes the
 *     row on a lost C8 duplicate (both facts are real) but excludes it from
 *     revenue via `applyOnlineOrderFact`'s `notes` marker.
 *  4. **Payment-status ladder** — see the refactor note above.
 *
 * `event.relayReceivedAt` is NOT read anywhere in this file. The original
 * reason given was that `envelopeFromRow` did not populate it, so a projector
 * reading it would silently see `undefined`; that is no longer true (D-10 —
 * it is carried across now). The standing reason is the other one: POS has no
 * defensibility-bound logic that would need it. Sale and shift timestamps here
 * are business facts (`occurredAt`), not a clamped claim window the way HR
 * attendance is.
 *
 * `void_refunds.*` and `online_orders.*` are materialized too (this projector
 * owns every push-class op in its module), and `void_refunds.approved_offline`
 * / `executed` deliberately do NOT write `ApprovalService` bookkeeping
 * (`approvals` / `approval_steps` rows). D-11 asked whether they should. Owner
 * decision 2026-08-29: they should not.
 *
 * The reasoning, so this is not "re-fixed" later. An offline-approved void has
 * already PHYSICALLY happened by the time the cloud sees it — cash left the
 * drawer, stock was reversed. If the cloud's §7.4 re-verification then comes
 * back `failed`, an `approvals` row saying `rejected` would describe a decision
 * nobody made and imply the void did not occur. What is actually true is
 * narrower: the action happened, and its authority did not hold up.
 *
 * So that case is recorded as a DISPUTE instead, and it already is —
 * `OfflineAuthService.persist()` writes a `sync_conflicts` row (kind
 * `offline_auth`, queue `finance`, `physicalEffectSuspected: true`) alongside
 * the `offline_authorizations` row carrying the outcome and failure reason.
 * Finance resolves it through `ExceptionsService.recordVerdict`. `unprovable`
 * (§6.4 — an expired credential plus a backdated clock) takes the same route
 * for the same reason: writing any approval row would assert more than is
 * known.
 *
 * `approvals` stays what it says it is — the record of decisions people made.
 * This projector therefore records only the provisional grant on
 * `void_refunds` itself, which is the fact it actually witnessed.
 */
@Injectable()
export class PosSyncProjector implements SyncProjector {
  readonly handles: readonly string[] = [
    'pos_shifts.opened',
    'pos_shifts.closed',
    'sales.completed',
    'void_refunds.requested',
    'void_refunds.approved_offline',
    'void_refunds.executed',
    'online_orders.recorded',
    'online_orders.status_updated',
  ];

  constructor(
    private readonly shifts: PosShiftService,
    private readonly sales: PosSaleService,
    private readonly voidRefunds: PosVoidRefundService,
    private readonly onlineOrders: PosOnlineOrderService,
  ) {}

  async project(
    client: PoolClient,
    event: SyncEventEnvelope,
    context: ProjectionContext,
  ): Promise<void> {
    const key = `${event.entity}.${event.op}`;
    switch (key) {
      case 'pos_shifts.opened':
        return this.projectShiftOpened(client, event);
      case 'pos_shifts.closed':
        return this.projectShiftClosed(client, event);
      case 'sales.completed':
        return this.projectSaleCompleted(client, event, context);
      case 'void_refunds.requested':
        return this.projectVoidRequested(client, event);
      case 'void_refunds.approved_offline':
        return this.projectVoidApprovedOffline(client, event, context);
      case 'void_refunds.executed':
        return this.projectVoidExecuted(client, event);
      case 'online_orders.recorded':
        return this.projectOnlineOrderRecorded(client, event, context);
      case 'online_orders.status_updated':
        return this.projectOnlineOrderStatusUpdated(client, event);
      default:
        // `handles` and this switch must stay in lockstep — a mismatch is a bug in THIS file, not a
        // runtime condition to tolerate silently.
        throw new Error(`PosSyncProjector: registered to handle '${key}' but has no case for it`);
    }
  }

  private async projectShiftOpened(client: PoolClient, event: SyncEventEnvelope): Promise<void> {
    const data = readShiftOpened(event.payload.data);
    if (!data) throw new Error(`pos_shifts.opened: unreadable payload for event ${event.eventId}`);

    await this.shifts.applyShiftOpened(client, {
      id: event.entityId,
      clientId: data.clientId,
      locationId: data.locationId,
      deviceId: data.deviceId ?? undefined,
      openingCash: data.openingCash,
      openedAt: data.openedAt,
      openedByUserId: event.actorUserId,
      shiftNumber: data.shiftNumber,
    });
  }

  private async projectShiftClosed(client: PoolClient, event: SyncEventEnvelope): Promise<void> {
    const data = readShiftClosed(event.payload.data);
    if (!data) throw new Error(`pos_shifts.closed: unreadable payload for event ${event.eventId}`);

    // `PosShiftService.close()` IS the shared idempotent core (no REST-only checks exist for
    // closing beyond "shift exists and is still open", which this method already handles
    // gracefully — see that method's own doc comment).
    await this.shifts.close(client, event.entityId, event.actorUserId, {
      closingCashCounted: data.closingCashCounted,
      notes: data.notes,
      closedAt: data.closedAt,
    });
  }

  private async projectSaleCompleted(
    client: PoolClient,
    event: SyncEventEnvelope,
    context: ProjectionContext,
  ): Promise<void> {
    if (context.isConflictLoser) return; // SYNC-PROTOCOL: not actually possible for `sales` (dedupe by eventId only) — defensive, matches the interface's stated default.

    const data = readSaleCompleted(event.payload.data);
    if (!data) throw new Error(`sales.completed: unreadable payload for event ${event.eventId}`);

    await this.sales.applySaleFact(
      client,
      {
        id: event.entityId,
        clientId: data.clientId,
        kasirId: event.actorUserId,
        shiftId: data.shiftId,
        locationId: data.locationId,
        occurredAt: data.occurredAt,
        lines: data.lines,
        payments: data.payments,
        discount: data.discount,
        receiptNumber: data.receiptNumber,
        channel: data.channel,
        voucher: data.voucher,
        // Links a voucher reconciliation exception back to the event that
        // carried it (`sync_conflicts.loser_event_id`) — see
        // `PosSaleService.commitVoucher`. A refused coupon on this path never
        // fails the projection: the sale already happened (D-17a), and the
        // give-away is reported to finance instead of being dropped.
        eventId: event.eventId,
        // The ingest connection already runs under `kernel/sync`'s own system/central context
        // (`SyncEventsRepository.withTransaction`) — restoring to 'owner'/no-scope after the
        // escalated `payment_verifications` INSERT is a same-role no-op, not a workaround.
        callerContext: { roleKey: 'owner', locationIds: [] },
      },
      'fact', // requirement 1 — D-17a, unconditionally.
    );
  }

  /** `event.entityId` for every `void_refunds.*` op is the SALE's id, not a separate void-refund id — SYNC-PROTOCOL §2.1's own example ("the sale id") for `entityId`, and there is no `saleId` field anywhere in the `void_refunds.*` payload schemas to get it from otherwise. A sale has at most one live void/refund document at a time (mirrors `PosVoidRefundService.requestVoid`'s own `pendingAlready` guard). */
  private async projectVoidRequested(client: PoolClient, event: SyncEventEnvelope): Promise<void> {
    const data = readVoidRequested(event.payload.data);
    if (!data)
      throw new Error(`void_refunds.requested: unreadable payload for event ${event.eventId}`);

    await this.voidRefunds.requestVoid(client, event.entityId, event.actorUserId, {
      clientId: data.clientId,
      type: data.type,
      reason: data.reason,
      amount: data.amount,
    });
  }

  private async projectVoidApprovedOffline(
    client: PoolClient,
    event: SyncEventEnvelope,
    context: ProjectionContext,
  ): Promise<void> {
    const approverUserId = event.payload.meta?.authorization?.approverUserId ?? event.actorUserId;
    await this.voidRefunds.applyVoidApprovedOffline(
      client,
      event.entityId,
      approverUserId,
      event.occurredAt,
      context.isConflictLoser,
    );
  }

  private async projectVoidExecuted(client: PoolClient, event: SyncEventEnvelope): Promise<void> {
    await this.voidRefunds.applyVoidExecuted(client, event.entityId, event.actorUserId);
  }

  private async projectOnlineOrderRecorded(
    client: PoolClient,
    event: SyncEventEnvelope,
    context: ProjectionContext,
  ): Promise<void> {
    const data = readOnlineOrderRecorded(event.payload.data);
    if (!data)
      throw new Error(`online_orders.recorded: unreadable payload for event ${event.eventId}`);

    await this.onlineOrders.applyOnlineOrderFact(client, {
      id: event.entityId,
      clientId: data.clientId,
      recordedByUserId: event.actorUserId,
      locationId: data.locationId,
      platform: data.platform,
      orderRef: data.orderRef,
      orderDate: data.orderDate,
      grossAmount: data.grossAmount,
      discountAmount: data.discountAmount,
      platformFee: data.platformFee,
      otherFee: data.otherFee,
      netReceived: data.netReceived,
      status: data.status,
      items: data.items,
      shiftId: data.shiftId,
      isConflictLoser: context.isConflictLoser,
    });
  }

  private async projectOnlineOrderStatusUpdated(
    client: PoolClient,
    event: SyncEventEnvelope,
  ): Promise<void> {
    const d = obj(event.payload.data);
    const status = str(d.status);
    if (!status)
      throw new Error(
        `online_orders.status_updated: unreadable payload for event ${event.eventId}`,
      );
    await client.query(`UPDATE online_orders SET status = $2 WHERE id = $1 AND status <> $2`, [
      event.entityId,
      status,
    ]);
  }
}
