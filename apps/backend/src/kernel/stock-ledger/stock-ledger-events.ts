/**
 * `StockMoved` domain event emission — `StockLedgerService.post()` publishes
 * one `stock.moved` event per movement it actually applies (BUILD-PLAN §5
 * W2-A: "emits StockMoved via the kernel event bus").
 *
 * `kernel/events` (W2-C, medior) has since landed its real `EventBus` +
 * `StockMovedPayload` — see `../events/domain-events.ts`'s header comment,
 * which explicitly names this service as the publisher of `stock.moved`.
 * This file is now a thin adapter: it builds the exact `StockMovedPayload`
 * shape from a posted movement and hands it to the real bus. No temporary/
 * placeholder publisher remains — `StockLedgerModule` imports `EventsModule`
 * directly (see that file).
 */
import { Injectable } from '@nestjs/common';
import { movementSign } from '@mimi/sync-protocol';
import { negateQty, type ISODateTime, type Money, type MovementType, type Qty, type UUID } from '@mimi/shared';
import type { LedgerMode, StockKey } from '@mimi/sync-protocol';

import { EventBus } from '../events/event-bus.service';
import type { StockMovedPayload } from '../events/domain-events';

export interface StockMovedEvent {
  readonly movementId: UUID;
  readonly key: StockKey;
  readonly movementType: MovementType;
  readonly qty: Qty;
  readonly unitCost: Money;
  readonly refType: string;
  readonly refId: UUID | null;
  readonly balanceAfter: Qty;
  readonly wentNegative: boolean;
  readonly mode: LedgerMode;
  readonly actorId: UUID | null;
  readonly occurredAt: ISODateTime;
}

/** `stock_movements.qty` is always positive; `stock.moved` subscribers (accounting, dashboards) want the SIGNED delta actually applied to the balance — this is the one place that translation happens. */
function signedQtyDelta(movementType: MovementType, qty: Qty): Qty {
  return movementSign(movementType) === -1 ? negateQty(qty) : qty;
}

/**
 * Thin wrapper around the real `EventBus` so `StockLedgerService` doesn't
 * hand-build the `stock.moved` envelope inline at every call site. Kept as
 * its own injectable (rather than calling `EventBus.publish` directly from
 * `StockLedgerService`) purely so the payload-shaping logic above has one
 * home and one set of unit tests.
 */
@Injectable()
export class StockMovedEventEmitter {
  constructor(private readonly bus: EventBus) {}

  async emit(events: readonly StockMovedEvent[]): Promise<void> {
    for (const event of events) {
      const payload: StockMovedPayload = {
        movementId: event.movementId,
        locationId: event.key.locationId,
        storageAreaId: event.key.storageAreaId,
        itemId: event.key.itemId,
        movementType: event.movementType,
        qtyDelta: signedQtyDelta(event.movementType, event.qty),
        unitCost: event.unitCost,
        refType: event.refType,
        refId: event.refId,
        mode: event.mode,
        actorId: event.actorId,
        occurredAt: event.occurredAt,
      };
      await this.bus.publish('stock.moved', payload, event.occurredAt);
    }
  }
}
