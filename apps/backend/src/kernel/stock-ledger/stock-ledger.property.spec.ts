/**
 * Property tests (fast-check) for `StockLedgerService` against the LIVE
 * database (BUILD-PLAN §5 W2-A): "Balance ≡ fold of movements, always, in
 * both modes"; "replaying any subset of movements in any order yields
 * identical balances (T-02)"; "strict never produces a negative balance,
 * fact may but always records the exception".
 *
 * `@mimi/sync-protocol`'s `stock-projector.property.test.ts` already proves
 * these properties for the PURE fold function in-memory. This file proves
 * the same properties hold once `StockLedgerService` has actually persisted
 * each movement through real Postgres, one `post()` call at a time — i.e.
 * that the service's locking/upsert/idempotency machinery introduces no
 * drift from the pure projector it wraps.
 *
 * Everything below runs inside ONE outer transaction for the whole file,
 * rolled back in `afterAll` — no fast-check run ever durably writes a row,
 * and every run picks a fresh, never-before-touched `(location, area,
 * item)` key so runs cannot interfere with each other either.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { PoolClient } from 'pg';
import { addQty, isNegativeQty, MovementType, ZERO_QTY } from '@mimi/shared';
import { subQty } from '@mimi/shared';
import { StockLedgerService } from './stock-ledger.service';
import { EventBus } from '../events/event-bus.service';
import { StockMovedEventEmitter } from './stock-ledger-events';
import { StockInsufficientError, type PostMovementInput } from './stock-ledger.types';
import {
  closeTestPool,
  closeTestTx,
  openTestTx,
  pickUnusedStockKey,
  readBalance,
  type StockFixtureKey,
} from './test-support/live-db';

const service = new StockLedgerService(new StockMovedEventEmitter(new EventBus()));

const IN_TYPES = [
  MovementType.PURCHASE_IN,
  MovementType.TRANSFER_IN,
  MovementType.RETURN_IN,
  MovementType.ADJUSTMENT_IN,
] as const;
const OUT_TYPES = [
  MovementType.USAGE_OUT,
  MovementType.WASTE_OUT,
  MovementType.RETURN_OUT,
  MovementType.ADJUSTMENT_OUT,
] as const;

interface Step {
  direction: 'in' | 'out';
  movementType: MovementType;
  qty: string;
}

const inStepArb = fc
  .record({
    movementType: fc.constantFrom(...IN_TYPES),
    qtyWhole: fc.integer({ min: 1, max: 500 }),
  })
  .map((r): Step => ({ direction: 'in', movementType: r.movementType, qty: `${r.qtyWhole}.000` }));

const outStepArb = fc
  .record({
    movementType: fc.constantFrom(...OUT_TYPES),
    qtyWhole: fc.integer({ min: 1, max: 500 }),
  })
  .map((r): Step => ({ direction: 'out', movementType: r.movementType, qty: `${r.qtyWhole}.000` }));

const stepArb = fc.oneof(inStepArb, outStepArb);

function movementFor(key: StockFixtureKey, step: Step, refId: string): PostMovementInput {
  return {
    ...key,
    movementType: step.movementType,
    qty: step.qty,
    unitCost: '1000.00',
    refType: 'property_test',
    refId,
    actorId: null,
  };
}

describe('StockLedgerService — property tests (live database)', () => {
  let client: PoolClient;

  beforeAll(async () => {
    client = await openTestTx();
  });

  afterAll(async () => {
    await closeTestTx(client);
    await closeTestPool();
  });

  // Each `it` gets its own SAVEPOINT on top of the file's shared outer
  // transaction. Without this, a genuine Postgres-level error inside ANY
  // fast-check run (as opposed to a plain JS assertion failure) marks the
  // WHOLE transaction aborted (25P02) — every subsequent query, in every
  // later test in this file, then fails with "current transaction is
  // aborted" regardless of what that test actually does. A per-test
  // SAVEPOINT contains that blast radius to the one test that caused it.
  beforeEach(async () => {
    await client.query('SAVEPOINT test_sp');
  });

  afterEach(async () => {
    await client.query('ROLLBACK TO SAVEPOINT test_sp');
  });

  it('strict mode: never produces a negative balance, and the persisted balance always equals the sum of movements actually applied', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(stepArb, { minLength: 1, maxLength: 12 }), async (steps) => {
        const key = await pickUnusedStockKey(client);
        let expected = ZERO_QTY;

        for (const step of steps) {
          const projected =
            step.direction === 'out' ? subQty(expected, step.qty) : addQty(expected, step.qty);
          const refId = crypto.randomUUID();

          if (isNegativeQty(projected)) {
            await expect(
              service.post(client, [movementFor(key, step, refId)], 'strict'),
            ).rejects.toThrow(StockInsufficientError);
            continue; // rejected — the balance must NOT change
          }

          const result = await service.post(client, [movementFor(key, step, refId)], 'strict');
          expect(result.movements[0].balanceAfter).toBe(projected);
          expect(result.movements[0].wentNegative).toBe(false);
          expected = projected;
        }

        const finalBalance = (await readBalance(client, key)) ?? ZERO_QTY;
        expect(finalBalance).toBe(expected);
        expect(isNegativeQty(finalBalance)).toBe(false);
      }),
      { numRuns: 20 },
    );
  });

  it('fact mode: applies every step regardless of sign (C5), and opens exactly one reconciliation for every crossing into negative — never more, never fewer', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(stepArb, { minLength: 1, maxLength: 12 }), async (steps) => {
        const key = await pickUnusedStockKey(client);
        let expected = ZERO_QTY;
        let expectedReconciliations = 0;

        for (const step of steps) {
          const projected =
            step.direction === 'out' ? subQty(expected, step.qty) : addQty(expected, step.qty);
          const refId = crypto.randomUUID();

          const result = await service.post(client, [movementFor(key, step, refId)], 'fact');
          expect(result.movements[0].balanceAfter).toBe(projected);

          if (isNegativeQty(projected)) {
            expect(result.movements[0].wentNegative).toBe(true);
            expect(result.reconciliationsOpened).toHaveLength(1);
            expectedReconciliations++;
          } else {
            expect(result.movements[0].wentNegative).toBe(false);
            expect(result.reconciliationsOpened).toHaveLength(0);
          }
          expected = projected;
        }

        const finalBalance = (await readBalance(client, key)) ?? ZERO_QTY;
        expect(finalBalance).toBe(expected);

        const reconCount = await client.query<{ n: string }>(
          `SELECT count(*)::int AS n FROM stock_reconciliations WHERE location_id = $1 AND storage_area_id = $2 AND item_id = $3`,
          [key.locationId, key.storageAreaId, key.itemId],
        );
        expect(Number(reconCount.rows[0].n)).toBe(expectedReconciliations);
      }),
      { numRuns: 20 },
    );
  });

  it('T-02: applying the same set of facts to two independent keys in two different orders converges to the same persisted balance', async () => {
    await fc.assert(
      fc.asyncProperty(
        // The identity (`refId`) is attached to each step BEFORE shuffling, so
        // both orderings carry it along regardless of whether `shuffledSubarray`
        // returns the original object references or copies — no separate
        // identity-lookup Map needed. `refId` MUST be a bare UUID (the
        // `stock_movements.ref_id` column is typed `UUID`) — a decorated
        // string like `t02-0-<uuid>` fails `string_to_uuid` at the Postgres
        // level (`22P02`), which marks the whole transaction aborted, which
        // then cascades into every later `pickUnusedStockKey` call in the
        // same test as "current transaction is aborted" — the real root
        // cause behind an early version of this test failing in a
        // confusing place.
        fc
          .array(stepArb, { minLength: 2, maxLength: 10 })
          .map((steps) => steps.map((step) => ({ ...step, refId: crypto.randomUUID() })))
          .chain((idSteps) =>
            fc.tuple(
              fc.constant(idSteps),
              fc.shuffledSubarray(idSteps, {
                minLength: idSteps.length,
                maxLength: idSteps.length,
              }),
            ),
          ),
        async ([orderA, orderB]) => {
          const keyA = await pickUnusedStockKey(client);
          const keyB = await pickUnusedStockKey(client);

          for (const step of orderA) {
            await service.post(client, [movementFor(keyA, step, step.refId)], 'fact');
          }
          for (const step of orderB) {
            await service.post(client, [movementFor(keyB, step, step.refId)], 'fact');
          }

          const balanceA = (await readBalance(client, keyA)) ?? ZERO_QTY;
          const balanceB = (await readBalance(client, keyB)) ?? ZERO_QTY;
          expect(balanceA).toBe(balanceB);
        },
      ),
      { numRuns: 15 },
    );
  });

  it('replaying an entire applied batch again (idempotent redelivery) leaves the balance unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(stepArb, { minLength: 1, maxLength: 8 }), async (steps) => {
        const key = await pickUnusedStockKey(client);
        const withIds = steps.map((step) => movementFor(key, step, crypto.randomUUID()));

        for (const m of withIds) await service.post(client, [m], 'fact');
        const balanceAfterFirstPass = (await readBalance(client, key)) ?? ZERO_QTY;

        // Redeliver the exact same batch — every movement's natural key already exists.
        for (const m of withIds) {
          const result = await service.post(client, [m], 'fact');
          expect(result.movements[0].skippedAsDuplicate).toBe(true);
        }

        const balanceAfterReplay = (await readBalance(client, key)) ?? ZERO_QTY;
        expect(balanceAfterReplay).toBe(balanceAfterFirstPass);
      }),
      { numRuns: 15 },
    );
  });
});
