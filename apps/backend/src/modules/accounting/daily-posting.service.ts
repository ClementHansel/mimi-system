import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { v5 as uuidv5 } from 'uuid';
import { JournalEventType, type Money, type UUID } from '@mimi/shared';
import { EventBus } from '../../kernel/events/event-bus.service';

/**
 * B-16 — the daily GL aggregator for JOUT-03 (`outlet_sales`) and JOUT-02
 * (`outlet_ingredient_usage`).
 *
 * Both rules are defined in CONTRACTS §6.2 as a "daily aggregate of applied
 * `sales.completed`", and the posting engine's own comment says the caller is
 * a daily aggregator — but no aggregator existed and the backend has no
 * scheduler at all, so neither event was ever published. POS revenue and COGS
 * simply never reached the general ledger. This service is that missing
 * caller.
 *
 * It is a SEPARATE pass rather than an emit inside `pos-sale.service.ts` on
 * purpose: a sale is created offline, synced late, and may be voided after the
 * fact, so posting per-sale would either post revenue that later reverses or
 * post it on the wrong calendar day. Aggregating a finished business day is
 * the shape the contract asks for and the shape that survives late sync.
 */

/** Fixed namespace for deriving a per-(location, day) UUID. Never change it: the value IS the idempotency key, and a new namespace would re-post every day already posted. */
const DAY_POSTING_NAMESPACE = '6f9c8a52-3f4f-5c1e-9a7b-2d0e6c1b8f43';

export interface DailyPostingResult {
  locationId: UUID;
  businessDate: string;
  /** Gross revenue credited to 4000, or '0.00' when the outlet had no completed sales. */
  salesTotal: Money;
  byMethod: Record<string, Money>;
  /** Cost of the recipe explosions the day's sales drew, debited to 5000. */
  ingredientUsage: Money;
  posted: boolean;
}

function dayRefId(locationId: UUID, businessDate: string): UUID {
  return uuidv5(`${locationId}:${businessDate}`, DAY_POSTING_NAMESPACE) as UUID;
}

/**
 * The engine takes `entryDate` as `occurredAt.slice(0, 10)`, so the string
 * must literally BEGIN with the business date. Building it as
 * `<date>T23:59:59+08:00` keeps the entry on the WITA day it belongs to
 * (NFR-10) — the exact defect the seed already hit once, where a UTC
 * `toISOString()` put eight hours of every day on the wrong date.
 */
function endOfBusinessDay(businessDate: string): string {
  return `${businessDate}T23:59:59.999+08:00`;
}

function toMoney(raw: string | null): Money {
  if (raw === null) return '0.00';
  const n = Number.parseFloat(raw);
  return (Number.isFinite(n) ? n : 0).toFixed(2) as Money;
}

@Injectable()
export class DailyPostingService {
  private readonly logger = new Logger(DailyPostingService.name);

  constructor(private readonly eventBus: EventBus) {}

  /**
   * Posts one outlet's completed business day. Safe to re-run: the journal's
   * `UNIQUE (event_type, ref_type, ref_id) WHERE source='system'` makes a
   * replay a no-op, and `ref_id` here is derived from (location, date) rather
   * than generated, precisely so a retry cannot double-post revenue.
   */
  async postBusinessDay(
    client: PoolClient,
    locationId: UUID,
    businessDate: string,
  ): Promise<DailyPostingResult> {
    const [byMethod, totals, usage] = await Promise.all([
      this.paymentsByMethod(client, locationId, businessDate),
      this.saleTotals(client, locationId, businessDate),
      this.ingredientUsage(client, locationId, businessDate),
    ]);

    const result: DailyPostingResult = {
      locationId,
      businessDate,
      salesTotal: totals.total,
      byMethod,
      ingredientUsage: usage,
      posted: false,
    };

    if (totals.total === '0.00' && usage === '0.00') return result;

    if (totals.total !== '0.00') {
      // Guard, not decoration. `Σ payments` exceeds `Σ total` by exactly the
      // cash change given back, so crediting revenue with Σ total while
      // debiting cash with Σ payments would post a permanently unbalanced
      // entry. `cashLeg` nets the change off; this asserts the arithmetic
      // actually reconciles before anything reaches the ledger.
      const legSum = Object.values(byMethod).reduce((acc, v) => acc + Number.parseFloat(v), 0);
      if (Math.abs(legSum - Number.parseFloat(totals.total)) > 0.005) {
        throw new Error(
          `Refusing to post an unbalanced day for location ${locationId} on ${businessDate}: ` +
            `payment legs sum to ${legSum.toFixed(2)} but completed sales total ${totals.total}. ` +
            `This means payments, change_amount and totals disagree in the data, not in this query.`,
        );
      }

      await this.eventBus.publish('journal.action', {
        eventType: JournalEventType.OUTLET_SALES,
        documentType: 'sale_day',
        documentId: dayRefId(locationId, businessDate),
        locationId,
        amount: totals.total,
        context: { byMethod },
        occurredAt: endOfBusinessDay(businessDate),
      });
    }

    if (usage !== '0.00') {
      await this.eventBus.publish('journal.action', {
        eventType: JournalEventType.OUTLET_INGREDIENT_USAGE,
        documentType: 'usage_day',
        documentId: dayRefId(locationId, businessDate),
        locationId,
        amount: usage,
        context: { source: 'recipe_explosion' },
        occurredAt: endOfBusinessDay(businessDate),
      });
    }

    result.posted = true;
    this.logger.log(
      `Posted ${businessDate} for location ${locationId}: revenue ${totals.total}, ingredient usage ${usage}`,
    );
    return result;
  }

  /** Every outlet that actually traded on the given day — so a caller does not have to enumerate locations that have nothing to post. */
  async locationsWithActivity(client: PoolClient, businessDate: string): Promise<UUID[]> {
    const res = await client.query<{ location_id: string }>(
      `SELECT DISTINCT location_id FROM sales
        WHERE status = 'completed'
          AND (occurred_at AT TIME ZONE 'Asia/Makassar')::date = $1::date
       UNION
       SELECT DISTINCT location_id FROM stock_movements
        WHERE movement_type = 'usage_out' AND ref_type = 'sale'
          AND (occurred_at AT TIME ZONE 'Asia/Makassar')::date = $1::date`,
      [businessDate],
    );
    return res.rows.map((r) => r.location_id as UUID);
  }

  /**
   * Payment legs by method, with the cash leg net of change given.
   *
   * `online` is deliberately absent: online-order money arrives through
   * `platform_settlement` (X5) against 1030, not through `sale_payments`,
   * whose CHECK constraint only allows cash/qris/bank_transfer.
   */
  private async paymentsByMethod(
    client: PoolClient,
    locationId: UUID,
    businessDate: string,
  ): Promise<Record<string, Money>> {
    // Change is netted off in a SEPARATE query, not in this GROUP BY: a split
    // payment joins one sale row to several payment rows, so summing
    // `s.change_amount` alongside the payments would count that sale's change
    // once per payment line.
    const [paid, change] = await Promise.all([
      client.query<{ method: string; amount: string }>(
        `SELECT p.method, ROUND(SUM(p.amount), 2) AS amount
           FROM sale_payments p
           JOIN sales s ON s.id = p.sale_id
          WHERE s.location_id = $1
            AND s.status = 'completed'
            AND (s.occurred_at AT TIME ZONE 'Asia/Makassar')::date = $2::date
          GROUP BY p.method`,
        [locationId, businessDate],
      ),
      client.query<{ change: string | null }>(
        `SELECT ROUND(COALESCE(SUM(change_amount), 0), 2) AS change
           FROM sales
          WHERE location_id = $1
            AND status = 'completed'
            AND (occurred_at AT TIME ZONE 'Asia/Makassar')::date = $2::date`,
        [locationId, businessDate],
      ),
    ]);

    const changeGiven = Number.parseFloat(toMoney(change.rows[0]?.change ?? null));
    const out: Record<string, Money> = {};
    for (const row of paid.rows) {
      const raw = Number.parseFloat(toMoney(row.amount));
      // Change is only ever handed back in cash, so it reduces the cash leg.
      const net = row.method === 'cash' ? raw - changeGiven : raw;
      const amount = net.toFixed(2) as Money;
      if (amount !== '0.00') out[row.method] = amount;
    }
    return out;
  }

  private async saleTotals(
    client: PoolClient,
    locationId: UUID,
    businessDate: string,
  ): Promise<{ total: Money }> {
    const res = await client.query<{ total: string | null }>(
      `SELECT ROUND(COALESCE(SUM(total), 0), 2) AS total
         FROM sales
        WHERE location_id = $1
          AND status = 'completed'
          AND (occurred_at AT TIME ZONE 'Asia/Makassar')::date = $2::date`,
      [locationId, businessDate],
    );
    return { total: toMoney(res.rows[0]?.total ?? null) };
  }

  /** Value of the recipe explosions the day's sales drew (`usage_out` movements with `ref_type='sale'`). */
  private async ingredientUsage(
    client: PoolClient,
    locationId: UUID,
    businessDate: string,
  ): Promise<Money> {
    const res = await client.query<{ value: string | null }>(
      `SELECT ROUND(COALESCE(SUM(qty * unit_cost), 0), 2) AS value
         FROM stock_movements
        WHERE location_id = $1
          AND movement_type = 'usage_out'
          AND ref_type = 'sale'
          AND (occurred_at AT TIME ZONE 'Asia/Makassar')::date = $2::date`,
      [locationId, businessDate],
    );
    return toMoney(res.rows[0]?.value ?? null);
  }
}
