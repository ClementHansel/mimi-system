import type { PoolClient } from 'pg';
import {
  DEFAULT_VOUCHER_OFFLINE_POLICY,
  type SettingsKey,
  type VoucherOfflinePolicy,
} from '@mimi/shared';

/**
 * Reads `pos.voucher_offline` — whether a till that could not reach the cloud
 * may still have taken a coupon.
 *
 * FAILS CLOSED, IN THREE SEPARATE WAYS, AND THAT IS THE WHOLE POINT OF THIS
 * FILE EXISTING RATHER THAN AN INLINE `SELECT value`:
 *
 *   1. Missing row (a database seeded before migration 256) → `'reject'`.
 *   2. Wrong JSON type (an object, a number, null) → `'reject'`.
 *   3. A string that is not one of the two known policies — a typo like
 *      `'Accept'` or `'acept'` — → `'reject'`.
 *
 * Case 3 is the one worth spelling out. `settings-value-validator.ts` types
 * this key as a plain `'string'`, so `PUT /api/settings/pos.voucher_offline`
 * will happily store `"acept"`. If this function did
 * `value as VoucherOfflinePolicy` the compiler would be satisfied and the
 * comparison `policy === 'accept'` would be false — which would happen to be
 * safe today, by luck, purely because `'reject'` is the negative case. Invert
 * that comparison anywhere in future and a typo becomes "accept every
 * unverifiable coupon in the network". So the narrowing happens here, once,
 * explicitly, and an unrecognised value is not passed through.
 *
 * Never throws. A settings read must not be able to fail a sale: an outlet
 * whose `settings` row is somehow unreadable still sells food, it just does
 * not honour offline coupons that minute.
 */
const KEY: SettingsKey = 'pos.voucher_offline';

export async function getVoucherOfflinePolicy(client: PoolClient): Promise<VoucherOfflinePolicy> {
  try {
    const res = await client.query<{ value: unknown }>(
      'SELECT value FROM settings WHERE key = $1',
      [KEY],
    );
    const value = res.rows[0]?.value;
    if (value === 'accept') return 'accept';
    if (value === 'reject') return 'reject';
    return DEFAULT_VOUCHER_OFFLINE_POLICY;
  } catch {
    return DEFAULT_VOUCHER_OFFLINE_POLICY;
  }
}
