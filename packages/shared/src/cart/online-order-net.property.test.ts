/**
 * W6-04 (financial correctness) — GoFood/ShopeeFood net-received math (E7 in
 * ACCEPTANCE.md §5, listed as "NONE"). `index.test.ts` already spot-checks
 * one hand-picked amount set for `calculateOnlineOrderNet` /
 * `validateOnlineOrderNet` / `calculateOnlineOrderJournalSplit`; this file
 * adds PROPERTY coverage — the identities that must hold for every possible
 * platform settlement, not just the one example already on file — plus the
 * boundary/negative cases a single spot-check can't catch (a 1-cent
 * mismatch, a wholly-refunded order, fees that exceed gross).
 *
 * Why this matters as money the business actually receives: `netReceived`
 * is what hits the bank/e-wallet; `calculateOnlineOrderJournalSplit`'s two
 * legs (`netLeg` to the platform-receivable account, `feeLeg` to commission
 * expense) are what the GL is SUPPOSED to record for it (JOUT-03's online
 * branch — see the accounting-side finding below about whether that GL
 * posting is ever reachable in production). If `netLeg + feeLeg` ever drift
 * from `grossAmount`, the journal split silently loses or invents money.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ERR_NET_MISMATCH } from '../error-codes';
import { addMoney, compareMoney, isNegativeMoney, subMoney } from '../money';
import {
  calculateOnlineOrderJournalSplit,
  calculateOnlineOrderNet,
  validateOnlineOrderNet,
  type OnlineOrderAmounts,
} from './index';

/** Non-negative Money strings up to `maxRupiah`, 2dp — every amount here (gross/discount/fee) is
 * a magnitude a platform settlement can plausibly report; none of these fields is ever negative
 * in the real DTO (CONTRACTS.md §4.13). */
function nonNegativeMoney(maxRupiah: number) {
  return fc.integer({ min: 0, max: maxRupiah }).map((n) => `${n}.00`);
}

function amountsArb() {
  return fc.record({
    grossAmount: nonNegativeMoney(2_000_000),
    discountAmount: nonNegativeMoney(500_000),
    platformFee: nonNegativeMoney(500_000),
    otherFee: nonNegativeMoney(100_000),
  });
}

describe('property: calculateOnlineOrderNet is exactly gross − discount − fees, for any amount combination', () => {
  it('net = gross - discount - platformFee - otherFee, no rounding drift (integer-cent Money, no float anywhere)', () => {
    fc.assert(
      fc.property(amountsArb(), (amounts) => {
        const net = calculateOnlineOrderNet(amounts);
        const expected = subMoney(
          subMoney(subMoney(amounts.grossAmount, amounts.discountAmount), amounts.platformFee),
          amounts.otherFee,
        );
        expect(net).toBe(expected);
      }),
    );
  });
});

describe('property: the journal split never loses or invents money — netLeg + feeLeg === grossAmount, always', () => {
  it('calculateOnlineOrderJournalSplit(amounts).netLeg + .feeLeg === amounts.grossAmount for any amount combination (the GL-balance guarantee JOUT-03 depends on)', () => {
    fc.assert(
      fc.property(amountsArb(), (amounts) => {
        const split = calculateOnlineOrderJournalSplit(amounts);
        expect(addMoney(split.netLeg, split.feeLeg)).toBe(amounts.grossAmount);
      }),
    );
  });

  it('feeLeg is exactly discount + platformFee + otherFee (the three legitimate deductions from gross — nothing else feeds it)', () => {
    fc.assert(
      fc.property(amountsArb(), (amounts) => {
        const split = calculateOnlineOrderJournalSplit(amounts);
        expect(split.feeLeg).toBe(
          addMoney(addMoney(amounts.discountAmount, amounts.platformFee), amounts.otherFee),
        );
      }),
    );
  });
});

describe('property: validateOnlineOrderNet accepts iff netReceived equals the computed net, exactly (no epsilon)', () => {
  it('the true computed net always validates as ok', () => {
    fc.assert(
      fc.property(amountsArb(), (amounts) => {
        const net = calculateOnlineOrderNet(amounts);
        expect(validateOnlineOrderNet(amounts, net)).toEqual({ ok: true });
      }),
    );
  });

  it('any 1-cent-off netReceived is rejected with ERR_NET_MISMATCH and reports the true expected net — never silently accepted as "close enough"', () => {
    fc.assert(
      fc.property(
        amountsArb(),
        fc.integer({ min: 1, max: 9999 }),
        fc.boolean(),
        (amounts, offCents, over) => {
          const net = calculateOnlineOrderNet(amounts);
          const offRupiah = (offCents / 100).toFixed(2);
          const wrong = over ? addMoney(net, offRupiah) : subMoney(net, offRupiah);
          if (wrong === net) return; // subMoney floored/negated to the same value in a degenerate case — not the scenario under test
          const result = validateOnlineOrderNet(amounts, wrong);
          expect(result).toMatchObject({ ok: false, code: ERR_NET_MISMATCH, expectedNet: net });
        },
      ),
    );
  });
});

describe('edge cases: fees that consume the entire gross, and a wholly-discounted order', () => {
  const amounts: OnlineOrderAmounts = {
    grossAmount: '50000.00',
    discountAmount: '20000.00',
    platformFee: '25000.00',
    otherFee: '5000.00',
  };

  it('fees + discount can legitimately equal gross exactly — net is zero, not rejected as an error', () => {
    expect(calculateOnlineOrderNet(amounts)).toBe('0.00');
    expect(validateOnlineOrderNet(amounts, '0.00')).toEqual({ ok: true });
  });

  it('the function does NOT floor at zero when fees exceed gross — a negative net is reported as-is (rejecting it is the caller/DB constraint job, never a silent mask to 0.00)', () => {
    const overFeed: OnlineOrderAmounts = {
      grossAmount: '50000.00',
      discountAmount: '20000.00',
      platformFee: '25000.00',
      otherFee: '10000.00', // total deductions 55,000 > gross 50,000
    };
    const net = calculateOnlineOrderNet(overFeed);
    expect(isNegativeMoney(net)).toBe(true);
    expect(net).toBe('-5000.00');
    // the split invariant must STILL hold even in this negative-net case — it's an algebraic
    // identity, not a business-rule floor.
    const split = calculateOnlineOrderJournalSplit(overFeed);
    expect(addMoney(split.netLeg, split.feeLeg)).toBe(overFeed.grossAmount);
  });

  it('all-zero amounts (a fully void/no-charge platform record) validate as net = 0.00, not an error', () => {
    const zero: OnlineOrderAmounts = {
      grossAmount: '0.00',
      discountAmount: '0.00',
      platformFee: '0.00',
      otherFee: '0.00',
    };
    expect(calculateOnlineOrderNet(zero)).toBe('0.00');
    expect(validateOnlineOrderNet(zero, '0.00')).toEqual({ ok: true });
  });
});

describe('sanity: net is monotonically non-increasing in each fee/discount component', () => {
  it('increasing platformFee alone never increases net', () => {
    fc.assert(
      fc.property(amountsArb(), nonNegativeMoney(200_000), (amounts, extraFee) => {
        const before = calculateOnlineOrderNet(amounts);
        const after = calculateOnlineOrderNet({
          ...amounts,
          platformFee: addMoney(amounts.platformFee, extraFee),
        });
        expect(compareMoney(after, before)).toBeLessThanOrEqual(0);
      }),
    );
  });
});
