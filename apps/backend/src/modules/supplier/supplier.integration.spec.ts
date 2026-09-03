import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RoleKey } from '@mimi/shared';
import { SupplierService } from './supplier.service';
import pg from 'pg';
import type { Pool, PoolClient } from 'pg';

/**
 * M06 SupplierService integration tests — FR-SUP-01..06, D-20 role-scoped visibility.
 *
 * TWO-POOL PATTERN (D-21/D-22):
 * - Owner pool: DATABASE_MIGRATION_URL (superuser, fixture setup/teardown only)
 * - App pool: DATABASE_URL (mimi_app role, code-under-test with real RLS)
 *
 * D-20 BOUNDARY TESTS (the critical point):
 * 1. Supervisor context: must get zero rows from supplier_items/price_history (RLS blocks),
 *    see only outlet_visible in directory, see NO pricing/bank columns.
 * 2. Kepala Gudang context: must see all data, full supplier shape, all pricing.
 *    This proves the boundary holds — not just that RLS blocks everything.
 *
 * CONSTRAINTS:
 * - Tests run on mimi_app pool with SET LOCAL ROLE app_user + session vars
 *   (exactly what RlsContextGuard asserts in production)
 * - Fixture rows created on owner pool, committed durably, cleaned up explicitly
 * - withRollback ensures code-under-test writes don't persist
 * - All queries are real database reads/writes, not mocked
 */

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

let ownerPool: Pool;
let appPool: Pool;
const SYSTEM_USER_ID = '00000000-0000-0000-0000-0000000000aa';

// Fixtures loaded once per suite
let fx: {
  supervisorUserId: string;
  kepalaGudangUserId: string;
  itemId: string;
};

function getOwnerPool(): Pool {
  if (!ownerPool) {
    ownerPool = new pg.Pool({ connectionString: OWNER_URL, max: 5 });
  }
  return ownerPool;
}

function getAppPool(): Pool {
  if (!appPool) {
    appPool = new pg.Pool({ connectionString: APP_URL, max: 5 });
  }
  return appPool;
}

/**
 * Runs fn against a mimi_app connection with real RLS session context.
 * Rolls back code-under-test writes, but fixture rows (inserted via owner pool) persist.
 */
async function withRollback<T>(
  roleKey: RoleKey,
  locationIds: string[] = [],
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getAppPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [SYSTEM_USER_ID]);
    await client.query(`SELECT set_config('app.role', $1, true)`, [roleKey]);
    await client.query(`SELECT set_config('app.tenant_id', app_the_only_tenant()::text, true)`);
    await client.query(`SELECT set_config('app.location_ids', $1, true)`, [locationIds.join(',')]);
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

async function loadFixtures(): Promise<typeof fx> {
  const owner = getOwnerPool();

  const svRes = await owner.query<{ id: string }>(
    `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.key = $1 LIMIT 1`,
    [RoleKey.SUPERVISOR],
  );
  const kgRes = await owner.query<{ id: string }>(
    `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.key = $1 LIMIT 1`,
    [RoleKey.KEPALA_GUDANG],
  );
  const itemRes = await owner.query<{ id: string }>(`SELECT id FROM items LIMIT 1`);

  if (!svRes.rows[0] || !kgRes.rows[0] || !itemRes.rows[0]) {
    throw new Error(
      'Seed data missing: need users with Supervisor/Kepala Gudang roles and at least one item',
    );
  }

  return {
    supervisorUserId: svRes.rows[0].id,
    kepalaGudangUserId: kgRes.rows[0].id,
    itemId: itemRes.rows[0].id,
  };
}

beforeAll(async () => {
  fx = await loadFixtures();
}, 30_000);

afterAll(async () => {
  await ownerPool?.end();
  await appPool?.end();
});

describe('SupplierService — FR-SUP-01..06 with D-20 role-scoped visibility', () => {
  describe('RLS enforcement: production pool connection must have SET LOCAL ROLE', () => {
    it('fails with permission_denied when using fresh mimi_app connection (no RLS context)', async () => {
      const client = await getAppPool().connect();
      try {
        // Fresh mimi_app connection has NOT had SET LOCAL ROLE app_user issued
        // mimi_app has zero table grants, so this must fail with permission denied
        await client.query('SELECT count(*) FROM suppliers');
        throw new Error(
          'Expected "permission denied" but query succeeded — RLS is not enforced correctly',
        );
      } catch (err: any) {
        // Expected: permission denied for table suppliers
        expect(err.message).toMatch(/permission denied|table suppliers/i);
      } finally {
        client.release();
      }
    });
  });

  // BE-TXN-ROLLBACK: `create`/`update`/`deactivate` now wrap their writes in `withWrite`
  // (real `BEGIN...COMMIT`) — see `supplier/db-tx.ts`. That `COMMIT` ends whatever
  // transaction `withRollback` opened here and reverts `SET LOCAL ROLE`/session GUCs with
  // it, so a later call (even a plain read) on the SAME connection now fails `permission
  // denied for table suppliers`. Each mutating call below therefore gets its OWN
  // `withRollback` connection — mirroring `stock-opname`'s regression-suite shape — and,
  // because the write now genuinely commits a real `suppliers` row, every such test cleans
  // it up via the owner pool in a `finally` block.
  describe('FR-SUP-01: Supplier CRUD (create, read, update, delete)', () => {
    it('should create and read back a supplier — write and read on SEPARATE connections', async () => {
      let supplierId: string | undefined;
      try {
        const created = await withRollback(RoleKey.KEPALA_GUDANG, [], (client) =>
          new SupplierService().create(
            client,
            {
              code: `TEST-${randomUUID().slice(0, 8)}`,
              name: 'Test Supplier Corp',
              contactName: 'John Doe',
              phone: '+62-812-3456789',
              email: 'john@test.com',
              address: 'Jl. Test No. 1',
              paymentTermsDays: 30,
              bankName: 'Bank Test',
              bankAccount: '1234567890',
              bankAccountName: 'Supplier Account',
              outletVisible: false,
            },
            SYSTEM_USER_ID,
          ),
        );
        supplierId = created.id;

        expect(created.id).toBeTruthy();
        expect(created.code).toBeTruthy();
        expect(created.name).toBe('Test Supplier Corp');
        expect(created.paymentTermsDays).toBe(30);
        expect(created.bankName).toBe('Bank Test');

        // A GENUINELY separate connection/transaction — never sees `create`'s connection's
        // uncommitted state, only what it actually COMMITted.
        const fetched = await withRollback(RoleKey.KEPALA_GUDANG, [], (client) =>
          new SupplierService().getById(client, created.id),
        );
        expect(fetched.id).toBe(created.id);
        expect(fetched.name).toBe('Test Supplier Corp');
        expect(fetched.paymentTermsDays).toBe(30);
      } finally {
        if (supplierId)
          await getOwnerPool().query(`DELETE FROM suppliers WHERE id = $1`, [supplierId]);
      }
    });

    /**
     * PRICING A SUPPLIER'S ITEM WAS BROKEN OUTRIGHT.
     *
     * `upsertItem`'s `ON CONFLICT ... DO UPDATE SET supplier_sku =
     * COALESCE($3, supplier_sku)` reads an UNQUALIFIED column on the
     * right-hand side. Inside a DO UPDATE clause both the target table and
     * `excluded` are in scope, so Postgres refuses it as ambiguous — and it
     * does so at PARSE time, which means the plain insert failed too, not just
     * a genuine conflict. Every attempt to add or reprice a supplier's item
     * returned 500.
     *
     * Reported from production 2026-09-03: "saat klik tambah tidak terjadi apa
     * apa". The frontend swallowed the 500 into a toast, which is why it read
     * as nothing happening.
     */
    it('adds an item to a supplier with its price (the ambiguous-column 500)', async () => {
      let supplierId: string | undefined;
      try {
        const created = await withRollback(RoleKey.KEPALA_GUDANG, [], (client) =>
          new SupplierService().create(
            client,
            { code: `TEST-${randomUUID().slice(0, 8)}`, name: 'Priced Supplier' },
            SYSTEM_USER_ID,
          ),
        );
        supplierId = created.id;

        const added = await withRollback(RoleKey.KEPALA_GUDANG, [], (client) =>
          new SupplierService().upsertItem(
            client,
            created.id,
            fx.itemId,
            { supplierSku: 'SUP-AIF', currentPrice: '60000.00', leadTimeDays: 0 },
            // A REAL user row: `supplier_price_history.recorded_by` is a FK, and
            // a price change has to name who made it.
            fx.kepalaGudangUserId,
          ),
        );

        expect(added.itemId).toBe(fx.itemId);
        expect(added.currentPrice).toBe('60000.00');
        expect(added.supplierSku).toBe('SUP-AIF');
      } finally {
        if (supplierId) {
          await getOwnerPool().query(`DELETE FROM supplier_price_history WHERE supplier_id = $1`, [
            supplierId,
          ]);
          await getOwnerPool().query(`DELETE FROM supplier_items WHERE supplier_id = $1`, [
            supplierId,
          ]);
          await getOwnerPool().query(`DELETE FROM suppliers WHERE id = $1`, [supplierId]);
        }
      }
    });

    it('reprices an item already on the supplier, keeping the SKU it was given', async () => {
      // The DO UPDATE branch — the one the broken SQL was actually written for.
      // `supplierSku: null` must LEAVE the stored SKU alone (that is what the
      // COALESCE is for), while the price is replaced outright.
      let supplierId: string | undefined;
      try {
        const created = await withRollback(RoleKey.KEPALA_GUDANG, [], (client) =>
          new SupplierService().create(
            client,
            { code: `TEST-${randomUUID().slice(0, 8)}`, name: 'Repriced Supplier' },
            SYSTEM_USER_ID,
          ),
        );
        supplierId = created.id;

        await withRollback(RoleKey.KEPALA_GUDANG, [], (client) =>
          new SupplierService().upsertItem(
            client,
            created.id,
            fx.itemId,
            { supplierSku: 'KEEP-ME', currentPrice: '1000.00', leadTimeDays: 3 },
            fx.kepalaGudangUserId,
          ),
        );

        const repriced = await withRollback(RoleKey.KEPALA_GUDANG, [], (client) =>
          new SupplierService().upsertItem(
            client,
            created.id,
            fx.itemId,
            { supplierSku: null, currentPrice: '1250.00' },
            fx.kepalaGudangUserId,
          ),
        );

        expect(repriced.currentPrice).toBe('1250.00');
        expect(repriced.supplierSku, 'a null SKU wiped the one already stored').toBe('KEEP-ME');
        expect(repriced.leadTimeDays, 'an omitted lead time reset the stored one').toBe(3);
      } finally {
        if (supplierId) {
          await getOwnerPool().query(`DELETE FROM supplier_price_history WHERE supplier_id = $1`, [
            supplierId,
          ]);
          await getOwnerPool().query(`DELETE FROM supplier_items WHERE supplier_id = $1`, [
            supplierId,
          ]);
          await getOwnerPool().query(`DELETE FROM suppliers WHERE id = $1`, [supplierId]);
        }
      }
    });

    it('should update a supplier — create and update on SEPARATE connections', async () => {
      let supplierId: string | undefined;
      try {
        const created = await withRollback(RoleKey.KEPALA_GUDANG, [], (client) =>
          new SupplierService().create(
            client,
            {
              code: `UPD-${randomUUID().slice(0, 8)}`,
              name: 'Original Name',
              contactName: 'Original',
              paymentTermsDays: 15,
            },
            SYSTEM_USER_ID,
          ),
        );
        supplierId = created.id;

        const updated = await withRollback(RoleKey.KEPALA_GUDANG, [], (client) =>
          new SupplierService().update(
            client,
            created.id,
            {
              name: 'Updated Name',
              paymentTermsDays: 45,
            },
            SYSTEM_USER_ID,
          ),
        );

        expect(updated.name).toBe('Updated Name');
        expect(updated.paymentTermsDays).toBe(45);
        expect(updated.id).toBe(created.id);

        // Independent read-back, a THIRD connection: proves `update`'s write genuinely
        // committed, not merely visible within its own now-closed transaction.
        const reread = await withRollback(RoleKey.KEPALA_GUDANG, [], (client) =>
          new SupplierService().getById(client, created.id),
        );
        expect(reread.name).toBe('Updated Name');
        expect(reread.paymentTermsDays).toBe(45);
      } finally {
        if (supplierId)
          await getOwnerPool().query(`DELETE FROM suppliers WHERE id = $1`, [supplierId]);
      }
    });

    it('should soft-delete (deactivate) a supplier — create, deactivate, and verifying read all on SEPARATE connections', async () => {
      let supplierId: string | undefined;
      try {
        const created = await withRollback(RoleKey.KEPALA_GUDANG, [], (client) =>
          new SupplierService().create(
            client,
            {
              code: `DEL-${randomUUID().slice(0, 8)}`,
              name: 'To Deactivate',
            },
            SYSTEM_USER_ID,
          ),
        );
        supplierId = created.id;

        const deactivated = await withRollback(RoleKey.KEPALA_GUDANG, [], (client) =>
          new SupplierService().deactivate(client, created.id, SYSTEM_USER_ID),
        );
        expect(deactivated.deactivated).toBe(true);

        // A later GET (new connection) sees the deactivated status, not the pre-deactivate one —
        // proving `deactivate`'s write persisted past its own request.
        const fetched = await withRollback(RoleKey.KEPALA_GUDANG, [], (client) =>
          new SupplierService().getById(client, created.id),
        );
        expect(fetched.isActive).toBe(false);
      } finally {
        if (supplierId)
          await getOwnerPool().query(`DELETE FROM suppliers WHERE id = $1`, [supplierId]);
      }
    });
  });

  describe('D-20 NEGATIVE TESTS: Supervisor context (outlet role)', () => {
    it('Supervisor: getDirectory returns only outlet_visible=true suppliers', async () => {
      const owner = getOwnerPool();

      const visibleCode = `VIS-${randomUUID().slice(0, 8)}`;
      const hiddenCode = `HID-${randomUUID().slice(0, 8)}`;

      const visRes = await owner.query(
        `INSERT INTO suppliers (code, name, outlet_visible, is_active) VALUES ($1, $2, true, true) RETURNING id`,
        [visibleCode, 'Visible Supplier'],
      );
      const hidRes = await owner.query(
        `INSERT INTO suppliers (code, name, outlet_visible, is_active) VALUES ($1, $2, false, true) RETURNING id`,
        [hiddenCode, 'Hidden Supplier'],
      );

      const visibleId = visRes.rows[0].id;
      const hiddenId = hidRes.rows[0].id;

      try {
        await withRollback(RoleKey.SUPERVISOR, [], async (client) => {
          const service = new SupplierService();

          const dir = await service.getDirectory(client);
          const visibleFound = dir.rows.find((r) => r.id === visibleId);
          const hiddenFound = dir.rows.find((r) => r.id === hiddenId);

          expect(visibleFound).toBeTruthy();
          expect(hiddenFound).toBeUndefined();
          expect(visibleFound!.name).toBe('Visible Supplier');
        });
      } finally {
        await owner.query(`DELETE FROM suppliers WHERE id = ANY($1)`, [[visibleId, hiddenId]]);
      }
    });

    it('Supervisor: getDirectory response has NO pricing/bank fields (column-level security)', async () => {
      const owner = getOwnerPool();

      const code = `COL-${randomUUID().slice(0, 8)}`;
      const res = await owner.query(
        `INSERT INTO suppliers (code, name, outlet_visible, payment_terms_days, bank_name, is_active)
         VALUES ($1, $2, true, 30, 'Bank Test', true) RETURNING id`,
        [code, 'Test Supplier'],
      );
      const supplierId = res.rows[0].id;

      try {
        await withRollback(RoleKey.SUPERVISOR, [], async (client) => {
          const service = new SupplierService();

          const dir = await service.getDirectory(client);
          const entry = dir.rows.find((r) => r.id === supplierId);

          expect(entry).toBeTruthy();
          expect(Object.keys(entry!).sort()).toEqual(
            ['address', 'code', 'contactName', 'id', 'name', 'phone'].sort(),
          );
          expect((entry as any).paymentTermsDays).toBeUndefined();
          expect((entry as any).bankName).toBeUndefined();
          expect((entry as any).bankAccount).toBeUndefined();
          expect((entry as any).bankAccountName).toBeUndefined();
        });
      } finally {
        await owner.query(`DELETE FROM suppliers WHERE id = $1`, [supplierId]);
      }
    });

    it('Supervisor: getItems returns zero rows (RLS blocks pricing)', async () => {
      const owner = getOwnerPool();

      const suppRes = await owner.query(
        `INSERT INTO suppliers (code, name, is_active) VALUES ($1, $2, true) RETURNING id`,
        [`ITEMS-${randomUUID().slice(0, 8)}`, 'Test'],
      );
      const supplierId = suppRes.rows[0].id;

      const itemRes = await owner.query(`SELECT id FROM items LIMIT 1`);
      const itemId = itemRes.rows[0].id;

      await owner.query(
        `INSERT INTO supplier_items (supplier_id, item_id, current_price, lead_time_days) VALUES ($1, $2, '100000.00', 5)`,
        [supplierId, itemId],
      );

      try {
        await withRollback(RoleKey.SUPERVISOR, [], async (client) => {
          const service = new SupplierService();

          const items = await service.getItems(client, supplierId);
          expect(items).toHaveLength(0);
        });
      } finally {
        await owner.query(`DELETE FROM supplier_items WHERE supplier_id = $1`, [supplierId]);
        await owner.query(`DELETE FROM suppliers WHERE id = $1`, [supplierId]);
      }
    });

    it('Supervisor: getPriceHistory returns zero rows (RLS blocks pricing)', async () => {
      const owner = getOwnerPool();

      const suppRes = await owner.query(
        `INSERT INTO suppliers (code, name, is_active) VALUES ($1, $2, true) RETURNING id`,
        [`HIST-${randomUUID().slice(0, 8)}`, 'Test'],
      );
      const supplierId = suppRes.rows[0].id;

      const itemRes = await owner.query(`SELECT id FROM items LIMIT 1`);
      const itemId = itemRes.rows[0].id;

      await owner.query(
        `INSERT INTO supplier_price_history (supplier_id, item_id, price, effective_date, source)
         VALUES ($1, $2, '100000.00', CURRENT_DATE, 'manual')`,
        [supplierId, itemId],
      );

      try {
        await withRollback(RoleKey.SUPERVISOR, [], async (client) => {
          const service = new SupplierService();

          const history = await service.getPriceHistory(client, supplierId);
          expect(history.rows).toHaveLength(0);
        });
      } finally {
        await owner.query(`DELETE FROM supplier_price_history WHERE supplier_id = $1`, [
          supplierId,
        ]);
        await owner.query(`DELETE FROM suppliers WHERE id = $1`, [supplierId]);
      }
    });
  });

  describe('D-20 POSITIVE TESTS: Kepala Gudang context (full access)', () => {
    it('Kepala Gudang: list returns full Supplier shape with pricing/termin/bank', async () => {
      const owner = getOwnerPool();

      const res = await owner.query(
        `INSERT INTO suppliers (code, name, payment_terms_days, bank_name, bank_account, is_active)
         VALUES ($1, $2, 30, 'Bank', '1234567890', true) RETURNING id`,
        [`KG-LIST-${randomUUID().slice(0, 8)}`, 'KG Test'],
      );
      const supplierId = res.rows[0].id;

      try {
        await withRollback(RoleKey.KEPALA_GUDANG, [], async (client) => {
          const service = new SupplierService();

          const list = await service.list(client);
          const found = list.rows.find((s) => s.id === supplierId);

          expect(found).toBeTruthy();
          expect(found!.paymentTermsDays).toBe(30);
          expect(found!.bankName).toBe('Bank');
          expect(found!.bankAccount).toBe('1234567890');
        });
      } finally {
        await owner.query(`DELETE FROM suppliers WHERE id = $1`, [supplierId]);
      }
    });

    it('FR-SUP-03 — Kepala Gudang: getItems returns supplier_items with prices', async () => {
      const owner = getOwnerPool();

      const suppRes = await owner.query(
        `INSERT INTO suppliers (code, name, is_active) VALUES ($1, $2, true) RETURNING id`,
        [`KG-ITEMS-${randomUUID().slice(0, 8)}`, 'KG Test'],
      );
      const supplierId = suppRes.rows[0].id;

      const itemRes = await owner.query(`SELECT id FROM items LIMIT 1`);
      const itemId = itemRes.rows[0].id;

      await owner.query(
        `INSERT INTO supplier_items (supplier_id, item_id, current_price, lead_time_days) VALUES ($1, $2, '125000.00', 7)`,
        [supplierId, itemId],
      );

      try {
        await withRollback(RoleKey.KEPALA_GUDANG, [], async (client) => {
          const service = new SupplierService();

          const items = await service.getItems(client, supplierId);
          expect(items).toHaveLength(1);
          expect(items[0]!.currentPrice).toBe('125000.00');
          expect(items[0]!.leadTimeDays).toBe(7);
        });
      } finally {
        await owner.query(`DELETE FROM supplier_items WHERE supplier_id = $1`, [supplierId]);
        await owner.query(`DELETE FROM suppliers WHERE id = $1`, [supplierId]);
      }
    });

    it('Kepala Gudang: getPriceHistory returns full history', async () => {
      const owner = getOwnerPool();

      const suppRes = await owner.query(
        `INSERT INTO suppliers (code, name, is_active) VALUES ($1, $2, true) RETURNING id`,
        [`KG-HIST-${randomUUID().slice(0, 8)}`, 'KG Test'],
      );
      const supplierId = suppRes.rows[0].id;

      const itemRes = await owner.query(`SELECT id FROM items LIMIT 1`);
      const itemId = itemRes.rows[0].id;

      await owner.query(
        `INSERT INTO supplier_price_history (supplier_id, item_id, price, effective_date, source)
         VALUES ($1, $2, '100000.00', CURRENT_DATE, 'manual')`,
        [supplierId, itemId],
      );

      try {
        await withRollback(RoleKey.KEPALA_GUDANG, [], async (client) => {
          const service = new SupplierService();

          const history = await service.getPriceHistory(client, supplierId);
          expect(history.rows.length).toBeGreaterThanOrEqual(1);
          expect(history.rows[0]!.price).toBe('100000.00');
        });
      } finally {
        await owner.query(`DELETE FROM supplier_price_history WHERE supplier_id = $1`, [
          supplierId,
        ]);
        await owner.query(`DELETE FROM suppliers WHERE id = $1`, [supplierId]);
      }
    });
  });

  describe('DATE-column round-trips and getTransactions (BE-PURCH-FIX)', () => {
    it('getPriceHistory.effectiveDate round-trips the exact YYYY-MM-DD, never shifted by the pg local-Date/WITA gotcha', async () => {
      const owner = getOwnerPool();
      const effectiveDate = '2026-06-30'; // fixed, non-"today" — a day-shift can't hide behind a lucky date.

      const suppRes = await owner.query(
        `INSERT INTO suppliers (code, name, is_active) VALUES ($1, $2, true) RETURNING id`,
        [`DATE-HIST-${randomUUID().slice(0, 8)}`, 'Date Test'],
      );
      const supplierId = suppRes.rows[0].id;
      const itemRes = await owner.query(`SELECT id FROM items LIMIT 1`);
      const itemId = itemRes.rows[0].id;

      await owner.query(
        `INSERT INTO supplier_price_history (supplier_id, item_id, price, effective_date, source)
         VALUES ($1, $2, '77000.00', $3, 'manual')`,
        [supplierId, itemId, effectiveDate],
      );

      try {
        await withRollback(RoleKey.KEPALA_GUDANG, [], async (client) => {
          const service = new SupplierService();

          const history = await service.getPriceHistory(client, supplierId);
          const row = history.rows.find((r) => r.price === '77000.00');
          expect(row).toBeTruthy();
          // Exact string equality — a `stringMatching(/^\d{4}-\d{2}-\d{2}$/)` regex would pass
          // just as happily on a one-day-shifted value, which is exactly why this shipped broken.
          expect(row!.effectiveDate).toBe(effectiveDate);
        });
      } finally {
        await owner.query(`DELETE FROM supplier_price_history WHERE supplier_id = $1`, [
          supplierId,
        ]);
        await owner.query(`DELETE FROM suppliers WHERE id = $1`, [supplierId]);
      }
    });

    it('FR-SUP-02 / FR-SUP-05 — getTransactions runs (previously threw — wrong table/column names) and round-trips orderDate + paymentStatus exactly', async () => {
      const owner = getOwnerPool();
      const orderDate = '2026-06-30';

      const suppRes = await owner.query(
        `INSERT INTO suppliers (code, name, is_active) VALUES ($1, $2, true) RETURNING id`,
        [`DATE-TXN-${randomUUID().slice(0, 8)}`, 'Date Txn Test'],
      );
      const supplierId = suppRes.rows[0].id;
      const locRes = await owner.query(`SELECT id FROM locations LIMIT 1`);
      const locationId = locRes.rows[0].id;
      const itemRes = await owner.query<{ id: string; base_unit_id: string }>(
        `SELECT id, base_unit_id FROM items LIMIT 1`,
      );
      const itemId = itemRes.rows[0]!.id;
      const unitId = itemRes.rows[0]!.base_unit_id;

      const poRes = await owner.query(
        `INSERT INTO purchase_orders (po_number, supplier_id, location_id, status, order_date, created_by)
         VALUES ($1, $2, $3, 'issued', $4, $5) RETURNING id`,
        [
          `PO-TEST-${randomUUID().slice(0, 8)}`,
          supplierId,
          locationId,
          orderDate,
          fx.kepalaGudangUserId,
        ],
      );
      // `payment_verifications`' own RLS policy only allows role IN ('owner','manager','finance') —
      // `kepala_gudang` (this file's usual test role) can't see it, and `purchase_orders`' policy
      // additionally requires `app_has_location`, which an empty `locationIds` scope would fail.
      // 'owner' is central (`app_is_central()`) and on both allow-lists, so the read below uses it.
      const poId = poRes.rows[0].id;
      await owner.query(
        `INSERT INTO po_lines (po_id, item_id, unit_id, qty_ordered, unit_price, line_total) VALUES ($1, $2, $3, 2, '5000.00', '10000.00')`,
        [poId, itemId, unitId],
      );
      const pvRes = await owner.query(
        `INSERT INTO payment_verifications (pv_number, ref_type, ref_id, payee_type, payee_id, amount, status, submitted_by)
         VALUES ($1, 'purchase_order', $2, 'supplier', $3, '10000.00', 'pending', $4) RETURNING id`,
        [`PV-TEST-${randomUUID().slice(0, 8)}`, poId, supplierId, fx.kepalaGudangUserId],
      );
      await owner.query(`UPDATE purchase_orders SET payment_verification_id = $2 WHERE id = $1`, [
        poId,
        pvRes.rows[0].id,
      ]);

      try {
        await withRollback(RoleKey.OWNER, [], async (client) => {
          const service = new SupplierService();

          // Previously: `column pv.po_id does not exist` (wrong join) — this call could never
          // have succeeded before BE-PURCH-FIX's query rewrite.
          const txns = await service.getTransactions(client, supplierId);
          const row = txns.rows.find((r) => r.poId === poId);
          expect(row).toBeTruthy();
          expect(row!.orderDate).toBe(orderDate); // exact round-trip, not merely date-shaped
          // `SUM(qty_ordered * unit_price)` on NUMERIC(14,3) * NUMERIC(18,2) is NOT cast back down to
          // 2dp by this pre-existing query (untouched by BE-PURCH-FIX beyond the join/date fixes) — the
          // combined scale (5dp) is the actual, real response shape, not a `toFixed`-style rounding.
          expect(row!.total).toBe('10000.00000');
          expect(row!.paymentStatus).toBe('pending');
          expect(row!.status).toBe('issued');
        });
      } finally {
        // `fk_po_pv` (migration 094) requires clearing `purchase_orders.payment_verification_id`
        // BEFORE the referenced `payment_verifications` row can be deleted.
        await owner.query(
          `UPDATE purchase_orders SET payment_verification_id = NULL WHERE id = $1`,
          [poId],
        );
        await owner.query(`DELETE FROM payment_verifications WHERE id = $1`, [pvRes.rows[0].id]);
        await owner.query(`DELETE FROM po_lines WHERE po_id = $1`, [poId]);
        await owner.query(`DELETE FROM purchase_orders WHERE id = $1`, [poId]);
        await owner.query(`DELETE FROM suppliers WHERE id = $1`, [supplierId]);
      }
    });
  });

  describe('Money type precision (CONTRACTS.md §0)', () => {
    it('currentPrice returned as decimal string, not JS number', async () => {
      const owner = getOwnerPool();

      const suppRes = await owner.query(
        `INSERT INTO suppliers (code, name, is_active) VALUES ($1, $2, true) RETURNING id`,
        [`MONEY-${randomUUID().slice(0, 8)}`, 'Money Test'],
      );
      const supplierId = suppRes.rows[0].id;

      const itemRes = await owner.query(`SELECT id FROM items LIMIT 1`);
      const itemId = itemRes.rows[0].id;

      await owner.query(
        `INSERT INTO supplier_items (supplier_id, item_id, current_price, lead_time_days) VALUES ($1, $2, '250500.75', 10)`,
        [supplierId, itemId],
      );

      try {
        await withRollback(RoleKey.KEPALA_GUDANG, [], async (client) => {
          const service = new SupplierService();

          const items = await service.getItems(client, supplierId);
          expect(items[0]!.currentPrice).toBe('250500.75');
          expect(typeof items[0]!.currentPrice).toBe('string');
          expect(items[0]!.currentPrice).not.toBe(250500.75);
        });
      } finally {
        await owner.query(`DELETE FROM supplier_items WHERE supplier_id = $1`, [supplierId]);
        await owner.query(`DELETE FROM suppliers WHERE id = $1`, [supplierId]);
      }
    });
  });
});
