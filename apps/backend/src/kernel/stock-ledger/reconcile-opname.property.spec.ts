/**
 * W6-04 (financial correctness) — "stock ledger vs opname reconciliation"
 * against the LIVE database.
 *
 * `stock-ledger.property.spec.ts` already proves "balance ≡ fold of
 * movements" for the movements the SERVICE itself posts. `stock-ledger
 * .service.spec.ts` has two unit-level (fake pool) spot-checks of
 * `StockLedgerService.reconcile()` — one matching count, one divergent
 * "physical_count" opname variance. Neither proves `reconcile()` behaves
 * correctly for ARBITRARY movement histories and ARBITRARY counted
 * quantities against REAL Postgres, which is what a physical stock-opname
 * count actually is: an arbitrary human-entered number compared against
 * whatever movements really happened. This file closes that gap with a
 * property test running `reconcile()` for real, against real
 * `stock_movements`/`stock_reconciliations` rows.
 *
 * SEPARATE FINDING, reported (not fixed) alongside this test: the actual
 * production stock-opname flow (`modules/stock-opname/stock-opname.service
 * .ts`'s `postAdjustments`) does NOT call `StockLedgerService.reconcile()`
 * at all — it posts an `ADJUSTMENT_IN`/`ADJUSTMENT_OUT` movement equal to
 * the opname's counted-vs-system diff directly, which keeps `balance ≡ fold
 * of movements` trivially true by construction (the adjustment IS the
 * reconciling entry) but never opens a `stock_reconciliations` row nor
 * routes through the tier/divergence-detail machinery `reconcile()` exists
 * for. That is a design choice this ticket flags for the architect/W1-D to
 * confirm is intentional (two legitimate reconciliation mechanisms for two
 * different triggers: R1/R2 automated tier checks vs. a human physical
 * count) rather than a gap — `stock-opname` is out of this ticket's allowed
 * file scope (`kernel/stock-ledger/**` and the other four named modules
 * only), so it is reported here rather than tested directly.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';

vi.setConfig({ testTimeout: 30_000 });
import type { PoolClient } from 'pg';
import { addQty, MovementType, ReconciliationTier, subQty, ZERO_QTY } from '@mimi/shared';
import { StockLedgerService } from './stock-ledger.service';
import { EventBus } from '../events/event-bus.service';
import { StockMovedEventEmitter } from './stock-ledger-events';
import type { PostMovementInput } from './stock-ledger.types';
import {
  closeTestTx,
  openTestTx,
  pickUnusedStockKey,
  type StockFixtureKey,
} from './test-support/live-db';

const service = new StockLedgerService(new StockMovedEventEmitter(new EventBus()));

const IN_TYPES = [
  MovementType.PURCHASE_IN,
  MovementType.RETURN_IN,
  MovementType.ADJUSTMENT_IN,
] as const;
const OUT_TYPES = [
  MovementType.USAGE_OUT,
  MovementType.WASTE_OUT,
  MovementType.ADJUSTMENT_OUT,
] as const;

interface Step {
  direction: 'in' | 'out';
  movementType: MovementType;
  qty: string;
}

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  fc
    .record({ movementType: fc.constantFrom(...IN_TYPES), qty: fc.integer({ min: 1, max: 50 }) })
    .map((s) => ({ direction: 'in' as const, movementType: s.movementType, qty: `${s.qty}.000` })),
  fc
    .record({ movementType: fc.constantFrom(...OUT_TYPES), qty: fc.integer({ min: 1, max: 20 }) })
    .map((s) => ({ direction: 'out' as const, movementType: s.movementType, qty: `${s.qty}.000` })),
);

/** A generous opening `purchase_in` so a random step sequence (posted 'fact', which allows
 * negative excursions) still has a real, computable, mostly-non-negative running total to check —
 * the reconciliation math itself is exercised regardless of sign, but this keeps the scenario
 * "physically plausible" (an opname is never counting a truck that went 200 units negative). */
const OPENING_QTY = '1000.000';

async function postSteps(
  client: PoolClient,
  key: StockFixtureKey,
  steps: readonly Step[],
): Promise<void> {
  const opening: PostMovementInput = {
    locationId: key.locationId,
    storageAreaId: key.storageAreaId,
    itemId: key.itemId,
    movementType: MovementType.PURCHASE_IN,
    qty: OPENING_QTY,
    unitCost: '1000.00',
    refType: 'reconcile_property_test',
    refId: null,
    actorId: null,
  };
  await service.post(client, [opening], 'fact');
  for (const step of steps) {
    const movement: PostMovementInput = {
      locationId: key.locationId,
      storageAreaId: key.storageAreaId,
      itemId: key.itemId,
      movementType: step.movementType,
      qty: step.qty,
      unitCost: '1000.00',
      refType: 'reconcile_property_test',
      refId: randomUUID(),
      actorId: null,
    };
    await service.post(client, [movement], 'fact');
  }
}

function expectedBalance(steps: readonly Step[]): string {
  let total = OPENING_QTY;
  for (const step of steps) {
    total = step.direction === 'in' ? addQty(total, step.qty) : subQty(total, step.qty);
  }
  return total;
}

describe.skipIf(!process.env.DATABASE_URL)(
  'StockLedgerService.reconcile() vs. an arbitrary opname count — live database property test',
  () => {
    it('when the counted qty EQUALS the true ledger fold, reconcile() reports a match and opens NO stock_reconciliations row', async () => {
      await fc.assert(
        fc.asyncProperty(fc.array(stepArb, { minLength: 0, maxLength: 8 }), async (steps) => {
          const client = await openTestTx();
          try {
            const key = await pickUnusedStockKey(client);
            await postSteps(client, key, steps);
            const trueBalance = expectedBalance(steps);

            const check = await service.reconcile(client, key, trueBalance, {
              tier: ReconciliationTier.CLOUD,
              detail: { source: 'physical_count' },
            });

            expect(check.matches).toBe(true);
            expect(check.expectedQty).toBe(trueBalance);
            expect(check.divergence).toBe(ZERO_QTY);
            expect(check.reconciliationId).toBeUndefined();

            const rows = await client.query(
              `SELECT id FROM stock_reconciliations WHERE location_id = $1 AND storage_area_id = $2 AND item_id = $3`,
              [key.locationId, key.storageAreaId, key.itemId],
            );
            expect(rows.rows).toHaveLength(0);
          } finally {
            // Every path (pass OR assertion failure) must release the connection back to the
            // pool — `openTestTx` acquires from a small (`max: 5`) pool, and fast-check may run
            // dozens of iterations (including shrink retries on a failure) within one `fc.assert`
            // call; leaking even a couple of connections here starves every subsequent iteration
            // (and any other live-DB suite sharing this Postgres instance) into an indefinite
            // connection-pool wait, which surfaces as a confusing 30s "test timed out" rather than
            // the real error.
            await closeTestTx(client);
          }
        }),
        { numRuns: 15 },
      );
    });

    it('when the counted qty DIFFERS from the true ledger fold by any nonzero amount, reconcile() reports the EXACT divergence and durably opens exactly one stock_reconciliations row carrying it', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(stepArb, { minLength: 0, maxLength: 6 }),
          fc.integer({ min: -30, max: 30 }).filter((n) => n !== 0),
          async (steps, deltaUnits) => {
            const client = await openTestTx();
            try {
              const key = await pickUnusedStockKey(client);
              await postSteps(client, key, steps);
              const trueBalance = expectedBalance(steps);
              const countedQty =
                deltaUnits >= 0
                  ? subQty(trueBalance, `${deltaUnits}.000`)
                  : addQty(trueBalance, `${-deltaUnits}.000`);

              const check = await service.reconcile(client, key, countedQty, {
                tier: ReconciliationTier.CLOUD,
                detail: { source: 'physical_count' },
              });

              expect(check.matches).toBe(false);
              expect(check.expectedQty).toBe(trueBalance);
              expect(check.storedQty).toBe(countedQty);
              // divergence = expected − stored (the ledger says X, the counted opname says Y; a
              // positive divergence means the physical count came up SHORT of what the ledger fold
              // says should be there — a genuine shortfall, exactly what feeds POUT-05's payroll
              // deduction apportionment).
              expect(check.divergence).toBe(subQty(trueBalance, countedQty));
              expect(check.reconciliationId).toBeTruthy();

              const rows = await client.query<{
                expected_qty: string;
                stored_qty: string;
                divergence: string;
              }>(
                `SELECT expected_qty, stored_qty, divergence FROM stock_reconciliations WHERE id = $1`,
                [check.reconciliationId],
              );
              expect(rows.rows).toHaveLength(1);
              expect(rows.rows[0]!.expected_qty).toBe(trueBalance);
              expect(rows.rows[0]!.stored_qty).toBe(countedQty);
              expect(rows.rows[0]!.divergence).toBe(check.divergence);
            } finally {
              await closeTestTx(client);
            }
          },
        ),
        { numRuns: 15 },
      );
    });
  },
);
