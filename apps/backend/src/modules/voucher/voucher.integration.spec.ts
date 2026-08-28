/**
 * The double-spend guard, against a REAL database, with two REAL concurrent
 * transactions.
 *
 * `voucher-double-redeem.spec.ts` covers how the service HANDLES a refusal by
 * faking SQLSTATE 23505. This suite covers the part no unit test can reach:
 * that the database actually refuses. Those are different claims and both are
 * needed — a perfect handler for an error that never fires would be worthless,
 * and a perfect constraint whose error is swallowed would be worse.
 *
 * WHY TWO CONNECTIONS. A single connection running "insert, then insert again"
 * proves nothing: the second statement would see the first's row and the test
 * would pass even if the unique index had been dropped, because
 * `VoucherService`'s own `status = 'active'` check would catch it. The whole
 * point of migration 254's constraint is the case that check CANNOT catch —
 * two tills that both read `active` before either commits. So both
 * transactions are opened first, both read, and only then do they write.
 *
 * Everything runs as `mimi_app` under the same `SET LOCAL ROLE app_user` +
 * session-var sequence `RlsContextGuard` issues for a real request, so RLS is
 * live throughout. Fixtures are minted and cleaned up through the owner pool.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ERR_VOUCHER_NOT_ACTIVE } from '@mimi/shared';
import { SyncConflictsRepository } from '../../kernel/sync/sync-conflicts.repository';
import { VoucherRedemptionService, type VoucherEvaluation } from './voucher-redemption.service';
import { UNIQUE_VIOLATION, VoucherRepository } from './voucher.repository';
import {

  closePools,
  getOwnerPool,
  withRollback,
  withTwoRacingTransactions,
} from './test-support/live-db';

const BATCH_CODE = 'ITEST-VOUCHER';

let locationId: string;
let kasirId: string;
let batchId: string;
let voucherId: string;
let voucherCode: string;

const repo = new VoucherRepository();
const service = new VoucherRedemptionService(repo, new SyncConflictsRepository());

beforeAll(async () => {
  const owner = getOwnerPool();

  // Read the seed rather than inventing master data: an outlet and a user that
  // already exist keep this suite from depending on its own fixtures being
  // consistent with everyone else's.
  locationId = (await owner.query(`SELECT id FROM locations WHERE type = 'outlet' ORDER BY code LIMIT 1`))
    .rows[0].id;
  kasirId = (await owner.query(`SELECT id FROM users ORDER BY created_at LIMIT 1`)).rows[0].id;

  await owner.query(`DELETE FROM voucher_batches WHERE code = $1`, [BATCH_CODE]);
  batchId = (
    await owner.query(
      `INSERT INTO voucher_batches (code, name, type, value, min_subtotal, valid_from, valid_until, status)
       VALUES ($1, 'Integration test batch', 'fixed', '10000.00', '0.00',
               CURRENT_DATE - 1, CURRENT_DATE + 30, 'issued')
       RETURNING id`,
      [BATCH_CODE],
    )
  ).rows[0].id;

  voucherCode = 'MC-ZZZZ-9999';
  voucherId = (
    await owner.query(
      `INSERT INTO vouchers (batch_id, code, status) VALUES ($1, $2, 'active') RETURNING id`,
      [batchId, voucherCode],
    )
  ).rows[0].id;
});

afterAll(async () => {
  const owner = getOwnerPool();
  // Order matters: redemptions reference vouchers (RESTRICT), vouchers
  // reference the batch (RESTRICT).
  await owner.query(`DELETE FROM voucher_redemptions WHERE voucher_id IN (SELECT id FROM vouchers WHERE batch_id = $1)`, [batchId]);
  await owner.query(`DELETE FROM vouchers WHERE batch_id = $1`, [batchId]);
  await owner.query(`DELETE FROM voucher_batches WHERE id = $1`, [batchId]);
  await closePools();
});

/** The priced answer `commit()` takes, as `evaluate()` would have produced it. */
function accepted(): Extract<VoucherEvaluation, { ok: true }> {
  return {
    ok: true,
    voucherId,
    code: voucherCode,
    discount: '10000.00',
    batchId,
    batchCode: BATCH_CODE,
    batchName: 'Integration test batch',
  };
}

function commitInput(saleId: string | null) {
  return {
    saleId: saleId as string,
    locationId,
    redeemedBy: kasirId,
    offlineAccepted: false,
  };
}

describe('the coupon lookup runs under real RLS', () => {
  it('finds a network-wide coupon from an outlet-scoped session', async () => {
    /**
     * `vouchers` and `voucher_batches` carry NO RLS deliberately (migration
     * 254). This asserts that decision actually holds in the database: a
     * session scoped to ONE outlet must still be able to look up a coupon,
     * because a customer walks into whichever outlet they like with paper
     * printed by head office. If someone later adds a location policy to
     * these tables, this test fails rather than a cashier arguing with a
     * customer holding a valid coupon.
     */
    const found = await withRollback((client) => repo.findByCode(client, voucherCode), {
      role: 'kasir',
      userId: kasirId,
      locationIds: [locationId],
    });

    expect(found).toBeDefined();
    expect(found!.id).toBe(voucherId);
    expect(found!.batch_value).toBe('10000.00');
  });
});

describe('two tills racing on the same coupon', () => {
  it('lets exactly ONE redemption through — the unique index, not the status check, is what decides', async () => {
    const saleA = await insertThrowawaySale('A');
    const saleB = await insertThrowawaySale('B');

    const outcome = await withTwoRacingTransactions(async (a, b) => {
      /**
       * BOTH transactions read the coupon FIRST, while it is still `active`.
       * This is the state a status check cannot distinguish from a legitimate
       * redemption, and it is the entire reason the guard is a constraint.
       */
      const seenByA = await repo.findByCode(a, voucherCode);
      const seenByB = await repo.findByCode(b, voucherCode);
      expect(seenByA!.status).toBe('active');
      expect(seenByB!.status).toBe('active');

      // A writes and COMMITS. B's insert would otherwise block on the unique
      // index until A resolves — Postgres's own behaviour for a conflicting
      // key, not something this test arranges — so A must finish first or the
      // two deadlock. See `withTwoRacingTransactions`'s note.
      const aRedeemed = await service.commit(a, accepted(), commitInput(saleA), 'strict');
      await a.query('COMMIT');

      // B now tries the same coupon, still holding the `active` it read before
      // A committed.
      let bError: unknown;
      try {
        await service.commit(b, accepted(), commitInput(saleB), 'strict');
      } catch (err) {
        bError = err;
      }
      return { aRedeemed, bError };
    });

    expect(outcome.aRedeemed).toBe(true);

    // The loser is told the coupon cannot be used — the SAME message a till
    // that was merely slower would have got, so the race is invisible at the
    // counter.
    expect(outcome.bError).toBeDefined();
    expect((outcome.bError as { response?: { code?: string } }).response?.code).toBe(
      ERR_VOUCHER_NOT_ACTIVE,
    );

    // And the database holds exactly one redemption. This is the assertion the
    // whole suite exists for.
    const owner = getOwnerPool();
    const count = await owner.query(
      `SELECT count(*)::int AS n FROM voucher_redemptions WHERE voucher_id = $1`,
      [voucherId],
    );
    expect(count.rows[0].n).toBe(1);

    const status = await owner.query(`SELECT status FROM vouchers WHERE id = $1`, [voucherId]);
    expect(status.rows[0].status).toBe('redeemed');
  });

  it('raises the constraint by NAME, so a future schema change cannot silently relax it', async () => {
    // Asserting the constraint name pins the guard to migration 254's UNIQUE
    // on `voucher_id` specifically. Widening it to `UNIQUE (voucher_id,
    // sale_id)` — which would permit a double-spend across two sales, the
    // exact thing being prevented — would fail here rather than pass quietly.
    const saleId = await insertThrowawaySale('C');
    const err = await withRollback(async (client) => {
      try {
        await repo.insertRedemption(client, {
          voucherId,
          saleId,
          locationId,
          discountAmount: '10000.00',
          redeemedBy: kasirId,
          offlineAccepted: false,
        });
        return undefined;
      } catch (e) {
        return e as { code?: string; constraint?: string };
      }
    });

    expect(err?.code).toBe(UNIQUE_VIOLATION);
    expect(err?.constraint).toBe('voucher_redemptions_voucher_id_key');
  });

  it('a lost race on the SYNC path does not destroy the sale', async () => {
    /**
     * The `'fact'` counterpart of the first test, and the one with the worst
     * failure mode if the inner savepoint were ever removed: an offline sale
     * that already happened — food out, money in — would be discarded because
     * a coupon was stale.
     *
     * `commit` must return `false`, not throw, and the connection must still
     * be usable afterwards. That second assertion is the savepoint working: a
     * failed INSERT aborts the whole transaction in Postgres, so a subsequent
     * query succeeding is proof the failure was unwound to the savepoint and
     * no further.
     */
    const saleId = await insertThrowawaySale('D');

    await withRollback(async (client) => {
      const redeemed = await service.commit(client, accepted(), commitInput(saleId), 'fact');
      expect(redeemed).toBe(false);

      const stillUsable = await client.query('SELECT 1 AS ok');
      expect(stillUsable.rows[0].ok).toBe(1);
    });
  });
});

/**
 * A minimal committed `sales` row to satisfy `voucher_redemptions.sale_id`'s
 * FK. Minted through the OWNER pool because the point of these tests is the
 * voucher constraint, not `PosSaleService` — building a real sale here would
 * drag in shifts, products, the stock ledger and recipe explosion, and a
 * failure in any of those would masquerade as a voucher bug.
 */
let saleSeq = 0;
async function insertThrowawaySale(tag: string): Promise<string> {
  const owner = getOwnerPool();
  saleSeq += 1;
  const shiftId = (
    await owner.query(`SELECT id FROM pos_shifts WHERE location_id = $1 ORDER BY opened_at LIMIT 1`, [
      locationId,
    ])
  ).rows[0]?.id;
  const res = await owner.query(
    `INSERT INTO sales (receipt_number, client_id, location_id, shift_id, kasir_id, subtotal, discount, total, paid_amount, occurred_at)
     VALUES ($1, gen_random_uuid(), $2, $3, $4, '50000.00', '10000.00', '40000.00', '40000.00', NOW())
     RETURNING id`,
    [`ITEST-VCH-${tag}-${saleSeq}-${Date.now()}`, locationId, shiftId, kasirId],
  );
  return res.rows[0].id;
}
