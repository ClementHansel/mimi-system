import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { isNegativeQty, isZeroQty, MovementType, ReconciliationTier, ZERO_QTY } from '@mimi/shared';
import type { Qty, UUID } from '@mimi/shared';
import { applyMovement, reconcileBalance, stockKeyOf } from '@mimi/sync-protocol';
import type { LedgerMode, MovementFact, StockKey } from '@mimi/sync-protocol';

import { StockMovedEventEmitter } from './stock-ledger-events';
import type { StockMovedEvent } from './stock-ledger-events';
import {
  PostMovementInput,
  PostedMovement,
  ReconcileOptions,
  ReconciliationResult,
  StockInsufficientError,
  StockLedgerPostResult,
  StockMovementValidationError,
  TransferInput,
} from './stock-ledger.types';

/**
 * The ONLY writer of `stock_balances` (D-07, CONTRACTS.md §0/§1.3 block 020).
 *
 * `post(client, movements, mode)` takes the CALLER's `PoolClient` — never a
 * connection of its own — so every write runs inside the caller's
 * transaction and under the caller's already-established RLS context
 * (`app.user_id`/`app.role`/`app.location_ids`, set by `RlsContextGuard`).
 * Same shape as `ScopeService` (`common/scope/scope.service.ts`, W1-D): no DI
 * pool of its own, so it is structurally impossible for this service to
 * write outside the RLS-scoped transaction it was handed. See that file's
 * class comment for the fuller rationale — it is the pattern this service
 * follows on purpose.
 *
 * Folding logic (fact → signed delta → next balance) is NOT reimplemented
 * here — every arithmetic step delegates to `@mimi/sync-protocol`'s
 * `applyMovement` (single movement, dual-mode) and `reconcileBalance`
 * (recompute-from-scratch comparison), per D-16a. This class's own job is
 * everything `applyMovement` deliberately has no I/O to do: locking,
 * idempotent replay, persistence, reconciliation-row creation, and event
 * emission.
 *
 * DUAL MODE (D-17a, SYNC-PROTOCOL §5.2 C5):
 *  - `'strict'` — interactive callers (a warehouse issuing stock it doesn't
 *    have). Rejects with `StockInsufficientError` before writing anything
 *    for that movement.
 *  - `'fact'` — sync apply (a replayed offline fact). Always applies —
 *    rejecting would invent data ("the chicken really was sold"). A
 *    negative result opens a `stock_reconciliations` exception instead of
 *    failing.
 *
 * IDEMPOTENCY: see `stock-ledger.types.ts`'s `PostMovementInput` doc comment
 * for the natural-key dedup strategy and why `sync_event_id` (UNIQUE, but a
 * single column) cannot carry one shared value across a fact that explodes
 * into several movement rows (e.g. one sale's several recipe ingredients).
 * A `pg_advisory_xact_lock` keyed on the same natural key closes the
 * check-then-insert race between two concurrent transactions applying the
 * same fact — necessary because there is no DB-level UNIQUE constraint at
 * that grain (flagged as a `2xx` candidate in the report).
 */
@Injectable()
export class StockLedgerService {
  constructor(private readonly emitter: StockMovedEventEmitter) {}

  async post(
    client: PoolClient,
    movements: readonly PostMovementInput[],
    mode: LedgerMode,
  ): Promise<StockLedgerPostResult> {
    if (movements.length === 0) {
      return { movements: [], balances: new Map(), reconciliationsOpened: [] };
    }

    for (const movement of movements) {
      this.validateQty(movement);
    }

    const safeSyncEventIds = this.computeSafeSyncEventIds(movements);
    const posted: PostedMovement[] = [];
    const balances = new Map<string, Qty>();
    const reconciliationsOpened: UUID[] = [];
    const events: StockMovedEvent[] = [];

    for (const movement of movements) {
      const result = await this.postOne(client, movement, mode, safeSyncEventIds);
      posted.push(result);
      balances.set(stockKeyOf(movement), result.balanceAfter);

      if (!result.skippedAsDuplicate) {
        if (mode === 'fact' && result.wentNegative) {
          const reconciliationId = await this.openNegativeBalanceReconciliation(
            client,
            movement,
            result.balanceAfter,
          );
          reconciliationsOpened.push(reconciliationId);
        }
        events.push({
          movementId: result.id,
          key: result.key,
          movementType: movement.movementType,
          qty: movement.qty,
          unitCost: movement.unitCost,
          refType: movement.refType,
          refId: movement.refId,
          balanceAfter: result.balanceAfter,
          wentNegative: result.wentNegative,
          mode,
          actorId: movement.actorId,
          occurredAt: movement.occurredAt ?? new Date().toISOString(),
        });
      }
    }

    await this.emitter.emit(events);

    return { movements: posted, balances, reconciliationsOpened };
  }

  /** Convenience for the common two-row transfer case (D-15 area transfer, or a cross-location shipment leg) — builds the paired `transfer_out`/`transfer_in` movements with `counterparty_*` set and posts them in one call. */
  async postTransfer(
    client: PoolClient,
    input: TransferInput,
    mode: LedgerMode,
  ): Promise<StockLedgerPostResult> {
    return this.post(client, this.buildTransferMovements(input), mode);
  }

  buildTransferMovements(input: TransferInput): [PostMovementInput, PostMovementInput] {
    const crossLocation = input.from.locationId !== input.to.locationId;
    const base = {
      itemId: input.itemId,
      qty: input.qty,
      unitCost: input.unitCost,
      refType: input.refType,
      refId: input.refId,
      actorId: input.actorId,
      reason: input.reason ?? null,
      occurredAt: input.occurredAt,
    };

    const out: PostMovementInput = {
      ...base,
      locationId: input.from.locationId,
      storageAreaId: input.from.storageAreaId,
      movementType: MovementType.TRANSFER_OUT,
      counterpartyLocationId: crossLocation ? input.to.locationId : null,
      counterpartyStorageAreaId: input.to.storageAreaId,
      factId: input.refId ? `${input.refId}:transfer_out:${input.itemId}` : undefined,
    };
    const inbound: PostMovementInput = {
      ...base,
      locationId: input.to.locationId,
      storageAreaId: input.to.storageAreaId,
      movementType: MovementType.TRANSFER_IN,
      counterpartyLocationId: crossLocation ? input.from.locationId : null,
      counterpartyStorageAreaId: input.from.storageAreaId,
      factId: input.refId ? `${input.refId}:transfer_in:${input.itemId}` : undefined,
    };
    return [out, inbound];
  }

  /**
   * R1/R2 (SYNC-PROTOCOL §5.5) and physical-count checks alike: recomputes
   * the key's balance from-scratch by folding every `stock_movements` row
   * for it through the shared projector (`reconcileBalance` —
   * `@mimi/sync-protocol`), compares against `storedQty` (whatever the
   * caller is checking against — a device/node-reported balance for a
   * tier-checksum probe, or a physical opname count), and opens a
   * `stock_reconciliations` row when they diverge. Returns the comparison
   * either way; a matching count writes nothing (D-16: divergence is the
   * event, not agreement).
   */
  async reconcile(
    client: PoolClient,
    key: StockKey,
    storedQty: Qty,
    options: ReconcileOptions = {},
  ): Promise<ReconciliationResult> {
    const rows = await client.query<{
      id: string;
      movement_type: string;
      qty: string;
      unit_cost: string;
      ref_type: string;
      ref_id: string | null;
      occurred_at: Date;
    }>(
      `SELECT id, movement_type, qty, unit_cost, ref_type, ref_id, occurred_at
         FROM stock_movements
        WHERE location_id = $1 AND storage_area_id = $2 AND item_id = $3`,
      [key.locationId, key.storageAreaId, key.itemId],
    );

    const movements: MovementFact[] = rows.rows.map((r) => ({
      locationId: key.locationId,
      storageAreaId: key.storageAreaId,
      itemId: key.itemId,
      factId: r.id,
      movementType: r.movement_type as MovementType,
      qty: r.qty,
      unitCost: r.unit_cost,
      refType: r.ref_type,
      refId: r.ref_id,
      occurredAt: r.occurred_at.toISOString(),
    }));

    const check = reconcileBalance(key, storedQty, movements);
    if (check.matches) return check;

    const tier = options.tier ?? ReconciliationTier.CLOUD;
    const detailJson = JSON.stringify(options.detail ?? {});
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO stock_reconciliations
         (location_id, storage_area_id, item_id, tier, expected_qty, stored_qty, divergence, detail, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open')
       RETURNING id`,
      [
        key.locationId,
        key.storageAreaId,
        key.itemId,
        tier,
        check.expectedQty,
        check.storedQty,
        check.divergence,
        detailJson,
      ],
    );

    return {
      ...check,
      reconciliationId: this.requireId(inserted.rows, 'stock_reconciliations insert (reconcile)'),
    };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private validateQty(movement: PostMovementInput): void {
    try {
      if (isZeroQty(movement.qty) || isNegativeQty(movement.qty)) {
        throw new StockMovementValidationError(
          `movement.qty must be > 0 (stock_movements.qty CHECK), got ${movement.qty} for ${movement.movementType} at ${stockKeyOf(movement)}`,
        );
      }
    } catch (err) {
      if (err instanceof StockMovementValidationError) throw err;
      throw new StockMovementValidationError(
        `movement.qty is not a valid decimal string: ${JSON.stringify(movement.qty)} (${(err as Error).message})`,
      );
    }
  }

  /**
   * `sync_event_id` is `UNIQUE` but single-column (CONTRACTS.md block 021).
   * A fact that explodes into N movement rows (a sale's N recipe
   * ingredients, a receipt's N lines) cannot give every row the same
   * `syncEventId` without violating that constraint. Only set the column
   * when the value is unique WITHIN this call's batch — i.e. this is a
   * single-movement fact. Multi-row facts rely on the natural-key dedup in
   * `postOne` instead. See the report for the `2xx` recommendation.
   */
  private computeSafeSyncEventIds(movements: readonly PostMovementInput[]): Set<string> {
    const counts = new Map<string, number>();
    for (const m of movements) {
      if (m.syncEventId) counts.set(m.syncEventId, (counts.get(m.syncEventId) ?? 0) + 1);
    }
    const safe = new Set<string>();
    for (const [id, count] of counts) if (count === 1) safe.add(id);
    return safe;
  }

  private async postOne(
    client: PoolClient,
    movement: PostMovementInput,
    mode: LedgerMode,
    safeSyncEventIds: ReadonlySet<string>,
  ): Promise<PostedMovement> {
    const key: StockKey = {
      locationId: movement.locationId,
      storageAreaId: movement.storageAreaId,
      itemId: movement.itemId,
    };

    if (movement.refId) {
      // Serializes concurrent transactions attempting to apply the SAME
      // fact (same natural key) — closes the race between the existence
      // check below and the insert further down. Released automatically at
      // COMMIT/ROLLBACK of the caller's transaction (xact-scoped lock).
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        this.naturalKeyLockToken(movement),
      ]);

      const existing = await client.query<{ id: string }>(
        `SELECT id FROM stock_movements
          WHERE ref_type = $1 AND ref_id = $2 AND item_id = $3
            AND storage_area_id = $4 AND movement_type = $5
          LIMIT 1`,
        [
          movement.refType,
          movement.refId,
          movement.itemId,
          movement.storageAreaId,
          movement.movementType,
        ],
      );

      if (existing.rows[0]) {
        const balanceRow = await client.query<{ qty_on_hand: string }>(
          `SELECT qty_on_hand FROM stock_balances WHERE location_id = $1 AND storage_area_id = $2 AND item_id = $3`,
          [movement.locationId, movement.storageAreaId, movement.itemId],
        );
        const balanceAfter = balanceRow.rows[0]?.qty_on_hand ?? ZERO_QTY;
        return {
          id: existing.rows[0].id,
          key,
          movementType: movement.movementType,
          qty: movement.qty,
          balanceAfter,
          wentNegative: isNegativeQty(balanceAfter),
          skippedAsDuplicate: true,
        };
      }
    }

    const balanceRow = await client.query<{ qty_on_hand: string }>(
      `SELECT qty_on_hand FROM stock_balances
        WHERE location_id = $1 AND storage_area_id = $2 AND item_id = $3
        FOR UPDATE`,
      [movement.locationId, movement.storageAreaId, movement.itemId],
    );
    const currentBalance: Qty = balanceRow.rows[0]?.qty_on_hand ?? ZERO_QTY;

    const fact: MovementFact = {
      ...key,
      factId:
        movement.factId ?? `${movement.refType}:${movement.refId ?? 'none'}:${movement.itemId}`,
      movementType: movement.movementType,
      qty: movement.qty,
      unitCost: movement.unitCost,
      refType: movement.refType,
      refId: movement.refId,
      occurredAt: movement.occurredAt ?? new Date().toISOString(),
    };

    const outcome = applyMovement(currentBalance, fact, mode);
    if (!outcome.ok) {
      throw new StockInsufficientError(outcome.message, key, movement);
    }

    if (balanceRow.rows.length > 0) {
      await client.query(
        `UPDATE stock_balances SET qty_on_hand = $4, updated_at = NOW()
          WHERE location_id = $1 AND storage_area_id = $2 AND item_id = $3`,
        [movement.locationId, movement.storageAreaId, movement.itemId, outcome.nextBalance],
      );
    } else {
      await client.query(
        `INSERT INTO stock_balances (location_id, storage_area_id, item_id, qty_on_hand)
         VALUES ($1, $2, $3, $4)`,
        [movement.locationId, movement.storageAreaId, movement.itemId, outcome.nextBalance],
      );
    }

    const useSyncEventId =
      movement.syncEventId && safeSyncEventIds.has(movement.syncEventId)
        ? movement.syncEventId
        : null;

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO stock_movements
         (location_id, storage_area_id, item_id, movement_type, qty, unit_cost, ref_type, ref_id,
          counterparty_location_id, counterparty_storage_area_id, actor_id, reason, sync_event_id, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, COALESCE($14, NOW()))
       RETURNING id`,
      [
        movement.locationId,
        movement.storageAreaId,
        movement.itemId,
        movement.movementType,
        movement.qty,
        movement.unitCost,
        movement.refType,
        movement.refId,
        movement.counterpartyLocationId ?? null,
        movement.counterpartyStorageAreaId ?? null,
        movement.actorId,
        movement.reason ?? null,
        useSyncEventId,
        movement.occurredAt ?? null,
      ],
    );

    return {
      id: this.requireId(inserted.rows, 'stock_movements insert'),
      key,
      movementType: movement.movementType,
      qty: movement.qty,
      balanceAfter: outcome.nextBalance,
      wentNegative: outcome.wentNegative,
      skippedAsDuplicate: false,
    };
  }

  private async openNegativeBalanceReconciliation(
    client: PoolClient,
    movement: PostMovementInput,
    balanceAfter: Qty,
  ): Promise<UUID> {
    const detail = JSON.stringify({
      reason: 'negative_balance',
      movementType: movement.movementType,
      refType: movement.refType,
      refId: movement.refId,
    });
    const result = await client.query<{ id: string }>(
      `INSERT INTO stock_reconciliations
         (location_id, storage_area_id, item_id, tier, expected_qty, stored_qty, divergence, detail, status)
       VALUES ($1, $2, $3, $4, $5, $5, '0.000', $6, 'open')
       RETURNING id`,
      [
        movement.locationId,
        movement.storageAreaId,
        movement.itemId,
        ReconciliationTier.CLOUD,
        balanceAfter,
        detail,
      ],
    );
    return this.requireId(result.rows, 'stock_reconciliations insert (negative balance)');
  }

  private naturalKeyLockToken(movement: PostMovementInput): string {
    return `stock_movements:${movement.refType}:${movement.refId}:${movement.itemId}:${movement.storageAreaId}:${movement.movementType}`;
  }

  /** `RETURNING id` on a successful single-row INSERT always yields exactly one row; this only guards against `noUncheckedIndexedAccess`'s `T | undefined` at the type level. */
  private requireId(rows: readonly { id: string }[], context: string): string {
    const id = rows[0]?.id;
    if (!id) throw new Error(`${context}: expected RETURNING id to yield a row, got none`);
    return id;
  }
}
