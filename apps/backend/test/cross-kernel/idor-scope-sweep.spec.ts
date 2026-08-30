/**
 * IDOR / scope-escape sweep — closes ACCEPTANCE.md B6/B7 ("Guards are proven
 * present; cross-location leakage is not disproven").
 *
 * Every per-module RLS spec in this codebase proves a guard EXISTS (a scoped
 * role's own rows are visible, an unscoped role sees none). None of them try
 * to WALK AROUND the guard: take the identity of a role scoped to outlet A
 * and address a row that belongs to outlet B (or to a different driver, or
 * to nobody) BY ITS EXACT ID. A list endpoint that filters correctly proves
 * nothing about a detail/update endpoint that trusts the id in the URL — an
 * IDOR only shows up when you ask for a specific id from the wrong side.
 *
 * All fixtures are REAL seeded rows read across two distinct real outlets
 * (queried live, not hardcoded ids — the seed reshuffles outlet names across
 * runs but always ships 20 outlets + 1 warehouse with real sales/stock/
 * employee data). The two rows this suite DOES insert (a second petty_cash
 * row, one throwaway pairing_tokens row) are cleaned up in `afterAll`, in
 * FK-safe order, over the OWNER (superuser) pool — see house rule on
 * fixture cleanup.
 *
 * Session context is asserted exactly the way `RlsContextGuard` asserts it
 * for a real request (`withRollbackAs` / `withRollback`, `purchasing`
 * module's live-db harness — reused here because it is generic, not
 * purchasing-specific), over `DATABASE_URL`'s `mimi_app` login role, never
 * the migration superuser.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { ConfigService } from '@nestjs/config';
import {
  withRollbackAs,
  closePool,
  type RlsSessionContext,
} from '../../src/modules/purchasing/test-support/live-db';
import { StorageService } from '../../src/kernel/storage/storage.service';
import { PairingTokensService } from '../../src/modules/device-registry/pairing-tokens.service';
import { hashDeviceToken } from '../../src/kernel/sync/device-auth.guard';
import { OfflineCredentialsRepository } from '../../src/kernel/sync/offline-credentials.repository';
import { assertSystemContext } from '../../src/kernel/sync/system-rls-context';
import type { JwtAccessPayload } from '../../src/common/jwt/jwt-payload.interface';

const OWNER_URL =
  process.env.DATABASE_MIGRATION_URL ??
  `postgres://${process.env.POSTGRES_USER ?? 'mimi'}:${process.env.POSTGRES_PASSWORD ?? 'mimi_secret'}@localhost:${
    process.env.POSTGRES_PORT ?? '55433'
  }/${process.env.POSTGRES_DB ?? 'mimi'}`;
const APP_URL =
  process.env.DATABASE_URL ??
  `postgres://mimi_app:${process.env.DB_APP_PASSWORD ?? 'mimi_app_secret'}@localhost:${
    process.env.POSTGRES_PORT ?? '55433'
  }/${process.env.POSTGRES_DB ?? 'mimi'}`;

const ownerPool = new Pool({ connectionString: OWNER_URL, max: 5 });
const appPool = new Pool({ connectionString: APP_URL, max: 5 });

/**
 * WHETHER TO RUN AT ALL — and why this is no longer
 * `Boolean(process.env.DATABASE_URL)` (fixed 2026-08-28).
 *
 * It used to be exactly that, and the consequence was that this whole sweep —
 * 23 assertions, every one a cross-tenant IDOR check — SILENTLY SKIPPED on any
 * machine that had not exported `DATABASE_URL`. That is the default here:
 * `APP_URL`/`OWNER_URL` above build perfectly good connection strings from the
 * `POSTGRES_*` defaults, and every other integration spec in this repo connects
 * that way. So the run said "23 skipped" next to a green suite, and the fixture
 * bug fixed below sat undetected underneath it. A security test that does not
 * run is worse than one that fails, because a failure is visible.
 *
 * A real connection probe instead, against the same pool the sweep uses. It is
 * a TOP-LEVEL await on purpose: `describe.skipIf(...)` is evaluated at
 * collection time, before any `beforeAll` could have set a flag, so probing in
 * `beforeAll` would leave every `describe` permanently un-skipped and the
 * no-database case would fail instead of skip.
 *
 * Same intent as the `dbAvailable` convention in
 * `modules/report/report.integration.spec.ts`; only the timing differs, because
 * that file gates per-`it` and this one gates per-`describe`.
 */
let hasDb = false;
try {
  // @ts-expect-error TS1378 — vitest loads this file as ESM, where top-level
  // `await` is legal. `tsconfig.testcheck.json` checks tests under the build's
  // CommonJS setting on purpose (see that file: an ESM override turns on
  // TS1272 across every Nest controller, whose decorator metadata genuinely
  // needs value imports). Suppressed here rather than restructured, because
  // the timing IS the point — see the comment block above.
  hasDb = (await ownerPool.query('SELECT 1')).rowCount === 1;
} catch {
  hasDb = false;
}

function userFor(sub: string, roleKey: string, locationIds: string[] = []): JwtAccessPayload {
  return { sub, username: `test-${sub.slice(0, 8)}`, roleKey, locationIds };
}

/**
 * Like `withRollbackAs`, but COMMITS — needed for `PairingTokensService.mint()`
 * fixture setup specifically: `redeem()` is exercised over a SEPARATE connection
 * (a fresh `withRollbackAs`, matching the real shape of "minted during an
 * authenticated request, redeemed later from the device's own public register
 * call"), so the minted row must actually persist for that second transaction
 * to see it. Any row committed this way is tracked by the caller and deleted
 * in `afterAll` over the owner pool.
 */
async function withCommitAs<T>(
  ctx: { role: string; userId: string; locationIds: readonly string[] },
  fn: (client: import('pg').PoolClient) => Promise<T>,
): Promise<T> {
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [ctx.userId]);
    await client.query(`SELECT set_config('app.role', $1, true)`, [ctx.role]);
    await client.query(`SELECT set_config('app.tenant_id', app_the_only_tenant()::text, true)`);
    await client.query(`SELECT set_config('app.location_ids', $1, true)`, [
      ctx.locationIds.join(','),
    ]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

interface Fx {
  outletA: string;
  outletB: string;
  saleA: { id: string; lineId: string };
  saleB: { id: string; lineId: string };
  storageAreaA: string;
  storageAreaB: string;
  stockA: { locationId: string; storageAreaId: string; itemId: string };
  stockB: { locationId: string; storageAreaId: string; itemId: string };
  employeeA: string;
  employeeB: string;
  attachmentScoped: { id: string; locationId: string }; // real location_id, whatever it is
  attachmentUnscoped: string; // location_id IS NULL — the documented gap
  driver1: { id: string; userId: string };
  driver2: { id: string; userId: string };
  sjAssignedToDriver1: string;
}

let fx: Fx;
let pettyCashB: string; // fixture row this suite creates and must clean up
const throwawayPairingTokenIds: string[] = []; // fixture rows this suite creates

beforeAll(async () => {
  if (!hasDb) return;

  /*
   * Two distinct outlets, each with a sale that HAS AT LEAST ONE LINE and a
   * storage area.
   *
   * The line clause is the fix (2026-08-28). This used to take the first two
   * outlets with any `sales` row, then separately fetch "a sale" and "a line of
   * that sale" — asserting a relationship the data does not guarantee. The seed
   * contains an outlet (BJM01: 12 sales, 0 sale_lines) whose id sorts early
   * enough to be picked, so `lineB.rows[0]` came back `undefined` and the suite
   * died in `beforeAll` with "Cannot read properties of undefined (reading
   * 'id')". Combined with the skip gate above, that is why it went unnoticed:
   * the sweep never ran, so the crash never happened.
   *
   * Selecting for exactly what the fixture needs, in one query, is what stops
   * that recurring on the next reseed. `DISTINCT ON` yields one
   * (location, sale, line) triple per outlet.
   */
  const pairs = await ownerPool.query<{ location_id: string; sale_id: string; line_id: string }>(
    `SELECT DISTINCT ON (s.location_id)
            s.location_id, s.id AS sale_id, sl.id AS line_id
       FROM sales s
       JOIN locations l ON l.id = s.location_id AND l.type = 'outlet'
       JOIN sale_lines sl ON sl.sale_id = s.id
      WHERE EXISTS (SELECT 1 FROM storage_areas sa WHERE sa.location_id = s.location_id)
      ORDER BY s.location_id, s.id
      LIMIT 2`,
  );
  if (pairs.rows.length < 2) {
    throw new Error(
      'idor sweep: fewer than 2 outlets have a sale WITH a line and a storage area in the seed',
    );
  }
  const [rowA, rowB] = [pairs.rows[0]!, pairs.rows[1]!];
  const [outletA, outletB] = [rowA.location_id, rowB.location_id];

  // Same shapes the rest of `beforeAll` and `fx` already expect, so this change
  // stays confined to how they are CHOSEN.
  const saleA = { rows: [{ id: rowA.sale_id }] };
  const saleB = { rows: [{ id: rowB.sale_id }] };
  const lineA = { rows: [{ id: rowA.line_id }] };
  const lineB = { rows: [{ id: rowB.line_id }] };

  const storageAreaA = await ownerPool.query<{ id: string }>(
    `SELECT id FROM storage_areas WHERE location_id = $1 LIMIT 1`,
    [outletA],
  );
  const storageAreaB = await ownerPool.query<{ id: string }>(
    `SELECT id FROM storage_areas WHERE location_id = $1 LIMIT 1`,
    [outletB],
  );

  const stockA = await ownerPool.query<{
    location_id: string;
    storage_area_id: string;
    item_id: string;
  }>(
    `SELECT location_id, storage_area_id, item_id FROM stock_balances WHERE location_id = $1 LIMIT 1`,
    [outletA],
  );
  const stockB = await ownerPool.query<{
    location_id: string;
    storage_area_id: string;
    item_id: string;
  }>(
    `SELECT location_id, storage_area_id, item_id FROM stock_balances WHERE location_id = $1 LIMIT 1`,
    [outletB],
  );

  const employeeA = await ownerPool.query<{ id: string }>(
    `SELECT id FROM employees WHERE location_id = $1 LIMIT 1`,
    [outletA],
  );
  const employeeB = await ownerPool.query<{ id: string }>(
    `SELECT id FROM employees WHERE location_id = $1 LIMIT 1`,
    [outletB],
  );

  const attScoped = await ownerPool.query<{ id: string; location_id: string }>(
    `SELECT id, location_id FROM attachments WHERE location_id IS NOT NULL LIMIT 1`,
  );
  const attUnscoped = await ownerPool.query<{ id: string }>(
    `SELECT id FROM attachments WHERE location_id IS NULL LIMIT 1`,
  );
  if (!attScoped.rows[0])
    throw new Error('idor sweep: no attachment with a location_id in the seed');
  if (!attUnscoped.rows[0])
    throw new Error('idor sweep: no location_id-less attachment in the seed');

  // driver1 = a driver who actually has an assigned surat_jalan; driver2 = any OTHER driver
  // (the actual IDOR case: driver2 must NOT be able to reach driver1's SJ by id).
  const driver1Row = await ownerPool.query<{ id: string; user_id: string; sj_id: string }>(
    `SELECT d.id, d.user_id, sj.id AS sj_id
       FROM drivers d
       JOIN surat_jalan sj ON sj.driver_id = d.id
      LIMIT 1`,
  );
  if (!driver1Row.rows[0])
    throw new Error('idor sweep: no driver with an assigned surat_jalan in the seed');
  const driver2Row = await ownerPool.query<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM drivers WHERE id != $1 LIMIT 1`,
    [driver1Row.rows[0].id],
  );
  if (!driver2Row.rows[0]) throw new Error('idor sweep: fewer than 2 drivers in the seed');

  fx = {
    outletA,
    outletB,
    saleA: { id: saleA.rows[0]!.id, lineId: lineA.rows[0]!.id },
    saleB: { id: saleB.rows[0]!.id, lineId: lineB.rows[0]!.id },
    storageAreaA: storageAreaA.rows[0]!.id,
    storageAreaB: storageAreaB.rows[0]!.id,
    stockA: {
      locationId: stockA.rows[0]!.location_id,
      storageAreaId: stockA.rows[0]!.storage_area_id,
      itemId: stockA.rows[0]!.item_id,
    },
    stockB: {
      locationId: stockB.rows[0]!.location_id,
      storageAreaId: stockB.rows[0]!.storage_area_id,
      itemId: stockB.rows[0]!.item_id,
    },
    employeeA: employeeA.rows[0]!.id,
    employeeB: employeeB.rows[0]!.id,
    attachmentScoped: { id: attScoped.rows[0]!.id, locationId: attScoped.rows[0]!.location_id },
    attachmentUnscoped: attUnscoped.rows[0]!.id,
    driver1: { id: driver1Row.rows[0].id, userId: driver1Row.rows[0].user_id },
    driver2: { id: driver2Row.rows[0]!.id, userId: driver2Row.rows[0]!.user_id },
    sjAssignedToDriver1: driver1Row.rows[0].sj_id,
  };

  // Fixture: petty_cash only has one seeded row (at whichever outlet), so a real
  // second-location row is created here to prove cross-location denial, not assumed.
  const pc = await ownerPool.query<{ id: string }>(
    `INSERT INTO petty_cash (pc_number, location_id, purchased_by, purchase_date, store_name, total_amount, status)
     VALUES ('PC/IDOR-SWEEP/0001', $1,
       (SELECT user_id FROM user_locations WHERE location_id = $1 LIMIT 1),
       CURRENT_DATE, 'idor sweep fixture store', 50000, 'pending')
     RETURNING id`,
    [fx.outletB],
  );
  pettyCashB = pc.rows[0]!.id;
}, 60_000);

afterAll(async () => {
  if (!hasDb) return;
  if (pettyCashB) await ownerPool.query(`DELETE FROM petty_cash WHERE id = $1`, [pettyCashB]);
  if (throwawayPairingTokenIds.length) {
    await ownerPool.query(`DELETE FROM pairing_tokens WHERE id = ANY($1::uuid[])`, [
      throwawayPairingTokenIds,
    ]);
  }
  await ownerPool.end();
  await appPool.end();
  await closePool();
});

describe.skipIf(!hasDb)('IDOR sweep — addressing another location/actor by exact id', () => {
  // A supervisor's real session shape: role='supervisor', location_ids=[outletA] only.
  const supervisorAt = (loc: string): RlsSessionContext => ({
    role: 'supervisor',
    userId: '00000000-0000-0000-0000-0000000000a1',
    locationIds: [loc],
  });

  describe('sales / sale_lines (LOC / PARENT)', () => {
    it("a role scoped to outlet A gets ZERO rows addressing outlet B's sale by id", async () => {
      const row = await withRollbackAs(supervisorAt(fx.outletA), (client) =>
        client.query(`SELECT id FROM sales WHERE id = $1`, [fx.saleB.id]).then((r) => r.rows[0]),
      );
      expect(row).toBeUndefined();
    });

    it('...and cannot mutate it either (rowCount 0, not a thrown error — RLS filters silently)', async () => {
      const result = await withRollbackAs(supervisorAt(fx.outletA), (client) =>
        client.query(`UPDATE sales SET notes = 'idor-attempt' WHERE id = $1`, [fx.saleB.id]),
      );
      expect(result.rowCount).toBe(0);
    });

    it("sale_lines inherits the PARENT sale's location — outlet B's line is invisible to outlet A", async () => {
      const row = await withRollbackAs(supervisorAt(fx.outletA), (client) =>
        client
          .query(`SELECT id FROM sale_lines WHERE id = $1`, [fx.saleB.lineId])
          .then((r) => r.rows[0]),
      );
      expect(row).toBeUndefined();
    });

    it("positive control: the SAME query for outlet A's own sale by id succeeds (proves the negative above is a real denial, not a broken query)", async () => {
      const row = await withRollbackAs(supervisorAt(fx.outletA), (client) =>
        client.query(`SELECT id FROM sales WHERE id = $1`, [fx.saleA.id]).then((r) => r.rows[0]),
      );
      expect(row).toBeDefined();
    });
  });

  describe('storage_areas / stock_balances (LOC, stock_balances addressed by composite key not a surrogate id)', () => {
    it("outlet A cannot read outlet B's storage_area by id", async () => {
      const row = await withRollbackAs(supervisorAt(fx.outletA), (client) =>
        client
          .query(`SELECT id FROM storage_areas WHERE id = $1`, [fx.storageAreaB])
          .then((r) => r.rows[0]),
      );
      expect(row).toBeUndefined();
    });

    it("outlet A cannot read outlet B's stock_balances row by (location_id, storage_area_id, item_id)", async () => {
      const row = await withRollbackAs(supervisorAt(fx.outletA), (client) =>
        client
          .query(
            `SELECT qty_on_hand FROM stock_balances WHERE location_id = $1 AND storage_area_id = $2 AND item_id = $3`,
            [fx.stockB.locationId, fx.stockB.storageAreaId, fx.stockB.itemId],
          )
          .then((r) => r.rows[0]),
      );
      expect(row).toBeUndefined();
    });

    it("outlet A cannot ADJUST outlet B's stock_balances row by addressing it directly", async () => {
      const result = await withRollbackAs(supervisorAt(fx.outletA), (client) =>
        client.query(
          `UPDATE stock_balances SET qty_on_hand = qty_on_hand + 999 WHERE location_id = $1 AND storage_area_id = $2 AND item_id = $3`,
          [fx.stockB.locationId, fx.stockB.storageAreaId, fx.stockB.itemId],
        ),
      );
      expect(result.rowCount).toBe(0);
    });
  });

  describe('employees (ROLE(central) OR supervisor+LOC OR SELF)', () => {
    it("a supervisor at outlet A gets ZERO rows addressing outlet B's employee by id", async () => {
      const row = await withRollbackAs(supervisorAt(fx.outletA), (client) =>
        client
          .query(`SELECT id FROM employees WHERE id = $1`, [fx.employeeB])
          .then((r) => r.rows[0]),
      );
      expect(row).toBeUndefined();
    });

    it("positive control: the same supervisor CAN read outlet A's own employee by id", async () => {
      const row = await withRollbackAs(supervisorAt(fx.outletA), (client) =>
        client
          .query(`SELECT id FROM employees WHERE id = $1`, [fx.employeeA])
          .then((r) => r.rows[0]),
      );
      expect(row).toBeDefined();
    });

    it('a kasir (never central, never supervisor+LOC) at outlet A gets zero rows for EITHER employee', async () => {
      const kasirCtx: RlsSessionContext = {
        role: 'kasir',
        userId: '00000000-0000-0000-0000-0000000000a2',
        locationIds: [fx.outletA],
      };
      const rows = await withRollbackAs(kasirCtx, (client) =>
        client
          .query(`SELECT id FROM employees WHERE id IN ($1, $2)`, [fx.employeeA, fx.employeeB])
          .then((r) => r.rows),
      );
      expect(rows).toEqual([]);
    });
  });

  describe('petty_cash (LOC)', () => {
    it("outlet A cannot read outlet B's petty_cash row by id (fixture row this suite created)", async () => {
      const row = await withRollbackAs(supervisorAt(fx.outletA), (client) =>
        client
          .query(`SELECT id FROM petty_cash WHERE id = $1`, [pettyCashB])
          .then((r) => r.rows[0]),
      );
      expect(row).toBeUndefined();
    });

    it('...and cannot verify/reject it either', async () => {
      const result = await withRollbackAs(supervisorAt(fx.outletA), (client) =>
        client.query(`UPDATE petty_cash SET status = 'verified' WHERE id = $1`, [pettyCashB]),
      );
      expect(result.rowCount).toBe(0);
    });
  });

  describe('surat_jalan (driver-scoped predicate: origin LOC OR any drop LOC OR assigned driver)', () => {
    it('a driver NOT assigned to the SJ, with no location scope, cannot read it by id', async () => {
      const driver2Ctx: RlsSessionContext = {
        role: 'driver',
        userId: fx.driver2.userId,
        locationIds: [],
      };
      const row = await withRollbackAs(driver2Ctx, (client) =>
        client
          .query(`SELECT id FROM surat_jalan WHERE id = $1`, [fx.sjAssignedToDriver1])
          .then((r) => r.rows[0]),
      );
      expect(row).toBeUndefined();
    });

    it('...and cannot mark it dispatched either', async () => {
      const driver2Ctx: RlsSessionContext = {
        role: 'driver',
        userId: fx.driver2.userId,
        locationIds: [],
      };
      const result = await withRollbackAs(driver2Ctx, (client) =>
        client.query(`UPDATE surat_jalan SET status = 'in_transit' WHERE id = $1`, [
          fx.sjAssignedToDriver1,
        ]),
      );
      expect(result.rowCount).toBe(0);
    });

    it('positive control: driver1 (the actually-assigned driver) CAN read the same SJ by id', async () => {
      const driver1Ctx: RlsSessionContext = {
        role: 'driver',
        userId: fx.driver1.userId,
        locationIds: [],
      };
      const row = await withRollbackAs(driver1Ctx, (client) =>
        client
          .query(`SELECT id FROM surat_jalan WHERE id = $1`, [fx.sjAssignedToDriver1])
          .then((r) => r.rows[0]),
      );
      expect(row).toBeDefined();
    });
  });

  describe('attachments — NO RLS (migration 009 "NONE" group); StorageService.assertEntityScope is the ENTIRE enforcement', () => {
    const storage = new StorageService(new ConfigService());

    it('a scoped role CANNOT getUrl() an attachment belonging to a location outside its scope', async () => {
      const foreignLocation =
        fx.outletA !== fx.attachmentScoped.locationId ? fx.outletA : fx.outletB;
      const row = await withRollbackAs(supervisorAt(foreignLocation), async (client) => {
        try {
          await storage.getUrl(
            client,
            userFor('u-supervisor-foreign', 'supervisor', [foreignLocation]),
            [foreignLocation],
            fx.attachmentScoped.id,
          );
          return 'did-not-throw';
        } catch (err) {
          return (err as { response?: { code?: string } }).response?.code ?? 'threw-unlabeled';
        }
      });
      expect(row).toBe('ERR_LOCATION_OUT_OF_SCOPE');
    });

    it('DOCUMENTED GAP (report, do not fix): an attachment with NO location_id is readable by ANY authenticated role, including one scoped to an unrelated outlet', async () => {
      const url = await withRollbackAs(supervisorAt(fx.outletB), (client) =>
        storage.getUrl(
          client,
          userFor('u-supervisor-b', 'supervisor', [fx.outletB]),
          [fx.outletB],
          fx.attachmentUnscoped,
        ),
      );
      // This PASSES today because assertEntityScope returns early when
      // row.location_id is null — asserting the CURRENT behaviour, not
      // endorsing it. See storage.service.ts's own doc comment on
      // assertEntityScope and this suite's final report.
      expect(url.url).toBeTruthy();
    });
  });
});

describe.skipIf(!hasDb)('B7 — pairing-token abuse (D-17)', () => {
  const svc = new PairingTokensService();

  it('a redeemed (single-use) token cannot be redeemed a second time — replay is rejected', async () => {
    const locRow = await ownerPool.query<{ id: string }>(`SELECT id FROM locations LIMIT 1`);
    const creatorRow = await ownerPool.query<{ id: string }>(`SELECT id FROM users LIMIT 1`);
    const location = locRow.rows[0]!.id;
    const creator = creatorRow.rows[0]!.id;

    const minted = await withCommitAs(
      { role: 'owner', userId: creator, locationIds: [] },
      (client) =>
        svc.mint(client, { targetType: 'device', locationId: location, createdBy: creator }),
    );
    throwawayPairingTokenIds.push(minted.tokenId);

    const first = await withRollbackAs(
      { role: 'owner', userId: creator, locationIds: [] },
      (client) => svc.redeem(client, minted.token, 'device'),
    );
    expect(first).toBeDefined();
    expect(first?.id).toBe(minted.tokenId);

    // `redeem()`'s own UPDATE ... WHERE used_at IS NULL ... runs inside a
    // ROLLED-BACK transaction above (withRollbackAs never commits), so a
    // literal replay against the SAME transaction state would still look
    // unused. Reproduce the real shape instead: mark it used for real (as
    // the actual register endpoint's own COMMIT would), THEN attempt a
    // second redemption — this is the actual replay path B7 asks about.
    await ownerPool.query(`UPDATE pairing_tokens SET used_at = NOW() WHERE id = $1`, [
      minted.tokenId,
    ]);
    const replay = await withRollbackAs(
      { role: 'owner', userId: creator, locationIds: [] },
      (client) => svc.redeem(client, minted.token, 'device'),
    );
    expect(replay).toBeUndefined();
  });

  it('a token minted for target_type=device cannot be redeemed as a node (cross target-type confusion is rejected)', async () => {
    const locRow = await ownerPool.query<{ id: string }>(`SELECT id FROM locations LIMIT 1`);
    const creatorRow = await ownerPool.query<{ id: string }>(`SELECT id FROM users LIMIT 1`);
    const location = locRow.rows[0]!.id;
    const creator = creatorRow.rows[0]!.id;

    const minted = await withCommitAs(
      { role: 'owner', userId: creator, locationIds: [] },
      (client) =>
        svc.mint(client, { targetType: 'device', locationId: location, createdBy: creator }),
    );
    throwawayPairingTokenIds.push(minted.tokenId);

    const wrongType = await withRollbackAs(
      { role: 'owner', userId: creator, locationIds: [] },
      (client) => svc.redeem(client, minted.token, 'node'),
    );
    expect(wrongType).toBeUndefined();

    // The correct type still works — proves the rejection above is the
    // type check, not a broken hash/lookup.
    const rightType = await withRollbackAs(
      { role: 'owner', userId: creator, locationIds: [] },
      (client) => svc.redeem(client, minted.token, 'device'),
    );
    expect(rightType?.id).toBe(minted.tokenId);
  });

  it('an EXPIRED token is rejected even though it was never used', async () => {
    const locRow = await ownerPool.query<{ id: string }>(`SELECT id FROM locations LIMIT 1`);
    const creatorRow = await ownerPool.query<{ id: string }>(`SELECT id FROM users LIMIT 1`);
    const token = 'idor-sweep-expired-token';
    const inserted = await ownerPool.query<{ id: string }>(
      `INSERT INTO pairing_tokens (token_hash, display_code, target_type, location_id, created_by, expires_at)
       VALUES ($1, 'EXPIRED0000', 'device', $2, $3, NOW() - INTERVAL '1 hour') RETURNING id`,
      [hashDeviceToken(token), locRow.rows[0]!.id, creatorRow.rows[0]!.id],
    );
    throwawayPairingTokenIds.push(inserted.rows[0]!.id);

    const result = await withRollbackAs(
      { role: 'owner', userId: creatorRow.rows[0]!.id, locationIds: [] },
      (client) => svc.redeem(client, token, 'device'),
    );
    expect(result).toBeUndefined();
  });

  it('a REVOKED token is rejected even though it has not expired and was never used', async () => {
    const locRow = await ownerPool.query<{ id: string }>(`SELECT id FROM locations LIMIT 1`);
    const creatorRow = await ownerPool.query<{ id: string }>(`SELECT id FROM users LIMIT 1`);
    const token = 'idor-sweep-revoked-token';
    const inserted = await ownerPool.query<{ id: string }>(
      `INSERT INTO pairing_tokens (token_hash, display_code, target_type, location_id, created_by, expires_at, revoked_at)
       VALUES ($1, 'REVOKED0000', 'device', $2, $3, NOW() + INTERVAL '1 hour', NOW()) RETURNING id`,
      [hashDeviceToken(token), locRow.rows[0]!.id, creatorRow.rows[0]!.id],
    );
    throwawayPairingTokenIds.push(inserted.rows[0]!.id);

    const result = await withRollbackAs(
      { role: 'owner', userId: creatorRow.rows[0]!.id, locationIds: [] },
      (client) => svc.redeem(client, token, 'device'),
    );
    expect(result).toBeUndefined();
  });
});

describe.skipIf(!hasDb)('B7 — offline-credential replay path (D-17 / SYNC-PROTOCOL §7.4)', () => {
  const repo = new OfflineCredentialsRepository();

  /**
   * WAS a real defect, found by this sweep and FIXED — kept as the regression
   * guard rather than deleted, because the failure mode was so misleading.
   *
   * `findCredential()` used to `SELECT * FROM offline_credentials` directly.
   * That table's RLS is `app_is_self(user_id)` with no central arm, while §7.4
   * re-verification is a cross-user SYSTEM read by construction, so under the
   * sync-ingest pipeline's own system context every REAL credential came back
   * invisible and `reverify()` reported every legitimate offline-authorized
   * approval as "forged or unknown (fraud alert)". Migration 206 shipped
   * `app_offline_credential_for_verification()` for exactly this call site and
   * said so in its header; the migration landed, the repository was never
   * pointed at it.
   *
   * This test now asserts the FIX: both paths see the row, and they agree.
   */
  it(
    'findCredential() reads through the SECURITY DEFINER function, so a real credential is visible ' +
      'under the sync-ingest system context (regression guard for the raw-table read)',
    async () => {
      const cred = await ownerPool.query<{ credential_id: string }>(
        `SELECT credential_id FROM offline_credentials LIMIT 1`,
      );
      expect(
        cred.rows[0],
        'seed must have at least one offline_credentials row for this test',
      ).toBeDefined();
      const credentialId = cred.rows[0]!.credential_id;

      const client = await appPool.connect();
      try {
        await client.query('BEGIN');
        await assertSystemContext(client); // the exact context sync-ingest asserts before calling reverify()

        // What findCredential() ACTUALLY runs (offline-credentials.repository.ts:29-34):
        const viaRepository = await repo.findCredential(client, credentialId);

        // What it WOULD find via the fix migration 206 shipped for this exact purpose:
        const viaFix = await client.query(
          `SELECT * FROM app_offline_credential_for_verification($1)`,
          [credentialId],
        );

        expect(
          viaFix.rowCount,
          'the SECURITY DEFINER function migration 206 shipped must see the row — if this fails the ' +
            'migration is missing, not the repository',
        ).toBe(1);
        expect(
          viaRepository,
          'findCredential() must find a REAL credential under the system context. Undefined here means ' +
            'it has regressed to a raw `offline_credentials` select, and reverify() will flag every ' +
            'legitimate offline-authorized approval as "forged or unknown (fraud alert)"',
        ).toBeDefined();
        expect(viaRepository!.credential_id).toBe(credentialId);
        // The narrowed shape is part of the contract: this path must never be
        // able to hand a caller a PIN verifier (migration 206's security argument).
        expect(viaRepository as Record<string, unknown>).not.toHaveProperty('pin_verifier');
      } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
      }
    },
  );

  it("userHoldsLocation() (§7.4 check 6) correctly distinguishes the holder's real location from an unrelated one", async () => {
    // The pair is chosen so the user provably does NOT hold the second
    // location, rather than assuming "a different location" means "not
    // theirs". It does not: plenty of users here are assigned to every
    // outlet, so an arbitrary `LIMIT 1` row paired with an arbitrary other
    // location was passing on the ACCIDENT of physical row order, and started
    // failing the first time a reseed changed that order. A security test
    // that holds by coincidence is the failure mode this file's own header
    // was written about.
    //
    // NOT EXISTS + deterministic ordering: pick a user with at least one
    // location they are not assigned to, and name that location explicitly.
    const assignment = await ownerPool.query<{
      user_id: string;
      location_id: string;
      other_location_id: string;
    }>(
      `SELECT ul.user_id, ul.location_id, o.id AS other_location_id
         FROM user_locations ul
         JOIN LATERAL (
           SELECT l.id FROM locations l
            WHERE NOT EXISTS (
              SELECT 1 FROM user_locations ul2
               WHERE ul2.user_id = ul.user_id AND ul2.location_id = l.id
            )
            ORDER BY l.id
            LIMIT 1
         ) o ON TRUE
        ORDER BY ul.user_id, ul.location_id
        LIMIT 1`,
    );
    expect(
      assignment.rows[0],
      'no user in the seed is scoped to fewer than every location — this check needs one',
    ).toBeDefined();
    const {
      user_id: userId,
      location_id: heldLocation,
      other_location_id: unheldLocation,
    } = assignment.rows[0]!;

    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      await assertSystemContext(client);
      const holdsOwn = await repo.userHoldsLocation(client, userId, heldLocation);
      const holdsOther = await repo.userHoldsLocation(client, userId, unheldLocation);
      expect(holdsOwn).toBe(true);
      expect(holdsOther).toBe(false);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });
});
