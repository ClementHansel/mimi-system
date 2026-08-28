/**
 * Integration tests against the LIVE database (BUILD-PLAN §5 W2-A).
 *
 * Run with `POSTGRES_PORT=55433 docker compose up -d postgres` (or any
 * reachable Postgres — see `test-support/live-db.ts` for the connection
 * default). Every test runs inside its own transaction and ROLLBACKs at the
 * end (`afterEach`), so this suite never durably mutates the seed's 630-key
 * invariant — verified explicitly in the last describe block below.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { MovementType } from '@mimi/shared';
import { StockLedgerService } from './stock-ledger.service';
import { EventBus } from '../events/event-bus.service';
import { StockMovedEventEmitter } from './stock-ledger-events';
import { StockInsufficientError, type PostMovementInput } from './stock-ledger.types';
import {
  closeTestPool,
  closeTestTx,
  countInvariantMismatches,
  countInvariantMismatchesForKeys,
  countMovements,
  openTestTx,
  pickUnusedStockKey as pickUnusedStockKeyRaw,
  pickUnusedTransferFixture as pickUnusedTransferFixtureRaw,
  readBalance,
  setRlsContext,
  type StockFixtureKey,
} from './test-support/live-db';

const service = new StockLedgerService(new StockMovedEventEmitter(new EventBus()));

// Every key this FILE'S OWN tests pick, across every test — tracked so the final
// "did this suite leave a mark" assertion can scope the G1 invariant check to
// exactly the keys this suite touched (see `countInvariantMismatchesForKeys`'s
// doc comment) rather than the whole `stock_balances` table, which other
// concurrently-running suites/agents also write to.
const keysTouchedByThisFile: StockFixtureKey[] = [];

async function pickUnusedStockKey(
  client: PoolClient,
  opts?: { excludeLocationId?: string },
): Promise<StockFixtureKey> {
  const key = await pickUnusedStockKeyRaw(client, opts);
  keysTouchedByThisFile.push(key);
  return key;
}

async function pickUnusedTransferFixture(client: PoolClient) {
  const fixture = await pickUnusedTransferFixtureRaw(client);
  keysTouchedByThisFile.push({
    locationId: fixture.from.locationId,
    storageAreaId: fixture.from.storageAreaId,
    itemId: fixture.itemId,
  });
  keysTouchedByThisFile.push({
    locationId: fixture.to.locationId,
    storageAreaId: fixture.to.storageAreaId,
    itemId: fixture.itemId,
  });
  return fixture;
}

function movementFor(
  key: StockFixtureKey,
  overrides: Partial<PostMovementInput> = {},
): PostMovementInput {
  return {
    ...key,
    movementType: MovementType.PURCHASE_IN,
    qty: '10.000',
    unitCost: '5000.00',
    refType: 'goods_receipt',
    refId: crypto.randomUUID(),
    actorId: null,
    ...overrides,
  };
}

describe('StockLedgerService — live database', () => {
  let client: PoolClient;

  beforeEach(async () => {
    client = await openTestTx();
  });

  afterEach(async () => {
    await closeTestTx(client);
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it('posts a real INSERT into stock_balances and stock_movements, PK-referencing real seed rows', async () => {
    const key = await pickUnusedStockKey(client);
    expect(await readBalance(client, key)).toBeNull();

    const result = await service.post(client, [movementFor(key)], 'strict');

    expect(result.movements[0]!.balanceAfter).toBe('10.000');
    expect(await readBalance(client, key)).toBe('10.000');
    expect(await countMovements(client, key)).toBe(1);
  });

  it('strict mode hard-rejects an issue that would go negative, leaving the DB untouched for that key', async () => {
    const key = await pickUnusedStockKey(client);

    await expect(
      service.post(
        client,
        [movementFor(key, { movementType: MovementType.USAGE_OUT, qty: '1.000' })],
        'strict',
      ),
    ).rejects.toThrow(StockInsufficientError);

    expect(await readBalance(client, key)).toBeNull();
    expect(await countMovements(client, key)).toBe(0);
  });

  it('fact mode applies a replayed offline sale even negative, and opens a real stock_reconciliations row', async () => {
    const key = await pickUnusedStockKey(client);

    const result = await service.post(
      client,
      [movementFor(key, { movementType: MovementType.USAGE_OUT, qty: '1.000', refType: 'sale' })],
      'fact',
    );

    expect(result.movements[0]!.wentNegative).toBe(true);
    expect(await readBalance(client, key)).toBe('-1.000');

    const recon = await client.query<{
      status: string;
      tier: string;
      expected_qty: string;
      stored_qty: string;
    }>(`SELECT status, tier, expected_qty, stored_qty FROM stock_reconciliations WHERE id = $1`, [
      result.reconciliationsOpened[0],
    ]);
    expect(recon.rows[0]).toMatchObject({
      status: 'open',
      tier: 'cloud',
      expected_qty: '-1.000',
      stored_qty: '-1.000',
    });
  });

  it('replaying the identical fact through post() a second time does not double-apply (idempotent replay)', async () => {
    const key = await pickUnusedStockKey(client);
    const m = movementFor(key, { refId: crypto.randomUUID() });

    const first = await service.post(client, [m], 'fact');
    const second = await service.post(client, [m], 'fact');

    expect(second.movements[0]!.skippedAsDuplicate).toBe(true);
    expect(second.movements[0]!.id).toBe(first.movements[0]!.id);
    expect(await countMovements(client, key)).toBe(1);
    expect(await readBalance(client, key)).toBe('10.000');
  });

  it('posts a cross-location transfer as two rows with counterparty_* correctly set both ways', async () => {
    const fixture = await pickUnusedTransferFixture(client);
    const refId = crypto.randomUUID();

    const result = await service.postTransfer(
      client,
      {
        itemId: fixture.itemId,
        from: fixture.from,
        to: fixture.to,
        qty: '4.000',
        unitCost: '2500.00',
        refType: 'sj_drop',
        refId,
        actorId: null,
      },
      'fact',
    );

    expect(result.movements).toHaveLength(2);
    expect(await readBalance(client, { ...fixture.from, itemId: fixture.itemId })).toBe('-4.000');
    expect(await readBalance(client, { ...fixture.to, itemId: fixture.itemId })).toBe('4.000');

    const rows = await client.query<{
      movement_type: string;
      location_id: string;
      counterparty_location_id: string | null;
      storage_area_id: string;
      counterparty_storage_area_id: string | null;
    }>(
      `SELECT movement_type, location_id, counterparty_location_id, storage_area_id, counterparty_storage_area_id
         FROM stock_movements WHERE ref_type = 'sj_drop' AND ref_id = $1 ORDER BY movement_type`,
      [refId],
    );
    expect(rows.rows).toHaveLength(2);
    const out = rows.rows.find((r) => r.movement_type === 'transfer_out')!;
    const inbound = rows.rows.find((r) => r.movement_type === 'transfer_in')!;
    expect(out.location_id).toBe(fixture.from.locationId);
    expect(out.counterparty_location_id).toBe(fixture.to.locationId);
    expect(inbound.location_id).toBe(fixture.to.locationId);
    expect(inbound.counterparty_location_id).toBe(fixture.from.locationId);
  });

  it('reconcile() recomputes from real stock_movements rows and opens a real exception on divergence', async () => {
    const key = await pickUnusedStockKey(client);
    await service.post(client, [movementFor(key, { qty: '10.000' })], 'strict');

    // Physical count says 6 — a real opname-style variance against the ledger's derived 10.
    const check = await service.reconcile(client, key, '6.000', {
      detail: { source: 'physical_count' },
    });

    expect(check.matches).toBe(false);
    expect(check.expectedQty).toBe('10.000');
    expect(check.divergence).toBe('4.000');
    expect(check.reconciliationId).toBeDefined();

    const row = await client.query(`SELECT status FROM stock_reconciliations WHERE id = $1`, [
      check.reconciliationId,
    ]);
    expect(row.rows[0].status).toBe('open');
  });

  it('reconcile() writes nothing when the count matches the derived balance', async () => {
    const key = await pickUnusedStockKey(client);
    await service.post(client, [movementFor(key, { qty: '10.000' })], 'strict');

    const before = await client.query(`SELECT count(*)::int AS n FROM stock_reconciliations`);
    const check = await service.reconcile(client, key, '10.000');
    const after = await client.query(`SELECT count(*)::int AS n FROM stock_reconciliations`);

    expect(check.matches).toBe(true);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  describe('RLS enforcement (D-06/D-21 — FORCE ROW LEVEL SECURITY)', () => {
    it('a scoped role can write stock for a location inside app.location_ids', async () => {
      const key = await pickUnusedStockKey(client);
      await setRlsContext(client, {
        role: 'kasir',
        userId: '00000000-0000-0000-0000-0000000000bb',
        locationIds: [key.locationId],
      });

      const result = await service.post(client, [movementFor(key)], 'strict');
      expect(result.movements[0]!.balanceAfter).toBe('10.000');
    });

    it('a scoped role CANNOT write stock for a location outside app.location_ids — RLS rejects the write', async () => {
      const key = await pickUnusedStockKey(client);
      await setRlsContext(client, {
        role: 'kasir',
        userId: '00000000-0000-0000-0000-0000000000cc',
        locationIds: ['00000000-0000-0000-0000-000000000000'], // a location the caller is NOT scoped to
      });

      await expect(service.post(client, [movementFor(key)], 'strict')).rejects.toThrow(
        /row-level security|permission/i,
      );
    });
  });

  describe('G1 invariant preserved', () => {
    it('the whole-table balance ≡ fold-of-movements invariant holds before this suite touches anything', async () => {
      // Runs first among this describe's tests to establish the baseline
      // the seed already guarantees (630/630, 0 mismatches per BUILD-PLAN
      // Gate G1) — a regression here means either seed drift or (more
      // worryingly) a leak from a prior test that forgot to roll back.
      expect(await countInvariantMismatches(client)).toBe(0);
    });

    it('holds again after this transaction posts a batch of movements (still mid-transaction, pre-rollback)', async () => {
      const key = await pickUnusedStockKey(client);
      await service.post(client, [movementFor(key, { qty: '3.000' })], 'strict');
      await service.post(
        client,
        [movementFor(key, { movementType: MovementType.USAGE_OUT, qty: '1.000', refType: 'sale' })],
        'strict',
      );
      expect(await countInvariantMismatches(client)).toBe(0);
    });

    /**
     * The literal "DONE WHEN" criterion: because every prior test's
     * `afterEach` already ROLLBACKed before this test's `beforeEach` opened
     * a fresh transaction, this assertion runs against the database exactly
     * as every OTHER caller (or the next agent's test suite) would see it —
     * proof that nothing in this file left a mark, not just a claim.
     *
     * B-05 (PROGRESS.md): the original version of this check read
     * `countInvariantMismatches(client)` — the WHOLE `stock_balances` table —
     * which fails in a full/shared-DB run whenever some OTHER suite (this
     * file's siblings, or literally another agent's process against the same
     * shared Postgres per this repo's house rules) commits real, unbalanced
     * rows during the run. That is a correct read of a table this suite
     * doesn't own, not evidence this file leaked. Scoped to exactly the keys
     * THIS file's own tests picked (`keysTouchedByThisFile`, appended to by
     * every `pickUnusedStockKey`/`pickUnusedTransferFixture` call above), the
     * assertion verifies precisely the claim being made — "nothing I touched
     * is left mismatched" — without also asserting something about keys this
     * suite never went near.
     */
    it('the seed invariant is unchanged after the entire suite above has run', async () => {
      expect(await countInvariantMismatchesForKeys(client, keysTouchedByThisFile)).toBe(0);
      // None of this file's OWN keys should carry a surviving balance row either —
      // every test here rolled back, so a row still existing for one of its own
      // picked keys would mean a leaked commit, not ambient noise from elsewhere.
      for (const key of keysTouchedByThisFile) {
        expect(await readBalance(client, key)).toBeNull();
      }
      const counts = await client.query<{ n: string }>(
        `SELECT count(*)::int AS n FROM stock_balances`,
      );
      expect(Number(counts.rows[0]!.n)).toBeGreaterThanOrEqual(630);
    });
  });
});
