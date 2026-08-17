import { randomUUID } from 'node:crypto';
import { BadRequestException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  addQty,
  businessDateOf,
  businessDayBoundaries,
  can,
  ERR_NOT_FOUND,
  ERR_STOCK_INSUFFICIENT,
  ERR_VALIDATION,
  formatQty,
  mulMoneyByQty,
  parseQty,
  RoleKey,
  subQty,
  SyncEntity,
  ZERO_QTY,
  type Balance,
  type ISODate,
  type Movement,
  type Paginated,
} from '@mimi/shared';

import { StockLedgerService } from '../../kernel/stock-ledger/stock-ledger.service';
import { StockInsufficientError } from '../../kernel/stock-ledger/stock-ledger.types';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';

import type { ListBalancesFilters, ListMovementsFilters } from './inventory.repository';
import { InventoryRepository } from './inventory.repository';
import { assertLocationInScope } from './scope.util';
import type { AreaTransferResult, HistoryDayRow, InventorySummary, LowStockRow, MinStockRuleRow, SuggestionRow } from './types';

export interface CallerContext {
  userId: string;
  roleKey: RoleKey;
  /** `RlsContextGuard`'s resolved scope — `null` = central role, unrestricted. */
  locationScope: readonly string[] | null;
}

/** `[start, end)` date string arithmetic on plain `'YYYY-MM-DD'` fields — same "calendar math, no tz" convention `@mimi/shared/wita`'s `payrollPeriodBoundaries` already uses. */
function addDaysToDateString(date: ISODate, days: number): ISODate {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/**
 * M07 `inventory` — read APIs over `stock_balances`/`stock_movements` (never
 * written here, D-07), `min_stock_rules` CRUD, low-stock detection support,
 * and the D-15 area-transfer action. `StockLedgerService.post`/`postTransfer`
 * is the ONLY path this service uses to move stock; everything else is a
 * plain, RLS-scoped read.
 */
@Injectable()
export class InventoryService {
  constructor(
    private readonly repo: InventoryRepository,
    private readonly stockLedger: StockLedgerService,
    private readonly syncEmit: SyncEmitService,
  ) {}

  // ── GET /balances ───────────────────────────────────────────────────────
  async getBalances(
    client: PoolClient,
    caller: CallerContext,
    filters: ListBalancesFilters,
    page: number | undefined,
    pageSize: number | undefined,
  ): Promise<Paginated<Balance>> {
    assertLocationInScope(caller.locationScope, filters.locationId);
    const includeValue = can(caller.roleKey, 'supplier.price.read');
    const { rows, total, page: p, pageSize: ps } = await this.repo.listBalances(client, filters, page, pageSize);

    const mapped: Balance[] = rows.map((r) => ({
      locationId: r.locationId,
      storageAreaId: r.storageAreaId,
      storageAreaName: r.storageAreaName,
      storageAreaType: r.storageAreaType as Balance['storageAreaType'],
      itemId: r.itemId,
      sku: r.sku,
      itemName: r.itemName,
      unitCode: r.unitCode,
      qtyOnHand: r.qtyOnHand,
      minQty: r.minQty,
      belowMin: r.belowMin,
      ...(includeValue ? { value: mulMoneyByQty(r.avgCost, r.qtyOnHand) } : {}),
    }));
    return { rows: mapped, total, page: p, pageSize: ps };
  }

  // ── GET /summary ────────────────────────────────────────────────────────
  async getSummary(client: PoolClient, caller: CallerContext, locationId: string | undefined): Promise<InventorySummary> {
    assertLocationInScope(caller.locationScope, locationId);
    const includeValue = can(caller.roleKey, 'supplier.price.read');
    const [totals, byArea] = await Promise.all([
      this.repo.getSummaryTotals(client, locationId),
      this.repo.getSummaryByArea(client, locationId),
    ]);
    return {
      totalItems: totals.totalItems,
      belowMin: totals.belowMin,
      ...(includeValue ? { stockValue: totals.stockValue } : {}),
      byArea,
    };
  }

  // ── GET /movements ──────────────────────────────────────────────────────
  async getMovements(
    client: PoolClient,
    caller: CallerContext,
    filters: ListMovementsFilters,
    page: number | undefined,
    pageSize: number | undefined,
  ): Promise<Paginated<Movement>> {
    assertLocationInScope(caller.locationScope, filters.locationId);
    return this.repo.listMovements(client, filters, page, pageSize);
  }

  // ── GET /low-stock ──────────────────────────────────────────────────────
  async getLowStock(client: PoolClient, caller: CallerContext, locationId: string | undefined): Promise<LowStockRow[]> {
    assertLocationInScope(caller.locationScope, locationId);
    return this.repo.listLowStock(client, locationId);
  }

  // ── GET /min-stock ──────────────────────────────────────────────────────
  async getMinStock(
    client: PoolClient,
    caller: CallerContext,
    locationId: string | undefined,
    page: number | undefined,
    pageSize: number | undefined,
  ): Promise<Paginated<MinStockRuleRow>> {
    assertLocationInScope(caller.locationScope, locationId);
    return this.repo.listMinStock(client, locationId, page, pageSize);
  }

  // ── PUT /min-stock ──────────────────────────────────────────────────────
  /**
   * Bulk upserts, then emits one `min_stock_rules.updated` sync event PER
   * rule (class M, own-location pull scope — SYNC-PROTOCOL §3.3 group 3:
   * devices pre-warn low-stock from this cache even while offline) — one
   * event per rule rather than one event for the whole batch so a device
   * that already has some of these rules cached doesn't need special
   * batch-diffing logic; each rule update is independently idempotent by its
   * own `eventId`. Commits explicitly at the end (the AIRE/Wave-3 convention
   * this repo's mutating endpoints follow — `RlsContextGuard` already opened
   * the transaction this `client` is on; `RlsCleanupInterceptor`'s ROLLBACK
   * after a successful COMMIT is a documented no-op, not a bug).
   */
  async upsertMinStock(
    client: PoolClient,
    caller: CallerContext,
    locationId: string,
    rules: readonly { itemId: string; minQty: string; reorderQty?: string }[],
  ): Promise<MinStockRuleRow[]> {
    assertLocationInScope(caller.locationScope, locationId);
    const rows = await this.repo.upsertMinStockRules(client, locationId, rules, caller.userId);

    for (const row of rows) {
      await this.syncEmit.emit(client, {
        entity: SyncEntity.MIN_STOCK_RULES,
        op: 'updated',
        entityId: row.id,
        locationId: row.locationId,
        actorUserId: caller.userId,
        data: {
          id: row.id,
          locationId: row.locationId,
          itemId: row.itemId,
          minQty: row.minQty,
          reorderQty: row.reorderQty,
          isActive: row.isActive,
        },
      });
    }

    await client.query('COMMIT');
    return rows;
  }

  // ── GET /suggestions ────────────────────────────────────────────────────
  /**
   * Replenishment-quantity recommendation per FR-LOG-08/19: usage-pattern
   * basis when the item has moved in the last 14 days (`mv_item_usage_daily`
   * — a week's worth of average daily consumption as the suggested cover);
   * falls back to the min-stock rule's own `reorder_qty` when there is no
   * usage history to project from (e.g. a newly-onboarded item, or a
   * warehouse-only item that never posts `usage_out`). `ZERO_QTY` with basis
   * `'reorder_qty'` when neither exists — nothing computable to suggest.
   */
  async getSuggestions(client: PoolClient, caller: CallerContext, locationId: string | undefined): Promise<SuggestionRow[]> {
    assertLocationInScope(caller.locationScope, locationId);
    const inputs = await this.repo.listSuggestionInputs(client, locationId);

    return inputs.map((r): SuggestionRow => {
      if (parseQty(r.qty14) > 0n) {
        const avgDailyUsage = divideQtyByInteger(r.qty14, 14);
        const suggestedQty = multiplyQtyByInteger(avgDailyUsage, 7);
        return {
          itemId: r.itemId,
          itemName: r.itemName,
          qtyOnHand: r.qtyOnHand,
          minQty: r.minQty,
          avgDailyUsage,
          suggestedQty,
          basis: 'usage_pattern',
        };
      }
      return {
        itemId: r.itemId,
        itemName: r.itemName,
        qtyOnHand: r.qtyOnHand,
        minQty: r.minQty,
        avgDailyUsage: ZERO_QTY,
        suggestedQty: r.reorderQty ?? ZERO_QTY,
        basis: 'reorder_qty',
      };
    });
  }

  // ── POST /area-transfer ─────────────────────────────────────────────────
  async postAreaTransfer(
    client: PoolClient,
    caller: CallerContext,
    input: { locationId: string; itemId: string; fromAreaId: string; toAreaId: string; qty: string; reason?: string },
  ): Promise<AreaTransferResult> {
    assertLocationInScope(caller.locationScope, input.locationId);

    if (input.fromAreaId === input.toAreaId) {
      throw new BadRequestException({ code: ERR_VALIDATION, message: 'fromAreaId and toAreaId must be different storage areas' });
    }

    const [fromArea, toArea, unitCost] = await Promise.all([
      this.repo.getStorageArea(client, input.fromAreaId),
      this.repo.getStorageArea(client, input.toAreaId),
      this.repo.getItemAvgCost(client, input.itemId),
    ]);
    if (!fromArea || fromArea.locationId !== input.locationId) {
      throw new BadRequestException({ code: ERR_VALIDATION, message: 'fromAreaId does not belong to locationId' });
    }
    if (!toArea || toArea.locationId !== input.locationId) {
      throw new BadRequestException({ code: ERR_VALIDATION, message: 'toAreaId does not belong to locationId' });
    }
    if (unitCost === null) {
      throw new NotFoundException({ code: ERR_NOT_FOUND, message: `Item ${input.itemId} not found` });
    }

    const refId = randomUUID();
    let result;
    try {
      result = await this.stockLedger.postTransfer(
        client,
        {
          itemId: input.itemId,
          from: { locationId: input.locationId, storageAreaId: input.fromAreaId },
          to: { locationId: input.locationId, storageAreaId: input.toAreaId },
          qty: input.qty,
          unitCost,
          refType: 'area_transfer',
          refId,
          actorId: caller.userId,
          reason: input.reason ?? null,
        },
        'strict',
      );
    } catch (err) {
      // `StockInsufficientError` (strict-mode C5 branch) is a plain `Error`,
      // not an `HttpException` — the global filter would otherwise fold it
      // into an unhelpful 500 `ERR_INTERNAL`. This IS the endpoint's
      // documented 422 case (CONTRACTS §0/D-15: a warehouse/outlet can't
      // move stock it doesn't have between its own areas) — never POS's
      // "the sale already happened, don't block it" exemption, which does
      // not apply here.
      if (err instanceof StockInsufficientError) {
        throw new UnprocessableEntityException({ code: ERR_STOCK_INSUFFICIENT, message: err.message });
      }
      throw err;
    }

    // Reads must happen BEFORE COMMIT — `SET LOCAL ROLE app_user` and the
    // RLS session vars this whole request runs under are transaction-scoped
    // and revert the instant this client commits (see the class doc on
    // `upsertMinStock` for the same rule stated once, not repeated per call site).
    const ids = result.movements.map((m) => m.id);
    const movements = await this.repo.getMovementsByIds(client, ids);
    await client.query('COMMIT');

    return { ok: true, movements };
  }

  // ── GET /history/:itemId ────────────────────────────────────────────────
  /**
   * Reconstructs a daily qtyIn/qtyOut/closing series anchored on TODAY's live
   * `stock_balances` total (summed across areas for this `(location, item)`)
   * and walked backward through the window's movement deltas to find the
   * opening balance, then forward again to build each day's closing. A
   * movement posted between this query running and the response reaching the
   * caller is not reflected — the same "as of now" property any live
   * dashboard figure has; not a defect specific to this endpoint.
   */
  async getHistory(
    client: PoolClient,
    caller: CallerContext,
    locationId: string,
    itemId: string,
    days: number | undefined,
  ): Promise<HistoryDayRow[]> {
    assertLocationInScope(caller.locationScope, locationId);
    if (!(await this.repo.itemExists(client, itemId))) {
      throw new NotFoundException({ code: ERR_NOT_FOUND, message: `Item ${itemId} not found` });
    }

    const windowDays = days && days > 0 ? days : 30;
    const todayWita = businessDateOf(new Date().toISOString());
    const firstDate = addDaysToDateString(todayWita, -(windowDays - 1));
    const { startUtc } = businessDayBoundaries(firstDate);
    const { endUtc } = businessDayBoundaries(todayWita); // exclusive upper bound = tomorrow's WITA midnight

    const [dailyTotals, currentBalance] = await Promise.all([
      this.repo.getDailyMovementTotals(client, locationId, itemId, startUtc, endUtc),
      this.repo.getLocationItemTotal(client, locationId, itemId),
    ]);

    const dates: ISODate[] = [];
    for (let i = 0; i < windowDays; i++) dates.push(addDaysToDateString(firstDate, i));

    let netTotal = ZERO_QTY;
    for (const date of dates) {
      const t = dailyTotals.get(date);
      if (t) netTotal = addQty(netTotal, subQty(t.qtyIn, t.qtyOut));
    }

    let running = subQty(currentBalance, netTotal); // balance just BEFORE the window starts
    const rows: HistoryDayRow[] = [];
    for (const date of dates) {
      const t = dailyTotals.get(date) ?? { qtyIn: ZERO_QTY, qtyOut: ZERO_QTY };
      running = addQty(running, subQty(t.qtyIn, t.qtyOut));
      rows.push({ date, qtyIn: t.qtyIn, qtyOut: t.qtyOut, closing: running });
    }
    return rows;
  }
}

// ── Qty-by-small-integer helpers (kept local: these are convenience wrappers
// around @mimi/shared's exact bigint-scaled arithmetic for the one thing it
// doesn't already expose — multiplying/dividing a Qty by a plain small
// integer constant, e.g. "×7 days of cover" — not a reimplementation of the
// arithmetic itself). ──────────────────────────────────────────────────────
function multiplyQtyByInteger(qty: string, factor: number): string {
  return formatQty(parseQty(qty) * BigInt(factor));
}

function divideQtyByInteger(qty: string, divisor: number): string {
  // Half-up rounding to Qty scale (3dp) — matches @mimi/shared's decimal convention.
  const scaled = parseQty(qty);
  const div = BigInt(divisor);
  const quotient = scaled / div;
  const remainder = scaled % div;
  const roundedUp = (remainder < 0n ? -remainder : remainder) * 2n >= div ? (scaled < 0n ? -1n : 1n) : 0n;
  return formatQty(quotient + roundedUp);
}
