import { describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { SupplierController } from './supplier.controller';
import type { SupplierService } from './supplier.service';

/**
 * The supplier list was EMPTY in production while 17 suppliers sat in the
 * table, and nothing caught it: RLS let the owner see all 17, the service's
 * own query was correct, and `supplier.integration.spec.ts` calls the service
 * DIRECTLY — so every layer tested fine and the page still showed nothing.
 *
 * The defect lived in the one seam none of that covers: the controller
 * turning an optional `?active` query string into the service's optional
 * boolean. `active === 'true'` collapses THREE input states into two —
 * 'true', 'false', and *absent* — mapping absent to `false` instead of
 * `undefined`. The service reads `false` as "inactive only" and appends
 * `AND is_active = false` beside its `is_active IS NOT FALSE` baseline, a
 * contradiction that returns zero rows for every caller. The frontend never
 * sends `active`, so every real request took exactly that path.
 *
 * These tests are at the CONTROLLER, with the service stubbed, because the
 * argument handed across that boundary IS the bug. Asserting on returned rows
 * would test the service again and pass either way.
 */
describe('SupplierController — query-param coercion', () => {
  function harness() {
    const calls: unknown[][] = [];
    const service = {
      list: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve({ rows: [], total: 0, page: 1, pageSize: 50 });
      },
    } as unknown as SupplierService;
    // `requireDbClient` only pulls `dbClient` off the request; nothing here
    // reaches Postgres, so a marker object is enough to prove it is passed on.
    const req = { dbClient: { marker: 'db' } as unknown as PoolClient } as never;
    return { controller: new SupplierController(service), calls, req };
  }

  it('an absent `active` filters on nothing — the bug that emptied the list', async () => {
    const { controller, calls, req } = harness();
    await controller.list(req);
    // `undefined`, NOT `false`. This is the whole regression: `toBeUndefined`
    // rather than `toBeFalsy`, because `false` is falsy and would pass the
    // weaker assertion while reproducing the outage exactly.
    expect(calls[0]?.[2]).toBeUndefined();
  });

  it('`?active=true` asks for active suppliers only', async () => {
    const { controller, calls, req } = harness();
    await controller.list(req, undefined, 'true');
    expect(calls[0]?.[2]).toBe(true);
  });

  it('`?active=false` asks for inactive suppliers only, and is distinguishable from absent', async () => {
    const { controller, calls, req } = harness();
    await controller.list(req, undefined, 'false');
    // The state the old code was indistinguishable from — an explicit
    // `false` must still mean `false`, or fixing the absent case would break
    // the deactivated-supplier view instead.
    expect(calls[0]?.[2]).toBe(false);
  });

  it('paging defaults are applied, and the db client is handed straight through', async () => {
    const { controller, calls, req } = harness();
    await controller.list(req);
    expect(calls[0]?.[0]).toEqual({ marker: 'db' });
    expect(calls[0]?.[3]).toBe(1);
    expect(calls[0]?.[4]).toBe(50);
  });
});
