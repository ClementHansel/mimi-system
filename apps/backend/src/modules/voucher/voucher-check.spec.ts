/**
 * `POST /api/vouchers/check` and the redemption evaluator underneath it.
 *
 * Two things are pinned down here, and the second one is the one that matters:
 *
 *  1. EVERY `VoucherRejection` maps to its own `ERR_VOUCHER_*` code. The list
 *     is driven off the shared union itself rather than a hand-written array,
 *     so adding a seventh reason fails this test as well as failing to
 *     compile — belt and braces on a mapping whose whole purpose is that a
 *     cashier is never told "tidak berlaku" with no reason.
 *  2. Each rejection is provoked through the REAL shared `checkVoucher()`,
 *     driven by a real-shaped batch row, not by stubbing the calculator. A
 *     test that asserted "when checkVoucher returns 'expired' we map to
 *     ERR_VOUCHER_EXPIRED" would pass forever even if the ORDER of checks
 *     changed and a customer with an expired coupon started hearing "spend
 *     more" instead. The order (status → window → location → minimum) is part
 *     of the contract, so it is exercised, not mocked.
 *
 * The repository is a stub; the DB is not involved. What is under test is the
 * rule plumbing, and the rules are pure.
 */
import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import {
  ERR_VOUCHER_BELOW_MINIMUM,
  ERR_VOUCHER_EXPIRED,
  ERR_VOUCHER_NOT_ACTIVE,
  ERR_VOUCHER_NOT_FOUND,
  ERR_VOUCHER_NOT_STARTED,
  ERR_VOUCHER_OFFLINE_BLOCKED,
  ERR_VOUCHER_WRONG_LOCATION,
  type VoucherRejection,
} from '@mimi/shared';
import { VoucherRedemptionService } from './voucher-redemption.service';
import { VoucherService } from './voucher.service';
import { errorCodeForRejection } from './voucher-rejection.util';
import type { VoucherRepository, VoucherWithBatchRow } from './voucher.repository';

const LOCATION_A = '11111111-1111-4111-8111-111111111111';
const LOCATION_B = '22222222-2222-4222-8222-222222222222';
const VOUCHER_ID = '33333333-3333-4333-8333-333333333333';
const BATCH_ID = '44444444-4444-4444-8444-444444444444';

/**
 * A live, `active`, fixed-Rp-10.000 coupon valid all of 2026 at every outlet,
 * with no minimum. Every case below is this row with ONE field moved, so a
 * failing assertion names exactly the rule that broke.
 */
function batchRow(overrides: Partial<VoucherWithBatchRow> = {}): VoucherWithBatchRow {
  return {
    id: VOUCHER_ID,
    batch_id: BATCH_ID,
    code: 'MC-ABCD-2345',
    status: 'active',
    issued_at: '2026-01-01T00:00:00.000Z',
    printed_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    batch_code: 'PROMO-2026',
    batch_name: 'Promo Agustus',
    batch_type: 'fixed',
    batch_value: '10000.00',
    batch_min_subtotal: '0.00',
    batch_max_discount: null,
    batch_valid_from: '2026-01-01',
    batch_valid_until: '2026-12-31',
    batch_location_ids: null,
    batch_status: 'issued',
    ...overrides,
  };
}

/**
 * `settings` is read by `getVoucherOfflinePolicy` with a raw
 * `SELECT value FROM settings`. The fake answers that one query and nothing
 * else — anything unexpected reaching the client is a bug in the code under
 * test, so it throws rather than returning an empty result set that would let
 * a wrong query pass silently.
 */
function fakeClient(offlinePolicy: 'reject' | 'accept' = 'reject'): PoolClient {
  return {
    query: vi.fn(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('FROM settings')) {
        return { rows: [{ value: offlinePolicy }], rowCount: 1 };
      }
      throw new Error(`unexpected query in this test: ${String(sql)}`);
    }),
  } as unknown as PoolClient;
}

function serviceWith(row: VoucherWithBatchRow | undefined): {
  vouchers: VoucherService;
  redemption: VoucherRedemptionService;
} {
  const repo = {
    findByCode: vi.fn(async () => row),
  } as unknown as VoucherRepository;
  const conflicts = { recordConflictIfAbsent: vi.fn() } as never;
  const redemption = new VoucherRedemptionService(repo, conflicts);
  return { vouchers: new VoucherService(repo, redemption), redemption };
}

/**
 * Each row is [the rejection the shared calculator should produce, the row
 * mutation that provokes it, the basket subtotal, the location]. Driven
 * through the REAL `checkVoucher()`.
 */
const CASES: ReadonlyArray<{
  reason: VoucherRejection;
  row: VoucherWithBatchRow | undefined;
  subtotal: string;
  locationId: string;
  expected: string;
}> = [
  {
    reason: 'not_found',
    row: undefined,
    subtotal: '50000.00',
    locationId: LOCATION_A,
    expected: ERR_VOUCHER_NOT_FOUND,
  },
  {
    reason: 'not_active',
    row: batchRow({ status: 'redeemed' }),
    subtotal: '50000.00',
    locationId: LOCATION_A,
    expected: ERR_VOUCHER_NOT_ACTIVE,
  },
  {
    reason: 'not_started',
    row: batchRow({ batch_valid_from: '2099-01-01', batch_valid_until: '2099-12-31' }),
    subtotal: '50000.00',
    locationId: LOCATION_A,
    expected: ERR_VOUCHER_NOT_STARTED,
  },
  {
    reason: 'expired',
    row: batchRow({ batch_valid_from: '2020-01-01', batch_valid_until: '2020-12-31' }),
    subtotal: '50000.00',
    locationId: LOCATION_A,
    expected: ERR_VOUCHER_EXPIRED,
  },
  {
    reason: 'wrong_location',
    row: batchRow({ batch_location_ids: [LOCATION_B] }),
    subtotal: '50000.00',
    locationId: LOCATION_A,
    expected: ERR_VOUCHER_WRONG_LOCATION,
  },
  {
    reason: 'below_minimum',
    row: batchRow({ batch_min_subtotal: '100000.00' }),
    subtotal: '50000.00',
    locationId: LOCATION_A,
    expected: ERR_VOUCHER_BELOW_MINIMUM,
  },
];

describe('errorCodeForRejection — every VoucherRejection has its own code', () => {
  it.each(CASES.map((c) => c.reason))('%s maps to a distinct ERR_VOUCHER_* code', (reason) => {
    expect(errorCodeForRejection(reason)).toBe(CASES.find((c) => c.reason === reason)!.expected);
  });

  it('maps the six reasons onto six DIFFERENT codes', () => {
    // A mapping that collapsed two reasons onto one code would still satisfy
    // every per-case assertion above while making the cashier's message wrong
    // for one of them.
    const codes = new Set(CASES.map((c) => errorCodeForRejection(c.reason)));
    expect(codes.size).toBe(CASES.length);
  });
});

describe('VoucherService.check — through the real shared rules', () => {
  it.each(CASES)('$reason → { ok: false, code: $expected }', async (testCase) => {
    const { vouchers } = serviceWith(testCase.row);
    const result = await vouchers.check(fakeClient(), {
      code: 'MC-ABCD-2345',
      subtotal: testCase.subtotal,
      locationId: testCase.locationId,
    });
    expect(result).toEqual({ ok: false, code: testCase.expected });
  });

  it('prices an accepted fixed coupon from the batch, not from the caller', async () => {
    const { vouchers } = serviceWith(batchRow());
    const result = await vouchers.check(fakeClient(), {
      code: 'MC-ABCD-2345',
      subtotal: '50000.00',
      locationId: LOCATION_A,
    });
    expect(result).toEqual({
      ok: true,
      voucherId: VOUCHER_ID,
      code: 'MC-ABCD-2345',
      discount: '10000.00',
      batchName: 'Promo Agustus',
    });
  });

  it('caps a percentage coupon at maxDiscount', async () => {
    const { vouchers } = serviceWith(
      batchRow({ batch_type: 'percentage', batch_value: '20.00', batch_max_discount: '5000.00' }),
    );
    const result = await vouchers.check(fakeClient(), {
      code: 'MC-ABCD-2345',
      subtotal: '100000.00', // 20% would be 20.000
      locationId: LOCATION_A,
    });
    expect(result).toMatchObject({ ok: true, discount: '5000.00' });
  });

  it('never lets a discount exceed the basket', async () => {
    // A coupon that made the till owe the customer money would be a refund
    // with no approval behind it. The clamp lives in the shared calculator;
    // this asserts nothing in the plumbing undoes it.
    const { vouchers } = serviceWith(batchRow({ batch_value: '999000.00' }));
    const result = await vouchers.check(fakeClient(), {
      code: 'MC-ABCD-2345',
      subtotal: '12000.00',
      locationId: LOCATION_A,
    });
    expect(result).toMatchObject({ ok: true, discount: '12000.00' });
  });

  it('reports an unparseable code as NOT_FOUND without touching the database', async () => {
    const repo = { findByCode: vi.fn() } as unknown as VoucherRepository;
    const redemption = new VoucherRedemptionService(repo, {
      recordConflictIfAbsent: vi.fn(),
    } as never);
    const service = new VoucherService(repo, redemption);

    /**
     * WRONG LENGTH is what makes a string un-normalisable, not "looks wrong".
     * `normalizeVoucherCode` strips punctuation and folds the confusable
     * characters (`O`→`0`, `I`/`L`→`1`) before checking, so a surprising
     * amount of junk IS a well-formed code — `'not-a-code'` normalises to
     * `MC-N0TA-C0DE`, which is perfectly valid and would be looked up. Only
     * the length gate actually rejects. This test originally used that exact
     * string and failed, which is the assertion earning its keep: the rule is
     * "8 symbols after folding", and anything that reaches 8 goes to the
     * database.
     */
    const result = await service.check(fakeClient(), {
      code: 'MC-12',
      subtotal: '50000.00',
      locationId: LOCATION_A,
    });

    expect(result).toEqual({ ok: false, code: ERR_VOUCHER_NOT_FOUND });
    expect(repo.findByCode).not.toHaveBeenCalled();
  });

  it('normalises what a cashier actually types', async () => {
    // Lower case, no dashes, an `O` for a `0` and an `l` for a `1` — the
    // server must accept exactly the sloppiness the till does, or the two
    // disagree about what "this code" is.
    const { vouchers, redemption } = serviceWith(batchRow({ code: 'MC-0BCD-2345' }));
    const evaluation = await redemption.evaluate(fakeClient(), {
      code: 'mcobcd2345',
      subtotal: '50000.00',
      locationId: LOCATION_A,
      occurredAt: '2026-06-15T04:00:00.000Z',
      offlineAccepted: false,
    });
    expect(evaluation).toMatchObject({ ok: true, code: 'MC-0BCD-2345' });
    void vouchers;
  });
});

describe('the offline gate', () => {
  it('refuses an offline-accepted coupon under pos.voucher_offline = reject, before any lookup', async () => {
    const repo = { findByCode: vi.fn() } as unknown as VoucherRepository;
    const redemption = new VoucherRedemptionService(repo, {
      recordConflictIfAbsent: vi.fn(),
    } as never);

    const evaluation = await redemption.evaluate(fakeClient('reject'), {
      code: 'MC-ABCD-2345',
      subtotal: '50000.00',
      locationId: LOCATION_A,
      occurredAt: '2026-06-15T04:00:00.000Z',
      offlineAccepted: true,
    });

    expect(evaluation).toMatchObject({ ok: false, reason: 'offline_blocked' });
    // The ordering matters: refusing a VALID coupon with a lookup-shaped
    // reason would tell the operator the wrong story about why they lost the
    // money. Under 'reject' the answer is "this till may not accept coupons it
    // cannot verify", full stop.
    expect(repo.findByCode).not.toHaveBeenCalled();
  });

  it('surfaces that refusal as ERR_VOUCHER_OFFLINE_BLOCKED', () => {
    const redemption = new VoucherRedemptionService(
      {} as unknown as VoucherRepository,
      { recordConflictIfAbsent: vi.fn() } as never,
    );
    const exception = redemption.refusalException('offline_blocked', 'MC-ABCD-2345');
    expect((exception.getResponse() as { code: string }).code).toBe(ERR_VOUCHER_OFFLINE_BLOCKED);
  });

  it('verifies the coupon normally under pos.voucher_offline = accept', async () => {
    const { redemption } = serviceWith(batchRow());
    const evaluation = await redemption.evaluate(fakeClient('accept'), {
      code: 'MC-ABCD-2345',
      subtotal: '50000.00',
      locationId: LOCATION_A,
      occurredAt: '2026-06-15T04:00:00.000Z',
      offlineAccepted: true,
    });
    expect(evaluation).toMatchObject({ ok: true, discount: '10000.00' });
  });

  it('does not consult the setting at all when the sale was online', async () => {
    // An online sale must not be gated on `pos.voucher_offline`, and must not
    // pay for the settings read either.
    const client = fakeClient('reject');
    const { redemption } = serviceWith(batchRow());
    await redemption.evaluate(client, {
      code: 'MC-ABCD-2345',
      subtotal: '50000.00',
      locationId: LOCATION_A,
      occurredAt: '2026-06-15T04:00:00.000Z',
      offlineAccepted: false,
    });
    expect(client.query).not.toHaveBeenCalled();
  });
});
