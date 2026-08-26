import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  calculateOnlineOrderJournalSplit,
  calculateOnlineOrderNet,
  ERR_CONFLICT,
  ERR_NET_MISMATCH,
  ERR_NOT_FOUND,
  JournalEventType,
  MovementType,
  OnlineOrderStatus,
  OnlinePlatform,
  SettlementStatus,
  type Money,
  type OnlineOrder,
  type Paginated,
  type Qty,
  type UUID,
} from '@mimi/shared';
import { EventBus } from '../../../kernel/events/event-bus.service';
import { StockLedgerService } from '../../../kernel/stock-ledger/stock-ledger.service';
import {
  StockInsufficientError,
  type PostMovementInput,
} from '../../../kernel/stock-ledger/stock-ledger.types';
import { explodeRecipeUsage, findKitchenLineAreaId } from '../recipe-usage.util';
import { mapOnlineOrder, type OnlineOrderRow } from './pos-mappers';

export interface CreateOnlineOrderInput {
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

/** The shared apply core's input — `id` explicit only from `PosSyncProjector` (`event.entityId`). */
export interface ApplyOnlineOrderFactInput extends CreateOnlineOrderInput {
  id?: UUID;
  recordedByUserId: UUID;
  /** C8 (SYNC-PROTOCOL §5.2): "both kept; second flagged; revenue reports use first" — never rejected, unlike the REST path's `create()`. */
  isConflictLoser?: boolean;
}

const SELECT = `
  SELECT id, location_id, platform, order_ref, order_date, gross_amount, discount_amount,
         platform_fee, other_fee, net_received, status
    FROM online_orders
`;

/**
 * `PosOnlineOrderService` — FR-POS-05/07 (GoFood/ShopeeFood manual entry).
 * Net-received maths is `@mimi/shared`'s cart module (`calculateOnlineOrderNet`
 * / the request-body-vs-computed check CONTRACTS.md calls `ERR_NET_MISMATCH`)
 * — never hand-rolled here, per the module brief.
 */
@Injectable()
export class PosOnlineOrderService {
  constructor(
    private readonly stockLedger: StockLedgerService,
    private readonly eventBus: EventBus,
  ) {}

  async create(
    client: PoolClient,
    recordedByUserId: UUID,
    input: CreateOnlineOrderInput,
  ): Promise<OnlineOrder> {
    // Interactive-only: the REST path pre-checks for a duplicate (platform, orderRef) and rejects
    // it outright with a legible `ERR_CONFLICT`. NOT enforced in `applyOnlineOrderFact` (the shared
    // core the projector also calls) — SYNC-PROTOCOL C8 is explicit that a duplicate platform order
    // is "both kept; second flagged; revenue reports use first", never rejected wholesale.
    const duplicate = await client.query<{ id: UUID }>(
      `SELECT id FROM online_orders WHERE platform = $1 AND order_ref = $2`,
      [input.platform, input.orderRef],
    );
    if (duplicate.rows[0]) {
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: `Order ${input.orderRef} on ${input.platform} was already recorded`,
      });
    }

    return this.applyOnlineOrderFact(client, { ...input, recordedByUserId });
  }

  /**
   * The shared apply core `PosSyncProjector` calls too. Idempotent on `id` (projector) or
   * `client_id` (either path) — dedupes below `SyncProjectorRegistry`'s own event-id guarantee.
   */
  async applyOnlineOrderFact(
    client: PoolClient,
    input: ApplyOnlineOrderFactInput,
  ): Promise<OnlineOrder> {
    // Also checks `(platform, order_ref)` — CONTRACTS' `UNIQUE (platform, order_ref)` constraint
    // makes SYNC-PROTOCOL C8's "both kept" prose structurally impossible at the schema level (a
    // second row for the same platform order would violate that constraint outright, not just look
    // redundant). A genuine C8 duplicate (`isConflictLoser: true`) therefore resolves to the SAME
    // winner row this returns, never a second row — the duplicate fact is still fully preserved in
    // `sync_events`/`sync_conflicts` (§5.2's actual durability guarantee), just not as a second
    // `online_orders` record. Flagged in the module report as a contract/schema note, not something
    // to route around with a migration this agent doesn't own.
    const existing = await client.query<{ id: UUID }>(
      `SELECT id FROM online_orders WHERE client_id = $1 ${input.id ? 'OR id = $2' : ''} OR (platform = $${input.id ? 3 : 2} AND order_ref = $${input.id ? 4 : 3})`,
      input.id
        ? [input.clientId, input.id, input.platform, input.orderRef]
        : [input.clientId, input.platform, input.orderRef],
    );
    if (existing.rows[0]) return this.mustGetById(client, existing.rows[0].id);

    const expectedNet = calculateOnlineOrderNet({
      grossAmount: input.grossAmount,
      discountAmount: input.discountAmount,
      platformFee: input.platformFee,
      otherFee: input.otherFee,
    });
    if (expectedNet !== input.netReceived) {
      throw new BadRequestException({
        code: ERR_NET_MISMATCH,
        message: `netReceived ${input.netReceived} does not equal gross-discount-fees ${expectedNet}`,
        details: { expectedNet },
      });
    }

    // CONTRACTS.md's DDL has no dedicated "excluded from revenue" column for the C8 case — `notes`
    // carries a documented, best-effort marker instead (flagged in the module report as a follow-up
    // for a real column).
    const notes = input.isConflictLoser
      ? 'duplicate_platform_order — excluded from revenue (see sync_conflicts)'
      : null;
    const id = input.id ?? randomUUID();

    const inserted = await client.query<{ id: UUID }>(
      `INSERT INTO online_orders
         (id, client_id, location_id, platform, order_ref, order_date, gross_amount, discount_amount,
          platform_fee, other_fee, net_received, status, items, recorded_by, shift_id, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (id) DO NOTHING RETURNING id`,
      [
        id,
        input.clientId,
        input.locationId,
        input.platform,
        input.orderRef,
        input.orderDate,
        input.grossAmount,
        input.discountAmount,
        input.platformFee,
        input.otherFee,
        input.netReceived,
        input.status,
        input.items ? JSON.stringify(input.items) : null,
        input.recordedByUserId,
        input.shiftId ?? null,
        notes,
      ],
    );
    if (!inserted.rows[0]) return this.mustGetById(client, id); // race with a concurrent apply of the same fact

    if (
      input.items &&
      input.items.length > 0 &&
      input.status === OnlineOrderStatus.COMPLETED &&
      !input.isConflictLoser
    ) {
      await this.postUsage(
        client,
        input.locationId,
        id,
        input.recordedByUserId,
        input.items,
        input.id ? 'fact' : 'strict',
      );
    }

    // B-16/E7 — a completed order is the terminal state for GL purposes (`OnlineOrderStatus` has
    // only completed/cancelled, per migration 053's CHECK; there is no later "settled" transition
    // that revenue-recognition should instead wait for). Independent of the items/stock guard above
    // — a manually-entered order with no recipe items still needs its revenue/fee split recorded.
    // `isConflictLoser` is excluded for the same reason `postUsage` above excludes it: SYNC-PROTOCOL
    // C8 ("both kept; second flagged; revenue reports use first") means the loser's amounts must
    // never touch the ledger, or the platform's revenue would be double-booked.
    //
    // Split via the SAME `calculateOnlineOrderJournalSplit` the property test already proves nets to
    // `gross` (never re-derived here) — `resolveOutletSalesLegs`'s 'online' branch debits 1030 by
    // `byMethod.online` (the net leg) and credits 4000, then debits 6300/credits 1030 by `onlineFees`
    // (discount + platform fee + other fee), leaving 1030 at exactly `netReceived` for X5
    // (`platform_settlement`) to clear later when the platform actually pays out.
    if (input.status === OnlineOrderStatus.COMPLETED && !input.isConflictLoser) {
      const { netLeg, feeLeg } = calculateOnlineOrderJournalSplit({
        grossAmount: input.grossAmount,
        discountAmount: input.discountAmount,
        platformFee: input.platformFee,
        otherFee: input.otherFee,
      });
      await this.eventBus.publish('journal.action', {
        eventType: JournalEventType.OUTLET_SALES,
        documentType: 'online_order',
        documentId: id,
        locationId: input.locationId,
        amount: input.grossAmount,
        context: { byMethod: { online: netLeg }, onlineFees: feeLeg },
        // `order_date` is a DATE (no time-of-day) that may be recorded days after the fact — the
        // entry has to land on THAT WITA business day, not the moment this code runs. Built the same
        // way `daily-posting.service.ts`'s `endOfBusinessDay` is: the calendar string IS the WITA
        // date already, so it only needs the explicit +08:00 offset tacked on, never a re-shift
        // through `toWitaOccurredAt` (which expects a real instant, not an already-WITA date string —
        // feeding one in would double-apply the 8-hour offset and land on the wrong day).
        occurredAt: `${input.orderDate}T23:59:59.999+08:00`,
      });
    }

    return this.mustGetById(client, id);
  }

  async list(
    client: PoolClient,
    query: {
      locationId?: UUID;
      platform?: OnlinePlatform;
      from?: string;
      to?: string;
      settlement?: SettlementStatus;
      page: number;
      pageSize: number;
    },
  ): Promise<Paginated<OnlineOrder>> {
    const params: unknown[] = [];
    let where = '1=1';
    if (query.locationId) {
      params.push(query.locationId);
      where += ` AND location_id = $${params.length}`;
    }
    if (query.platform) {
      params.push(query.platform);
      where += ` AND platform = $${params.length}`;
    }
    if (query.from) {
      params.push(query.from);
      where += ` AND order_date >= $${params.length}::date`;
    }
    if (query.to) {
      params.push(query.to);
      where += ` AND order_date <= $${params.length}::date`;
    }
    if (query.settlement) {
      params.push(query.settlement);
      where += ` AND settlement_status = $${params.length}`;
    }

    const countRes = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM online_orders WHERE ${where}`,
      params,
    );
    const total = Number.parseInt(countRes.rows[0]?.count ?? '0', 10);

    const offset = (query.page - 1) * query.pageSize;
    params.push(query.pageSize, offset);
    const res = await client.query<OnlineOrderRow>(
      `${SELECT} WHERE ${where} ORDER BY order_date DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return {
      rows: res.rows.map(mapOnlineOrder),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  private async postUsage(
    client: PoolClient,
    locationId: UUID,
    onlineOrderId: UUID,
    actorId: UUID,
    items: { productId: UUID; qty: Qty }[],
    mode: 'strict' | 'fact',
  ): Promise<void> {
    const areaId = await findKitchenLineAreaId(client, locationId);
    if (!areaId) return;

    const { usages } = await explodeRecipeUsage(client, items);
    if (usages.length === 0) return;

    const movements: PostMovementInput[] = usages.map((u) => ({
      locationId,
      storageAreaId: areaId,
      itemId: u.itemId,
      movementType: MovementType.USAGE_OUT,
      qty: u.qty,
      unitCost: u.unitCost,
      refType: 'online_order',
      refId: onlineOrderId,
      actorId,
    }));

    if (mode === 'fact') {
      await this.stockLedger.post(client, movements, 'fact'); // D-17a, unconditionally — see `PosSaleService.postUsage`.
      return;
    }
    try {
      await this.stockLedger.post(client, movements, 'strict');
    } catch (err) {
      // Same rationale as `PosSaleService.postUsage`: a completed online order is a fact of a real
      // sale, not something an ingredient-estimate shortfall should ever roll back.
      if (err instanceof StockInsufficientError) {
        await this.stockLedger.post(client, movements, 'fact');
      } else {
        throw err;
      }
    }
  }

  private async mustGetById(client: PoolClient, id: UUID): Promise<OnlineOrder> {
    const res = await client.query<OnlineOrderRow>(`${SELECT} WHERE id = $1`, [id]);
    if (!res.rows[0])
      throw new NotFoundException({ code: ERR_NOT_FOUND, message: 'Online order not found' });
    return mapOnlineOrder(res.rows[0]);
  }
}
