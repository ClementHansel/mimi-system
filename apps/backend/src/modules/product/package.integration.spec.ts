/**
 * Integration tests for `PackageService` and `ProductCategoryService` against
 * the live database (migrations 247/248).
 *
 * WHAT IS ACTUALLY WORTH TESTING HERE. A package's whole reason to exist is that
 * selling one consumes its MEMBERS' ingredients — so the load-bearing assertion
 * is not "lines round-trip", it is that `explodeRecipeUsage` turns a package
 * sale into the stock movements the members would have produced, INCLUDING
 * through a batch recipe (`yield_qty > 1`) where a missing division is invisible
 * in every other fixture in this repo. The rest covers the guards that stop a
 * package from double-counting or recursing, checked at the service layer where
 * they become actionable 400s rather than a raised plpgsql exception.
 *
 * Same discipline as `product.integration.spec.ts`: these services self-commit
 * (one HTTP request, one COMMIT), so `withRollback`'s rollback does not undo
 * them and every fixture is cleaned up explicitly in `afterAll`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';
import { SyncEventsRepository } from '../../kernel/sync/sync-events.repository';
import { ConflictDetectorService } from '../../kernel/sync/conflict-detector.service';
import { SyncConflictsRepository } from '../../kernel/sync/sync-conflicts.repository';
import { PackageService } from './package.service';
import { ProductCategoryService } from './product-category.service';
import { explodeRecipeUsage } from '../pos/recipe-usage.util';
import { getAppPool, getOwnerPool, nextCode, withRollback } from '../location/test-support/live-db';

// `ConflictDetectorService` takes (events, conflicts) — see MA-184.
const packageEvents = new SyncEventsRepository(getAppPool());
const sync = new SyncEmitService(
  packageEvents,
  new ConflictDetectorService(packageEvents, new SyncConflictsRepository()),
);
const packages = new PackageService(sync);
const categories = new ProductCategoryService(sync);

const ACTOR = '00000000-0000-0000-0000-0000000000aa';

interface Ctx {
  categoryId: string;
  unitId: string;
  itemA: string;
  itemB: string;
  /** Plain product, recipe yield 1: 2.000 of itemA per unit sold. */
  memberSimple: string;
  /** Plain product, BATCH recipe yield 10, line qty 5.000 => 0.500 of itemB per unit sold. */
  memberBatch: string;
  packageId: string;
}

const ctx = {} as Ctx;
const createdProductIds: string[] = [];
const createdItemIds: string[] = [];
const createdCategoryIds: string[] = [];

/**
 * Fixtures are CREATED here rather than borrowed from the seed, because the
 * assertions below depend on exact ingredient quantities and the seed's recipe
 * quantities are randomised — an expectation written against those would either
 * have to be derived from the code under test (proving nothing) or would break
 * on every reseed.
 */
beforeAll(async () => {
  const pool = getOwnerPool();

  const unit = await pool.query<{ id: string }>(`SELECT id FROM units ORDER BY code LIMIT 1`);
  ctx.unitId = unit.rows[0]!.id;

  const itemCategory = await pool.query<{ id: string }>(`SELECT id FROM item_categories LIMIT 1`);

  for (const key of ['itemA', 'itemB'] as const) {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO items (sku, name, category_id, base_unit_id, storage_type, avg_cost)
       VALUES ($1,$2,$3,$4,'dry','1000.00') RETURNING id`,
      [nextCode('PKGITM'), `Package test ${key}`, itemCategory.rows[0]!.id, ctx.unitId],
    );
    ctx[key] = res.rows[0]!.id;
    createdItemIds.push(res.rows[0]!.id);
  }

  const cat = await pool.query<{ id: string }>(
    `INSERT INTO product_categories (name, sort_order) VALUES ($1, 500) RETURNING id`,
    [`PkgTest ${nextCode('CAT')}`],
  );
  ctx.categoryId = cat.rows[0]!.id;
  createdCategoryIds.push(cat.rows[0]!.id);

  async function makeProduct(name: string): Promise<string> {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO products (code, name, category_id, price)
       VALUES ($1,$2,$3,'10000.00') RETURNING id`,
      [nextCode('PKG'), name, ctx.categoryId],
    );
    createdProductIds.push(res.rows[0]!.id);
    return res.rows[0]!.id;
  }

  async function giveRecipe(
    productId: string,
    itemId: string,
    lineQty: string,
    yieldQty: string,
  ): Promise<void> {
    const recipe = await pool.query<{ id: string }>(
      `INSERT INTO recipes (product_id, yield_qty) VALUES ($1,$2) RETURNING id`,
      [productId, yieldQty],
    );
    await pool.query(
      `INSERT INTO recipe_lines (recipe_id, item_id, qty, unit_id) VALUES ($1,$2,$3,$4)`,
      [recipe.rows[0]!.id, itemId, lineQty, ctx.unitId],
    );
  }

  ctx.memberSimple = await makeProduct('Package member (simple)');
  await giveRecipe(ctx.memberSimple, ctx.itemA, '2.000', '1.000');

  ctx.memberBatch = await makeProduct('Package member (batch yield 10)');
  await giveRecipe(ctx.memberBatch, ctx.itemB, '5.000', '10.000');

  ctx.packageId = await makeProduct('Package under test');
});

afterAll(async () => {
  const pool = getOwnerPool();
  await pool.query(`DELETE FROM sync_events WHERE entity_id = ANY($1::uuid[])`, [
    [...createdProductIds, ...createdCategoryIds],
  ]);
  // Both directions: `member_product_id` is ON DELETE RESTRICT, so a leftover
  // line would make the product delete below fail and leak fixtures forward.
  await pool.query(
    `DELETE FROM product_package_lines
      WHERE package_product_id = ANY($1::uuid[]) OR member_product_id = ANY($1::uuid[])`,
    [createdProductIds],
  );
  await pool.query(
    `DELETE FROM recipe_lines
      WHERE recipe_id = ANY(SELECT id FROM recipes WHERE product_id = ANY($1::uuid[]))`,
    [createdProductIds],
  );
  await pool.query(`DELETE FROM recipes WHERE product_id = ANY($1::uuid[])`, [createdProductIds]);
  await pool.query(`DELETE FROM products WHERE id = ANY($1::uuid[])`, [createdProductIds]);
  await pool.query(`DELETE FROM items WHERE id = ANY($1::uuid[])`, [createdItemIds]);
  await pool.query(`DELETE FROM product_categories WHERE id = ANY($1::uuid[])`, [
    createdCategoryIds,
  ]);
});

describe('PackageService — membership (migration 248)', () => {
  it('putLines flips a plain product into a package and stores its members', async () => {
    const lines = await withRollback((client) =>
      packages.putLines(
        client,
        ctx.packageId,
        {
          lines: [
            { memberProductId: ctx.memberSimple, qty: '1.000' },
            { memberProductId: ctx.memberBatch, qty: '2.000' },
          ],
        },
        ACTOR,
      ),
    );

    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.memberProductId)).toContain(ctx.memberSimple);

    const kind = await getOwnerPool().query<{ kind: string }>(
      `SELECT kind FROM products WHERE id = $1`,
      [ctx.packageId],
    );
    expect(kind.rows[0]!.kind).toBe('package');
  });

  it('refuses a package as a member — packages do not nest', async () => {
    // `ctx.packageId` is a committed package after the test above, so it stands
    // in for "somebody picked a bundle out of the member dropdown".
    await expect(
      withRollback((client) =>
        packages.putLines(
          client,
          ctx.memberSimple,
          { lines: [{ memberProductId: ctx.packageId, qty: '1.000' }] },
          ACTOR,
        ),
      ),
    ).rejects.toThrow(/do not nest/i);
  });

  it('refuses the same member twice rather than silently summing it', async () => {
    await expect(
      withRollback((client) =>
        packages.putLines(
          client,
          ctx.packageId,
          {
            lines: [
              { memberProductId: ctx.memberSimple, qty: '1.000' },
              { memberProductId: ctx.memberSimple, qty: '2.000' },
            ],
          },
          ACTOR,
        ),
      ),
    ).rejects.toThrow(/duplicate/i);
  });

  it('refuses a package that contains itself', async () => {
    await expect(
      withRollback((client) =>
        packages.putLines(
          client,
          ctx.packageId,
          { lines: [{ memberProductId: ctx.packageId, qty: '1.000' }] },
          ACTOR,
        ),
      ),
    ).rejects.toThrow(/cannot contain itself/i);
  });

  it('names a member that does not exist instead of failing on the foreign key', async () => {
    await expect(
      withRollback((client) =>
        packages.putLines(
          client,
          ctx.packageId,
          { lines: [{ memberProductId: '00000000-0000-0000-0000-0000000000ff', qty: '1.000' }] },
          ACTOR,
        ),
      ),
    ).rejects.toThrow(/not found/i);
  });
});

describe('package stock explosion (FR-POS-06) — the reason packages exist', () => {
  it('a sold package consumes its MEMBERS ingredients, scaled by member qty x qty sold, with batch yield divided', async () => {
    // The package is 1 x memberSimple + 2 x memberBatch (committed above).
    // Selling THREE packages must consume:
    //   itemA: 2.000 per memberSimple unit x (1 x 3) = 6.000
    //   itemB: 5.000 per BATCH OF 10 => 0.500 per unit x (2 x 3) = 3.000
    // Both hand-derived from the fixture, not read back from the code under
    // test. The itemB figure is the one that matters: an explosion that dropped
    // the yield division would post 30.000 instead, and every other fixture in
    // the repo yields 1 so nothing else can tell the two formulas apart.
    const result = await withRollback((client) =>
      explodeRecipeUsage(client, [{ productId: ctx.packageId, qty: '3.000' }]),
    );

    const byItem = new Map(result.usages.map((u) => [u.itemId, u.qty]));
    expect(byItem.get(ctx.itemA)).toBe('6.000');
    expect(byItem.get(ctx.itemB)).toBe('3.000');
  });

  it('aggregates a package and a loose member into ONE movement per item, not two', async () => {
    // A cart holding a bundle AND the same product loose is ordinary. If package
    // expansion did not fold into the same `{productId, qty}` set, this would
    // post itemA twice and the ledger would show two movements for one sale.
    const result = await withRollback((client) =>
      explodeRecipeUsage(client, [
        { productId: ctx.packageId, qty: '1.000' },
        { productId: ctx.memberSimple, qty: '1.000' },
      ]),
    );

    const itemARows = result.usages.filter((u) => u.itemId === ctx.itemA);
    expect(itemARows).toHaveLength(1);
    // 1 package (1 x memberSimple) + 1 loose memberSimple = 2 units x 2.000
    expect(itemARows[0]!.qty).toBe('4.000');
  });

  it('a zero-qty package line consumes nothing instead of throwing', async () => {
    // `convertQty` REJECTS a zero factor with a RangeError rather than returning
    // zero, so reaching it with one would throw out of the whole sale posting
    // instead of skipping one line.
    const result = await withRollback((client) =>
      explodeRecipeUsage(client, [{ productId: ctx.packageId, qty: '0.000' }]),
    );
    expect(result.usages).toEqual([]);
  });

  it('clearLines turns a package back into a plain product with no members', async () => {
    await withRollback((client) => packages.clearLines(client, ctx.packageId, ACTOR));

    const row = await getOwnerPool().query<{ kind: string; members: string }>(
      `SELECT p.kind,
              (SELECT COUNT(*) FROM product_package_lines WHERE package_product_id = p.id) AS members
         FROM products p WHERE p.id = $1`,
      [ctx.packageId],
    );
    expect(row.rows[0]!.kind).toBe('product');
    expect(Number(row.rows[0]!.members)).toBe(0);
  });
});

describe('ProductCategoryService — menu categories (migration 247)', () => {
  it('rejects a duplicate name case-insensitively — "minuman" and "Minuman" are one category', async () => {
    const name = `PkgTest ${nextCode('DUP')}`;
    const created = await withRollback((client) => categories.create(client, { name }, ACTOR));
    createdCategoryIds.push(created.id);

    await expect(
      withRollback((client) => categories.create(client, { name: name.toUpperCase() }, ACTOR)),
    ).rejects.toThrow(/already exists/i);
  });

  it('refuses to retire a category that still has products, and says how many', async () => {
    // `ctx.categoryId` holds the three products created in `beforeAll`.
    await expect(
      withRollback((client) => categories.deactivate(client, ctx.categoryId, ACTOR)),
    ).rejects.toThrow(/still use it/i);
  });

  it('reorder rewrites sort_order as position x 10, leaving gaps to slot into later', async () => {
    const a = await withRollback((client) =>
      categories.create(client, { name: `PkgTest ${nextCode('ORD')}` }, ACTOR),
    );
    const b = await withRollback((client) =>
      categories.create(client, { name: `PkgTest ${nextCode('ORD')}` }, ACTOR),
    );
    createdCategoryIds.push(a.id, b.id);

    await withRollback((client) => categories.reorder(client, [b.id, a.id], ACTOR));

    const rows = await getOwnerPool().query<{ id: string; sort_order: number }>(
      `SELECT id, sort_order FROM product_categories WHERE id = ANY($1::uuid[])`,
      [[a.id, b.id]],
    );
    const orderById = new Map(rows.rows.map((r) => [r.id, r.sort_order]));
    expect(orderById.get(b.id)).toBe(0);
    expect(orderById.get(a.id)).toBe(10);
  });

  it('productCount includes INACTIVE products — a retired seasonal line still needs somewhere to come back to', async () => {
    await getOwnerPool().query(`UPDATE products SET is_active = false WHERE id = $1`, [
      ctx.memberBatch,
    ]);
    try {
      const list = await withRollback((client) => categories.list(client, true));
      const mine = list.find((c) => c.id === ctx.categoryId);
      expect(mine!.productCount).toBe(3);
    } finally {
      await getOwnerPool().query(`UPDATE products SET is_active = true WHERE id = $1`, [
        ctx.memberBatch,
      ]);
    }
  });
});
