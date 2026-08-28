/**
 * The double-spend guard, from the service's side.
 *
 * WHAT THIS TEST CAN AND CANNOT PROVE, stated plainly because the distinction
 * is the whole reason the guard is where it is:
 *
 *   CANNOT — that two concurrent transactions cannot both insert a redemption
 *   for the same coupon. That is a property of the UNIQUE index on
 *   `voucher_redemptions.voucher_id` (migration 254), enforced by Postgres,
 *   and no unit test can demonstrate it because no unit test has two real
 *   transactions. Proving it needs a live database and two connections.
 *
 *   CAN — and this is the part that is actually easy to get wrong in code —
 *   that when the database DOES refuse the second insert, this service does
 *   the right thing with the refusal: the online till is told
 *   `ERR_VOUCHER_NOT_ACTIVE`, the offline path does NOT lose the sale, and
 *   neither path silently proceeds as though the coupon had been redeemed.
 *
 * So the fake client below raises a real-shaped SQLSTATE 23505 on the
 * redemption INSERT, exactly as `pg` would, and every assertion here is about
 * the handling. The constraint itself is verified by review of migration 254
 * and by the `SAVEPOINT`/`ROLLBACK TO SAVEPOINT` sequence asserted below,
 * which is what makes a refusal survivable at all.
 */
import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { ERR_VOUCHER_NOT_ACTIVE } from '@mimi/shared';
import { VoucherRedemptionService, type VoucherEvaluation } from './voucher-redemption.service';
import { UNIQUE_VIOLATION, type VoucherRepository } from './voucher.repository';

const VOUCHER_ID = '33333333-3333-4333-8333-333333333333';
const SALE_ID = '55555555-5555-4555-8555-555555555555';
const LOCATION_ID = '11111111-1111-4111-8111-111111111111';
const KASIR_ID = '66666666-6666-4666-8666-666666666666';

const ACCEPTED: Extract<VoucherEvaluation, { ok: true }> = {
  ok: true,
  voucherId: VOUCHER_ID,
  code: 'MC-ABCD-2345',
  discount: '10000.00',
  batchId: '44444444-4444-4444-8444-444444444444',
  batchCode: 'PROMO-2026',
  batchName: 'Promo Agustus',
};

/** What `pg` throws on a unique-constraint violation, in the shape the code checks. */
function uniqueViolation(): Error & { code: string; constraint: string } {
  return Object.assign(new Error('duplicate key value violates unique constraint'), {
    code: UNIQUE_VIOLATION,
    constraint: 'voucher_redemptions_voucher_id_key',
  });
}

function harness(options: { collide: boolean }) {
  const statements: string[] = [];
  const client = {
    query: vi.fn(async (sql: string) => {
      statements.push(String(sql).trim());
      return { rows: [], rowCount: 0 };
    }),
  } as unknown as PoolClient;

  const repo = {
    insertRedemption: vi.fn(async () => {
      if (options.collide) throw uniqueViolation();
      return 'redemption-id';
    }),
    markRedeemed: vi.fn(async () => true),
  } as unknown as VoucherRepository;

  const conflicts = { recordConflictIfAbsent: vi.fn(async () => ({ id: 'c', created: true })) };
  const service = new VoucherRedemptionService(repo, conflicts as never);

  return { service, client, repo, conflicts, statements };
}

const COMMIT_INPUT = {
  saleId: SALE_ID,
  locationId: LOCATION_ID,
  redeemedBy: KASIR_ID,
  offlineAccepted: false,
};

describe('commit — the happy path', () => {
  it("writes the redemption with the SERVER's discount and flips the coupon", async () => {
    const { service, client, repo } = harness({ collide: false });

    const redeemed = await service.commit(
      client,
      ACCEPTED,
      // The device claimed a bigger discount than the server computed. Rule 1:
      // the server's number is the one that is written.
      { ...COMMIT_INPUT, claimedDiscount: '10000.00' },
      'strict',
    );

    expect(redeemed).toBe(true);
    expect(repo.insertRedemption).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ voucherId: VOUCHER_ID, discountAmount: '10000.00' }),
    );
    expect(repo.markRedeemed).toHaveBeenCalledWith(client, VOUCHER_ID);
  });

  it("raises a finance exception when the device's arithmetic disagreed", async () => {
    const { service, client, conflicts } = harness({ collide: false });

    await service.commit(
      client,
      ACCEPTED,
      { ...COMMIT_INPUT, claimedDiscount: '25000.00' },
      'fact',
    );

    // A device computing discounts differently from the server is either a
    // stale batch cache or tampering, and neither is distinguishable here —
    // both need a human, so both get one.
    expect(conflicts.recordConflictIfAbsent).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        queue: 'finance',
        detail: expect.objectContaining({
          reason: 'voucher_discount_variance',
          claimedByDevice: '25000.00',
          computedByServer: '10000.00',
        }),
      }),
    );
  });

  it('raises nothing when the device agreed', async () => {
    const { service, client, conflicts } = harness({ collide: false });
    await service.commit(
      client,
      ACCEPTED,
      { ...COMMIT_INPUT, claimedDiscount: '10000.00' },
      'fact',
    );
    expect(conflicts.recordConflictIfAbsent).not.toHaveBeenCalled();
  });
});

describe('commit — the coupon was already spent (SQLSTATE 23505)', () => {
  it('refuses the online sale with ERR_VOUCHER_NOT_ACTIVE', async () => {
    const { service, client } = harness({ collide: true });

    // The whole request's transaction is never committed, so the sale inserted
    // moments ago goes with it — the cashier re-rings without the coupon. The
    // message is the same one a coupon that was ALREADY `redeemed` at lookup
    // time produces, so a losing till shows exactly what a slower till would
    // have: the race is invisible to the person at the counter.
    await expect(service.commit(client, ACCEPTED, COMMIT_INPUT, 'strict')).rejects.toMatchObject({
      response: { code: ERR_VOUCHER_NOT_ACTIVE },
    });
  });

  it('does NOT throw on the sync path — an offline sale is a fact', async () => {
    const { service, client, repo } = harness({ collide: true });

    const redeemed = await service.commit(client, ACCEPTED, COMMIT_INPUT, 'fact');

    expect(redeemed).toBe(false);
    // Critically, the coupon is NOT flipped: the OTHER transaction's
    // redemption is the real one, and marking it redeemed here would be this
    // process claiming an event it lost.
    expect(repo.markRedeemed).not.toHaveBeenCalled();
  });

  it('unwinds only its own savepoint, so the sale survives and the connection stays usable', async () => {
    const { service, client, statements } = harness({ collide: true });

    await service.commit(client, ACCEPTED, COMMIT_INPUT, 'fact');

    /**
     * This is the assertion that matters most on the sync path. A failed
     * INSERT aborts the WHOLE transaction in Postgres — without an inner
     * savepoint, a lost race would unwind to `SyncProjectorRegistry`'s
     * per-event savepoint and discard THE ENTIRE SALE: a real sale, already
     * rung, already paid for, thrown away because a coupon was stale, with the
     * event still acked. The savepoint is what confines the damage to the one
     * statement that failed.
     */
    expect(statements[0]).toBe(`SAVEPOINT sp_v_${VOUCHER_ID.replace(/-/g, '')}`);
    expect(statements[1]).toBe(`ROLLBACK TO SAVEPOINT sp_v_${VOUCHER_ID.replace(/-/g, '')}`);
  });

  it('releases the savepoint on success rather than leaking one per sale', async () => {
    const { service, client, statements } = harness({ collide: false });
    await service.commit(client, ACCEPTED, COMMIT_INPUT, 'strict');
    expect(statements).toEqual([
      `SAVEPOINT sp_v_${VOUCHER_ID.replace(/-/g, '')}`,
      `RELEASE SAVEPOINT sp_v_${VOUCHER_ID.replace(/-/g, '')}`,
    ]);
  });

  it('re-throws a NON-unique database error instead of swallowing it as a refusal', async () => {
    // A dead connection, a permission error or a check-constraint violation
    // must not be reported to a cashier as "this coupon is used up". Only
    // 23505 means the race was lost.
    const repo = {
      insertRedemption: vi.fn(async () => {
        throw Object.assign(new Error('connection terminated'), { code: '08006' });
      }),
      markRedeemed: vi.fn(),
    } as unknown as VoucherRepository;
    const service = new VoucherRedemptionService(repo, {
      recordConflictIfAbsent: vi.fn(),
    } as never);
    const client = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    } as unknown as PoolClient;

    await expect(service.commit(client, ACCEPTED, COMMIT_INPUT, 'fact')).rejects.toThrow(
      'connection terminated',
    );
  });
});

describe('recordRefusedRedemption — money given away is never silently dropped', () => {
  it('files a finance exception naming the code, the reason and the amount', async () => {
    const { service, client, conflicts } = harness({ collide: false });

    await service.recordRefusedRedemption(client, {
      saleId: SALE_ID,
      locationId: LOCATION_ID,
      code: 'MC-ABCD-2345',
      reason: 'expired',
      discountGivenAway: '10000.00',
      offlineAccepted: true,
      eventId: null,
    });

    expect(conflicts.recordConflictIfAbsent).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        queue: 'finance',
        assigneeRole: 'finance',
        entity: 'sales',
        entityId: SALE_ID,
        detail: expect.objectContaining({
          reason: 'voucher_rejected',
          voucherRejection: 'expired',
          code: 'MC-ABCD-2345',
          // The number a human has to reconcile. Without it the queue entry
          // would say something went wrong without saying what it cost.
          discountGivenAway: '10000.00',
          offlineAccepted: true,
        }),
      }),
    );
  });
});
