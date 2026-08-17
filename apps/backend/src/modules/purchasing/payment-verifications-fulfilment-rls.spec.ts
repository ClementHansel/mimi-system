/**
 * Regression coverage for ticket DB-PV-RLS, against the LIVE database, over
 * a REAL non-superuser session — same two-pool shape as
 * `purchasing.integration.spec.ts` (`mimi_app` login + `SET LOCAL ROLE
 * app_user`, per `test-support/live-db.ts`'s `withRollbackAs`). An
 * owner-role-only harness would prove nothing here: the bug this migration
 * fixes is specifically about what a SCOPED role (`kepala_gudang`) can and
 * cannot see, and `owner` bypasses none of the RLS predicates under test.
 *
 * THE BUG (migration 095's `payment_verifications_role`, `FOR ALL USING
 * (role IN owner,manager,finance)`, no SELECT carve-out): `kepala_gudang`
 * performs PO receiving, which creates a `payment_verifications` row via an
 * escalated system-context INSERT — then that same role's own session could
 * never SELECT the row back. `PurchaseOrderRepository`'s `LEFT JOIN
 * payment_verifications` (CONTRACTS.md §4.11 `paymentStatus`) silently read
 * `null` for the user who just caused the row to exist. See migration
 * `220_dbpvrls_payment_verifications_fulfilment_select.sql` for the fix and
 * full reasoning.
 *
 * THE FIX under test here is a narrow, command-scoped `FOR SELECT` policy —
 * these tests exist to prove three things a code-read of the policy text
 * cannot: (1) the intended role can now read exactly the rows it should,
 * (2) a role that must NOT gain access has an unchanged (zero) visible row
 * count, and (3) write access for the newly-readable role is still fully
 * blocked — the exact "don't just widen FOR ALL" failure mode a careless
 * fix could have reintroduced.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { RoleKey } from '@mimi/shared';
import { loadFixtures, withRollbackAs, closePool, type Fixtures } from './test-support/live-db';

const ownerPool = new Pool({
  connectionString:
    process.env.DATABASE_MIGRATION_URL ??
    `postgres://${process.env.POSTGRES_USER ?? 'mimi'}:${process.env.POSTGRES_PASSWORD ?? 'mimi_secret'}@localhost:${process.env.POSTGRES_PORT ?? '55433'}/${process.env.POSTGRES_DB ?? 'mimi'}`,
});

describe('payment_verifications RLS — kepala_gudang fulfilment SELECT carve-out (DB-PV-RLS, migration 220)', () => {
  let fx: Fixtures;
  let poId: string;
  let poLinkedPvId: string;
  let pettyCashLinkedPvId: string;

  beforeAll(async () => {
    fx = await loadFixtures();

    // A real purchase_order at the warehouse (kepala_gudang's own location), plus its PO-linked
    // payment_verifications row — the exact shape `PurchaseOrderService.receive` ->
    // `createSystemVerification` produces (same columns, same values: `location_id` mirrors the
    // referenced PO's own `location_id`).
    const po = await ownerPool.query<{ id: string }>(
      `INSERT INTO purchase_orders (po_number, supplier_id, location_id, status, order_date, created_by)
       VALUES ('PO/DBPVRLS/TEST/0001', $1, $2, 'received', CURRENT_DATE, $3) RETURNING id`,
      [fx.supplierId, fx.warehouseId, fx.usersByRole[RoleKey.OWNER]],
    );
    poId = po.rows[0]!.id;

    const pv = await ownerPool.query<{ id: string }>(
      `INSERT INTO payment_verifications (pv_number, ref_type, ref_id, payee_type, payee_id, amount, status, submitted_by, location_id, notes)
       VALUES ('PV/DBPVRLS/TEST/0001', 'purchase_order', $1, 'supplier', $2, 1000000, 'pending', $3, $4, 'DB-PV-RLS regression fixture')
       RETURNING id`,
      [poId, fx.supplierId, fx.kepalaGudangUserId, fx.warehouseId],
    );
    poLinkedPvId = pv.rows[0]!.id;

    // A SIBLING payment_verifications row at the SAME warehouse location, but ref_type='petty_cash' —
    // proves the fix is scoped to purchase_order rows (not "any row at a location kepala_gudang
    // holds"), which is the whole reason 220 joins through purchase_orders rather than trusting
    // payment_verifications.location_id directly.
    const pettyCashPv = await ownerPool.query<{ id: string }>(
      `INSERT INTO payment_verifications (pv_number, ref_type, ref_id, payee_type, payee_id, amount, status, submitted_by, location_id, notes)
       VALUES ('PV/DBPVRLS/TEST/0002', 'petty_cash', gen_random_uuid(), 'employee', $1, 50000, 'pending', $1, $2, 'DB-PV-RLS regression fixture - must stay invisible to KGD')
       RETURNING id`,
      [fx.kepalaGudangUserId, fx.warehouseId],
    );
    pettyCashLinkedPvId = pettyCashPv.rows[0]!.id;
  });

  afterAll(async () => {
    await ownerPool.query(`DELETE FROM payment_verifications WHERE id IN ($1, $2)`, [poLinkedPvId, pettyCashLinkedPvId]);
    await ownerPool.query(`DELETE FROM purchase_orders WHERE id = $1`, [poId]);
    await ownerPool.end();
    await closePool();
  });

  it('kepala_gudang can now SELECT the payment_verifications row attached to a PO within its own location scope', async () => {
    const status = await withRollbackAs({ role: 'kepala_gudang', userId: fx.kepalaGudangUserId, locationIds: [fx.warehouseId] }, (client) =>
      client.query<{ status: string }>(`SELECT status FROM payment_verifications WHERE id = $1`, [poLinkedPvId]).then((r) => r.rows[0]?.status ?? null),
    );
    // Before migration 220 this was `null` (0 rows visible) — this is the documented reported bug,
    // reproduced live against a dropped copy of the policy before writing this test.
    expect(status).toBe('pending');
  });

  it('reproduces the exact bug shape: the LEFT JOIN paymentStatus pattern from PurchaseOrderRepository no longer reads null under kepala_gudang', async () => {
    const row = await withRollbackAs({ role: 'kepala_gudang', userId: fx.kepalaGudangUserId, locationIds: [fx.warehouseId] }, (client) =>
      client
        .query<{ payment_status: string | null }>(
          `SELECT pv.status AS payment_status FROM purchase_orders po LEFT JOIN payment_verifications pv ON pv.id = $2 WHERE po.id = $1`,
          [poId, poLinkedPvId],
        )
        .then((r) => r.rows[0]?.payment_status ?? null),
    );
    expect(row).toBe('pending');
  });

  it('does NOT widen visibility to non-purchase_order payment_verifications rows at the same location (ref_type scoping)', async () => {
    const status = await withRollbackAs({ role: 'kepala_gudang', userId: fx.kepalaGudangUserId, locationIds: [fx.warehouseId] }, (client) =>
      client.query<{ status: string }>(`SELECT status FROM payment_verifications WHERE id = $1`, [pettyCashLinkedPvId]).then((r) => r.rows[0]?.status ?? null),
    );
    expect(status).toBeNull();
  });

  it('OVER-WIDENING GATE: kasir (never in scope for this table, before or after) still sees 0 payment_verifications rows total', async () => {
    const kasirUserId = fx.usersByRole[RoleKey.KASIR];
    const count = await withRollbackAs({ role: 'kasir', userId: kasirUserId, locationIds: [] }, (client) =>
      client.query<{ n: string }>(`SELECT count(*)::text AS n FROM payment_verifications`).then((r) => Number(r.rows[0]!.n)),
    );
    expect(count).toBe(0);
  });

  it('OVER-WIDENING GATE: kepala_gudang still CANNOT INSERT a payment_verifications row directly (write path untouched)', async () => {
    await expect(
      withRollbackAs({ role: 'kepala_gudang', userId: fx.kepalaGudangUserId, locationIds: [fx.warehouseId] }, (client) =>
        client.query(
          `INSERT INTO payment_verifications (pv_number, ref_type, ref_id, payee_type, payee_id, amount, status, submitted_by, location_id)
           VALUES ('PV/DBPVRLS/HACK', 'purchase_order', $1, 'supplier', $2, 999, 'pending', $3, $4)`,
          [poId, fx.supplierId, fx.kepalaGudangUserId, fx.warehouseId],
        ),
      ),
    ).rejects.toThrow(/row-level security policy/i);
  });

  it('OVER-WIDENING GATE: kepala_gudang still CANNOT UPDATE a payment_verifications row it can now see (rowCount 0, no actual change)', async () => {
    const result = await withRollbackAs({ role: 'kepala_gudang', userId: fx.kepalaGudangUserId, locationIds: [fx.warehouseId] }, (client) =>
      client.query(`UPDATE payment_verifications SET status = 'verified' WHERE id = $1`, [poLinkedPvId]),
    );
    // The new policy is `FOR SELECT` only, so it contributes nothing to UPDATE's own row-visibility
    // check — only 095's untouched `FOR ALL` policy governs UPDATE, which still excludes
    // kepala_gudang. RLS filters this out silently (0 rows matched), rather than raising — asserted
    // explicitly so a future change that turns this into a thrown error doesn't look like an
    // improvement when it's actually a different-shaped regression.
    expect(result.rowCount).toBe(0);

    const stillPending = await ownerPool.query<{ status: string }>(`SELECT status FROM payment_verifications WHERE id = $1`, [poLinkedPvId]);
    expect(stillPending.rows[0]!.status).toBe('pending');
  });

  it('OVER-WIDENING GATE: kepala_gudang still CANNOT DELETE a payment_verifications row it can now see (rowCount 0)', async () => {
    const result = await withRollbackAs({ role: 'kepala_gudang', userId: fx.kepalaGudangUserId, locationIds: [fx.warehouseId] }, (client) =>
      client.query(`DELETE FROM payment_verifications WHERE id = $1`, [poLinkedPvId]),
    );
    expect(result.rowCount).toBe(0);
  });

  it('owner (already in scope pre-fix) still sees the row unchanged', async () => {
    const status = await withRollbackAs({ role: 'owner', userId: fx.usersByRole[RoleKey.OWNER], locationIds: [] }, (client) =>
      client.query<{ status: string }>(`SELECT status FROM payment_verifications WHERE id = $1`, [poLinkedPvId]).then((r) => r.rows[0]?.status ?? null),
    );
    expect(status).toBe('pending');
  });
});
