import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { compareQty } from '@mimi/shared';
import { DATABASE_POOL } from '../../../common/database/database-pool.provider';
import { EventBus } from '../../../kernel/events/event-bus.service';
import type { DomainEvent } from '../../../kernel/events/domain-events';
import { NotificationService } from '../../../kernel/notification/notification.service';
import { KeyedDebouncer } from './debouncer';
import { withSystemContext } from './system-context';

export interface LowStockDetectorOptions {
  /** How long a quiet period must last, after the LAST `stock.moved` event for one `(location, item)`, before a check actually runs. Coalesces a burst of movements (a busy shift) into one check instead of one per movement. */
  debounceMs: number;
  /** Minimum time between two notifications for the SAME `(location, item)` key, even if it never recovers above `min_qty` in between — a defensive floor on top of the edge-triggered rule below (guards against flapping exactly at the threshold across two adjacent movements landing on either side of one debounce window). */
  cooldownMs: number;
}

/** 3s: long enough to coalesce a rapid POS/receiving burst against one item, short enough that a genuine crossing still alerts promptly. */
export const DEFAULT_LOW_STOCK_DEBOUNCE_MS = 3_000;
/** 15 minutes: a busy shift's repeated dips below threshold notify at most every 15 minutes, not once per movement. */
export const DEFAULT_LOW_STOCK_COOLDOWN_MS = 15 * 60 * 1000;

export const LOW_STOCK_DETECTOR_OPTIONS = 'LOW_STOCK_DETECTOR_OPTIONS';

export const DEFAULT_LOW_STOCK_DETECTOR_OPTIONS: LowStockDetectorOptions = {
  debounceMs: DEFAULT_LOW_STOCK_DEBOUNCE_MS,
  cooldownMs: DEFAULT_LOW_STOCK_COOLDOWN_MS,
};

function keyOf(locationId: string, itemId: string): string {
  return `${locationId}::${itemId}`;
}

/**
 * FR-LOG-07/18: fires the `low_stock` notification (kernel template registry)
 * when a `(location, item)` balance — summed across every storage area,
 * matching `min_stock_rules`' own grain (CONTRACTS.md migration 022 comment)
 * — crosses below its active `min_qty` rule. Reacts to `StockLedgerService`'s
 * `stock.moved` event (kernel/events `EventBus`) rather than being called
 * directly by every writer, so no domain module (POS, delivery, waste-return,
 * stock-opname, replenishment, …) needs to know this detector exists — the
 * whole point of the event bus (BUILD-PLAN §5 W2-C).
 *
 * DEBOUNCE (the ticket's explicit requirement — "an outlet crossing a
 * threshold repeatedly during a busy shift must not generate a notification
 * per movement"): two layers, deliberately —
 *  1. `KeyedDebouncer` coalesces a BURST of `stock.moved` events for one key
 *     into a single deferred check, `debounceMs` after the last one. This
 *     also sidesteps a real correctness hazard, not just a UX one: the event
 *     fires from INSIDE the emitting module's own (uncommitted) transaction
 *     — see `StockMovedEventEmitter`'s doc comment — so reading
 *     `stock_balances` from a DIFFERENT connection immediately would race the
 *     writer's own commit. Deferring the actual read past the debounce
 *     window is a pragmatic mitigation (not a hard guarantee — a very slow
 *     writer could in principle still be mid-transaction after `debounceMs`)
 *     given this module owns neither the ledger nor the event bus and cannot
 *     add a "notify only after commit" contract to either.
 *  2. `lastNotifiedAt` rate-limits actual sends to at most one per
 *     `cooldownMs` for the SAME key, applied UNCONDITIONALLY whenever the
 *     balance is currently below `min_qty` — not only while it has stayed
 *     below since the last check. An earlier version of this gate only
 *     applied the cooldown when the key was ALREADY known-below ("edge
 *     triggered"), which looked right but flapped under a very real shift
 *     pattern: a receipt brings the balance back to/above `min_qty` for one
 *     movement, then the next sale drops it below again — two "fresh
 *     crossings" a few seconds apart, and an edge-triggered gate would
 *     notify for both. Rate-limiting by elapsed time regardless of that kind
 *     of recovery blip is what actually holds "not a notification per
 *     movement" under real, noisy stock activity.
 *
 * `lastNotifiedAt` is in-process memory, not a DB table — acceptable because
 * this backend runs as one instance per BUILD-PLAN §2 (Docker Compose, no
 * multi-replica requirement stated); a restart simply forgets the cooldown
 * clock for every key and, at worst, sends one notification sooner than it
 * otherwise would have. Flagged in the report as the one place a
 * horizontally-scaled deployment would need a shared store (Redis, already
 * in the stack) instead.
 */
@Injectable()
export class LowStockDetectorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LowStockDetectorService.name);
  private readonly debouncer: KeyedDebouncer;
  private readonly lastNotifiedAt = new Map<string, number>();
  private unsubscribe?: () => void;

  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly bus: EventBus,
    private readonly notifications: NotificationService,
    @Inject(LOW_STOCK_DETECTOR_OPTIONS) private readonly options: LowStockDetectorOptions,
  ) {
    this.debouncer = new KeyedDebouncer(this.options.debounceMs);
  }

  onModuleInit(): void {
    this.unsubscribe = this.bus.subscribe('stock.moved', (event) => this.onStockMoved(event));
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    this.debouncer.clear();
  }

  private onStockMoved(event: DomainEvent<'stock.moved'>): void {
    const { locationId, itemId } = event.payload;
    this.debouncer.trigger(keyOf(locationId, itemId), () =>
      this.checkAndNotify(locationId, itemId).catch((err) =>
        this.logger.error(`low-stock check failed for ${keyOf(locationId, itemId)}: ${err instanceof Error ? err.message : String(err)}`),
      ),
    );
  }

  /**
   * The actual detection + notify step — public so tests exercise it
   * directly, synchronously, without waiting out the debounce window.
   */
  async checkAndNotify(locationId: string, itemId: string): Promise<void> {
    const key = keyOf(locationId, itemId);

    // One connection, one transaction for the whole check: the balance/rule
    // read AND the recipient lookup run under the same central-role RLS
    // bypass (`withSystemContext`) so this never checks out two pool
    // connections for one logical detection step.
    const outcome = await withSystemContext(this.pool, async (client) => {
      const dataRes = await client.query<{
        item_name: string;
        location_name: string;
        location_type: string;
        unit_code: string;
        qty_on_hand: string;
        min_qty: string | null;
      }>(
        `SELECT i.name AS item_name, l.name AS location_name, l.type AS location_type, u.code AS unit_code,
                COALESCE((SELECT SUM(qty_on_hand) FROM stock_balances WHERE location_id = $1 AND item_id = $2), 0) AS qty_on_hand,
                msr.min_qty
           FROM items i
           JOIN units u ON u.id = i.base_unit_id
           JOIN locations l ON l.id = $1
           LEFT JOIN min_stock_rules msr ON msr.location_id = $1 AND msr.item_id = $2 AND msr.is_active = true
          WHERE i.id = $2`,
        [locationId, itemId],
      );

      const data = dataRes.rows[0];
      if (!data || data.min_qty === null) return { hasRule: false as const };

      // Bind the narrowed (non-null) value to its own const: TS narrows a
      // property ACCESS EXPRESSION (`data.min_qty`) after a null guard, but
      // does not retroactively narrow `data`'s own declared type — spreading
      // `data` into a returned object literal later would still carry
      // `min_qty: string | null`. Capturing it here, once, keeps every
      // downstream use genuinely `string`.
      const minQty = data.min_qty;

      if (compareQty(data.qty_on_hand, minQty) >= 0) {
        return { hasRule: true as const, isBelow: false as const, itemName: data.item_name, locationName: data.location_name, unitCode: data.unit_code, qtyOnHand: data.qty_on_hand, minQty };
      }

      const recipientIds = await this.resolveRecipients(client, locationId, data.location_type === 'warehouse');
      return {
        hasRule: true as const,
        isBelow: true as const,
        itemName: data.item_name,
        locationName: data.location_name,
        unitCode: data.unit_code,
        qtyOnHand: data.qty_on_hand,
        minQty,
        recipientIds,
      };
    });

    if (!outcome.hasRule) {
      // No active rule for this key — nothing to compare against.
      return;
    }

    if (!outcome.isBelow) {
      return;
    }

    const last = this.lastNotifiedAt.get(key);
    if (last !== undefined && Date.now() - last < this.options.cooldownMs) {
      return;
    }

    const { itemName, locationName, unitCode, qtyOnHand, minQty, recipientIds } = outcome;
    if (recipientIds.length === 0) {
      this.logger.warn(`low_stock crossing at location ${locationId} item ${itemId} has no LDR/SPV/KGD recipient to notify`);
      this.lastNotifiedAt.set(key, Date.now());
      return;
    }

    await this.notifications.notify({
      templateKey: 'low_stock',
      userIds: recipientIds,
      locationId,
      params: {
        itemName,
        locationName,
        currentQty: qtyOnHand,
        minQty,
        unit: unitCode,
      },
    });
    this.lastNotifiedAt.set(key, Date.now());
  }

  /** LDR/SPV of the location; KGD too when the location is the central warehouse (CONTRACTS.md §4.7's note). */
  private async resolveRecipients(client: PoolClient, locationId: string, isWarehouse: boolean): Promise<string[]> {
    const roles = isWarehouse ? ['leader_outlet', 'supervisor', 'kepala_gudang'] : ['leader_outlet', 'supervisor'];
    const res = await client.query<{ id: string }>(
      `SELECT DISTINCT u.id
         FROM users u
         JOIN roles r ON r.id = u.role_id
         JOIN user_locations ul ON ul.user_id = u.id
        WHERE ul.location_id = $1 AND u.is_active = true AND r.key = ANY($2::varchar[])`,
      [locationId, roles],
    );
    return res.rows.map((r) => r.id);
  }
}
