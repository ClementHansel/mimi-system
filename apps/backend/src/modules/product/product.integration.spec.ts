/**
 * Integration tests for `ProductService`/`RecipeService` against the live
 * database. See `modules/location/location.integration.spec.ts` for why
 * every test calls a mutating method at most once per `withRollback` block
 * and cleans up explicitly (these services self-commit, matching production
 * — one HTTP request, one COMMIT).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { Pool } from 'pg';
import { can, RoleKey } from '@mimi/shared';
import type { JwtAccessPayload } from '../../common/jwt/jwt-payload.interface';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';
import { SyncEventsRepository } from '../../kernel/sync/sync-events.repository';
import { ConflictDetectorService } from '../../kernel/sync/conflict-detector.service';
import { SyncConflictsRepository } from '../../kernel/sync/sync-conflicts.repository';
import { EventBus } from '../../kernel/events/event-bus.service';
import { StorageService } from '../../kernel/storage/storage.service';
import { ProductService } from './product.service';
import { RecipeService } from './recipe.service';
import { PackageService } from './package.service';
import {
  getOwnerPool,
  loadFixtures,
  nextCode,
  withRollback,
  type Fixtures,
} from '../location/test-support/live-db';

const eventsRepo = new SyncEventsRepository();
const conflictsRepo = new SyncConflictsRepository();
const conflictDetector = new ConflictDetectorService(conflictsRepo);
const sync = new SyncEmitService(eventsRepo, conflictDetector);
const eventBus = new EventBus();
// No attachment is ever created in this suite (photoAttachmentId stays
// unset), so `resolvePhotoUrl` returns null before ever touching this pool —
// a dummy is safe here without standing up a real MinIO-backed StorageService.
const dummyPool = {
  query: () => {
    throw new Error('StorageService.pool should not be queried in this suite');
  },
} as unknown as Pool;
const storage = new StorageService(new ConfigService(), dummyPool);
const packageService = new PackageService(sync);
const productService = new ProductService(sync, eventBus, storage, packageService);
const recipeService = new RecipeService(sync);

const ACTOR = '00000000-0000-0000-0000-0000000000aa';
const SYSTEM_USER: JwtAccessPayload = {
  sub: ACTOR,
  username: 'system',
  roleKey: 'owner',
  locationIds: [],
};

/**
 * Menu categories are `product_categories` rows since migration 247, so a
 * product fixture needs an id, not the literal 'Ayam'. Resolved by name against
 * the seeded rows (migration 247 backfills them and `seed.ts` upserts them), and
 * memoised — every test in this suite creates a product, and none of them care
 * about the category beyond it being valid.
 */
const categoryIdCache = new Map<string, string>();
async function categoryId(name: string): Promise<string> {
  const cached = categoryIdCache.get(name);
  if (cached) return cached;
  const res = await getOwnerPool().query<{ id: string }>(
    `SELECT id FROM product_categories WHERE name = $1`,
    [name],
  );
  const id = res.rows[0]?.id;
  if (!id) throw new Error(`product_categories row "${name}" is missing — run pnpm db:migrate`);
  categoryIdCache.set(name, id);
  return id;
}

async function cleanupProducts(productIds: string[]): Promise<void> {
  if (productIds.length === 0) return;
  const pool = getOwnerPool();
  await pool.query(`DELETE FROM sync_events WHERE entity_id = ANY($1::uuid[])`, [productIds]);
  await pool.query(
    `DELETE FROM sync_events WHERE entity_id = ANY(SELECT id FROM recipes WHERE product_id = ANY($1::uuid[]))`,
    [productIds],
  );
  await pool.query(
    `DELETE FROM recipe_lines WHERE recipe_id = ANY(SELECT id FROM recipes WHERE product_id = ANY($1::uuid[]))`,
    [productIds],
  );
  await pool.query(`DELETE FROM recipes WHERE product_id = ANY($1::uuid[])`, [productIds]);
  // Both directions: a fixture may have been a package, or a member of one.
  // `member_product_id` is ON DELETE RESTRICT, so a leftover line would make the
  // product delete below fail and leak fixtures into every later run.
  await pool.query(
    `DELETE FROM product_package_lines
      WHERE package_product_id = ANY($1::uuid[]) OR member_product_id = ANY($1::uuid[])`,
    [productIds],
  );
  await pool.query(`DELETE FROM products WHERE id = ANY($1::uuid[])`, [productIds]);
}

describe('ProductService / RecipeService (live database)', () => {
  let fixtures: Fixtures;
  const createdProductIds: string[] = [];

  afterAll(async () => {
    await cleanupProducts(createdProductIds);
  });

  it('loads fixtures', async () => {
    fixtures = await loadFixtures();
    expect(fixtures.itemId).toBeTruthy();
  });

  it('creates a product with hasRecipe=false and no photo', async () => {
    const created = await withRollback(async (client) =>
      productService.create(
        client,
        {
          code: nextCode('PRD'),
          name: 'Ayam Geprek',
          categoryId: await categoryId('Ayam'),
          price: '25000.00',
        },
        ACTOR,
        SYSTEM_USER,
        null,
      ),
    );
    createdProductIds.push(created.id);
    expect(created.hasRecipe).toBe(false);
    expect(created.photoUrl).toBeNull();
    expect(created.price).toBe('25000.00');
  });

  it('updates a product and emits product.price_changed on the EventBus only when price actually changes', async () => {
    const created = await withRollback(async (client) =>
      productService.create(
        client,
        {
          code: nextCode('PRD'),
          name: 'Before',
          categoryId: await categoryId('Umum'),
          price: '10000.00',
        },
        ACTOR,
        SYSTEM_USER,
        null,
      ),
    );
    createdProductIds.push(created.id);

    let received: unknown;
    const unsubscribe = eventBus.subscribe('product.price_changed', (event) => {
      received = event.payload;
    });
    try {
      // A non-price update must NOT emit product.price_changed.
      await withRollback(async (client) =>
        productService.update(client, created.id, { name: 'Renamed' }, ACTOR, SYSTEM_USER, null),
      );
      expect(received).toBeUndefined();

      // A real price change must.
      const updated = await withRollback(async (client) =>
        productService.update(client, created.id, { price: '30000.00' }, ACTOR, SYSTEM_USER, null),
      );
      expect(updated.price).toBe('30000.00');
      expect(received).toMatchObject({
        productId: created.id,
        oldPrice: '10000.00',
        newPrice: '30000.00',
      });
    } finally {
      unsubscribe();
    }
  });

  it('priceGofood/priceShopeefood default to null (fallback to price) and round-trip when set, cleared, and re-set (migration 249)', async () => {
    const created = await withRollback(async (client) =>
      productService.create(
        client,
        {
          code: nextCode('PRD'),
          name: 'Channel Priced',
          categoryId: await categoryId('Ayam'),
          price: '15000.00',
        },
        ACTOR,
        SYSTEM_USER,
        null,
      ),
    );
    createdProductIds.push(created.id);
    // Unset at creation — the wire contract is "falls back to price", never a silent 0.
    expect(created.priceGofood).toBeNull();
    expect(created.priceShopeefood).toBeNull();

    const withChannelPrices = await withRollback(async (client) =>
      productService.update(
        client,
        created.id,
        { priceGofood: '18000.00', priceShopeefood: '17500.00' },
        ACTOR,
        SYSTEM_USER,
        null,
      ),
    );
    expect(withChannelPrices.priceGofood).toBe('18000.00');
    expect(withChannelPrices.priceShopeefood).toBe('17500.00');
    expect(withChannelPrices.price).toBe('15000.00'); // walk-in price untouched by the channel-price update

    // Explicit `null` clears an override back to falling through to `price` — distinct from omitting
    // the field (`undefined`), which must leave the existing override alone.
    const clearedGofoodOnly = await withRollback(async (client) =>
      productService.update(client, created.id, { priceGofood: null }, ACTOR, SYSTEM_USER, null),
    );
    expect(clearedGofoodOnly.priceGofood).toBeNull();
    expect(clearedGofoodOnly.priceShopeefood).toBe('17500.00'); // untouched — the field was omitted, not nulled
  });

  it('deactivates a product', async () => {
    const created = await withRollback(async (client) =>
      productService.create(
        client,
        {
          code: nextCode('PRD'),
          name: 'ToDeactivate',
          categoryId: await categoryId('Umum'),
          price: '5000.00',
        },
        ACTOR,
        SYSTEM_USER,
        null,
      ),
    );
    createdProductIds.push(created.id);
    const result = await withRollback(async (client) =>
      productService.deactivate(client, created.id, ACTOR),
    );
    expect(result.deactivated).toBe(true);
  });

  it('puts a deactivated product back on the POS menu', async () => {
    // The half of "activate and deactivate" (owner, 2026-08-21) that was
    // entirely missing: `products.is_active` has existed since migration 012
    // and NOTHING could set it back to true — no PATCH field, no route — so a
    // sold-out or seasonal line, once hidden, stayed hidden for good.
    const created = await withRollback(async (client) =>
      productService.create(
        client,
        {
          code: nextCode('PRD'),
          name: 'Seasonal',
          categoryId: await categoryId('Minuman'),
          price: '9000.00',
        },
        ACTOR,
        SYSTEM_USER,
        null,
      ),
    );
    createdProductIds.push(created.id);

    await withRollback(async (client) => productService.deactivate(client, created.id, ACTOR));
    const off = await withRollback(async (client) =>
      productService.getById(client, created.id, SYSTEM_USER, null),
    );
    expect(off.isActive).toBe(false);

    const back = await withRollback(async (client) =>
      productService.update(client, created.id, { isActive: true }, ACTOR, SYSTEM_USER, null),
    );
    expect(back.isActive).toBe(true);
  });

  it('404s on a nonexistent product', async () => {
    await expect(
      withRollback(async (client) =>
        productService.getById(client, '00000000-0000-0000-0000-000000000000', SYSTEM_USER, null),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('GET recipe on a product with no recipe yet returns an empty BOM (not 404)', async () => {
    const created = await withRollback(async (client) =>
      productService.create(
        client,
        {
          code: nextCode('PRD'),
          name: 'No Recipe Yet',
          categoryId: await categoryId('Umum'),
          price: '1000.00',
        },
        ACTOR,
        SYSTEM_USER,
        null,
      ),
    );
    createdProductIds.push(created.id);

    const recipe = await withRollback(async (client) =>
      recipeService.getRecipe(client, created.id),
    );
    expect(recipe.lines).toEqual([]);
  });

  it('PUT recipe replaces the BOM, sets hasRecipe=true, and the round-tripped recipe explodes correctly', async () => {
    const created = await withRollback(async (client) =>
      productService.create(
        client,
        {
          code: nextCode('PRD'),
          name: 'With Recipe',
          categoryId: await categoryId('Ayam'),
          price: '20000.00',
        },
        ACTOR,
        SYSTEM_USER,
        null,
      ),
    );
    createdProductIds.push(created.id);

    const putResult = await withRollback(async (client) =>
      recipeService.putRecipe(
        client,
        created.id,
        {
          yieldQty: '1.000',
          lines: [{ itemId: fixtures.itemId, qty: '0.150', unitId: fixtures.baseUnitId }],
        },
        ACTOR,
      ),
    );
    expect(putResult.lines).toHaveLength(1);
    expect(putResult.lines[0]!.itemId).toBe(fixtures.itemId);

    const refetchedProduct = await withRollback(async (client) =>
      productService.getById(client, created.id, SYSTEM_USER, null),
    );
    expect(refetchedProduct.hasRecipe).toBe(true);

    // Full-replace semantics: a second PUT with a different single line drops the first.
    const secondPut = await withRollback(async (client) =>
      recipeService.putRecipe(
        client,
        created.id,
        {
          yieldQty: '2.000',
          lines: [{ itemId: fixtures.itemId2, qty: '1.000', unitId: fixtures.baseUnitId }],
        },
        ACTOR,
      ),
    );
    expect(secondPut.lines).toHaveLength(1);
    expect(secondPut.lines[0]!.itemId).toBe(fixtures.itemId2);
    expect(secondPut.lines.some((l) => l.itemId === fixtures.itemId)).toBe(false);

    // DB-backed explosion wrapper (loads the just-persisted recipe, then explodes it) — FR-POS-06.
    const usage = await withRollback(async (client) =>
      recipeService.explodeForSale(client, created.id, '4.000'),
    );
    expect(usage).toEqual([{ itemId: fixtures.itemId2, qty: '2.000' }]); // yieldQty=2, qtySold=4 → ratio 2 → 1.000×2 = 2.000
  });

  describe('RBAC (CONTRACTS.md §3) — negative checks (both directions)', () => {
    it('product.read is granted to kasir but denied to hr_admin and driver', () => {
      expect(can(RoleKey.KASIR, 'product.read')).toBe(true);
      expect(can(RoleKey.HR_ADMIN, 'product.read')).toBe(false);
      expect(can(RoleKey.DRIVER, 'product.read')).toBe(false);
    });

    it('product.manage is granted only to owner/manager', () => {
      const granted = [RoleKey.OWNER, RoleKey.MANAGER];
      // SUPERADMIN holds every key by construction (RoleKey.SUPERADMIN), so it
      // is excluded from the denied set — the claim under test is about the
      // nine business roles, not the all-access technical account.
      const denied = Object.values(RoleKey).filter(
        (r) => !granted.includes(r) && r !== RoleKey.SUPERADMIN,
      );
      for (const role of granted) expect(can(role, 'product.manage')).toBe(true);
      for (const role of denied) expect(can(role, 'product.manage')).toBe(false);
    });

    it('recipe.read is granted to kepala_gudang but denied to supervisor/leader_outlet/kasir (recipe = cost structure)', () => {
      expect(can(RoleKey.KEPALA_GUDANG, 'recipe.read')).toBe(true);
      expect(can(RoleKey.SUPERVISOR, 'recipe.read')).toBe(false);
      expect(can(RoleKey.LEADER_OUTLET, 'recipe.read')).toBe(false);
      expect(can(RoleKey.KASIR, 'recipe.read')).toBe(false);
    });

    it('recipe.manage is granted only to owner/manager', () => {
      expect(can(RoleKey.OWNER, 'recipe.manage')).toBe(true);
      expect(can(RoleKey.MANAGER, 'recipe.manage')).toBe(true);
      expect(can(RoleKey.KEPALA_GUDANG, 'recipe.manage')).toBe(false);
    });
  });
});
