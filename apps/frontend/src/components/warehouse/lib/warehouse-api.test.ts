import { describe, it, expect, vi } from 'vitest';
import { api } from '@/lib/api';
import { getBalances } from './warehouse-api';

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn().mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 200 }) },
}));

/**
 * FIX-LOADS #1 — `GET /inventory/balances` 400'd with ERR_VALIDATION
 * ("pageSize must not be greater than 200", `ListBalancesQueryDto`'s
 * `@Max(200)`, CONTRACTS.md's global pagination rule) every time the "Stok
 * Gudang" tab loaded, because this wrapper requested `pageSize=500`. Locks
 * the request to the documented 200 ceiling so this can't silently regress.
 */
describe('warehouse-api getBalances', () => {
  it('requests a pageSize within the backend-enforced max of 200', async () => {
    await getBalances({ locationId: 'loc-1' });
    const calledPath = vi.mocked(api.get).mock.calls[0]?.[0] as string;
    const qs = new URLSearchParams(calledPath.split('?')[1]);
    expect(Number(qs.get('pageSize'))).toBeLessThanOrEqual(200);
  });
});
